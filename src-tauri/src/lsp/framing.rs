//! JSON-RPC's wire format: an HTTP-ish header, then a body.
//!
//! ```text
//! Content-Length: 143\r\n
//! \r\n
//! {"jsonrpc":"2.0", ... }
//! ```
//!
//! Three things go wrong here and all three are tested below.
//!
//! **The header is ASCII, the body is UTF-8, and `Content-Length` counts
//! *bytes*.** Reading "143 characters" off a stream containing a single
//! non-ASCII identifier desynchronises the parser permanently, and the symptom
//! is a server that appears to hang halfway through a session. Everything here
//! works in bytes and only converts to a `String` once a whole body is in hand.
//!
//! **A read is not a message.** A pipe hands over whatever happened to arrive:
//! half a header, three messages at once, a body split down the middle of a
//! multi-byte character. The decoder buffers and yields only complete messages.
//!
//! **`\r\n` is mandatory.** Some servers are lax about what they accept while
//! being strict about what they send, so [`encode`] writes exactly what the
//! specification says.

/// A header block larger than this is a desynchronised stream, not a header.
///
/// Without a ceiling, a decoder that has lost its place buffers the entire
/// output of the server forever while waiting for a `\r\n\r\n` that will never
/// come — the failure looks like a memory leak rather than a protocol error.
const MAX_HEADER_BYTES: usize = 8 * 1024;

/// A body larger than this is refused rather than allocated.
///
/// Real messages are kilobytes; the largest legitimate ones are a big
/// `publishDiagnostics` or a `completion` list, and those are single-digit
/// megabytes at the very worst. A `Content-Length` above this is a corrupt
/// header being believed.
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

/// Frames one message for the server's stdin.
pub fn encode(body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 32);
    // `body.len()` is a byte count in Rust, which is exactly what the header
    // must carry. This is the one place that would be silently wrong in a
    // language where it isn't.
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

/// Accumulates bytes from the server's stdout and hands back whole messages.
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds whatever a read produced.
    pub fn feed(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    /// The next complete message, or `None` if one hasn't fully arrived.
    ///
    /// `Err` means the stream is no longer parseable — a header we can't make
    /// sense of, or one that never ends. The caller's only sane response is to
    /// stop reading that server, because every byte after a desync is garbage.
    pub fn next_message(&mut self) -> Result<Option<String>, String> {
        let Some(header_end) = find_header_end(&self.buffer) else {
            if self.buffer.len() > MAX_HEADER_BYTES {
                return Err(format!(
                    "no header terminator in {} bytes; the stream is out of sync",
                    self.buffer.len()
                ));
            }
            return Ok(None);
        };

        let length = content_length(&self.buffer[..header_end])?;
        if length > MAX_BODY_BYTES {
            return Err(format!("Content-Length of {length} is implausible"));
        }

        // `header_end` is the index of the `\r\n\r\n`, so the body starts four
        // bytes later.
        let body_start = header_end + 4;
        let body_end = body_start + length;
        if self.buffer.len() < body_end {
            // Reserve up front rather than growing by whatever each read
            // happens to bring, which on a large completion list is dozens of
            // reallocations of an ever-larger buffer.
            self.buffer.reserve(body_end - self.buffer.len());
            return Ok(None);
        }

        // Lossy rather than strict: a server that emits invalid UTF-8 has a bug,
        // but killing the session over one bad byte in one message is a worse
        // answer than rendering a replacement character in a tooltip.
        let body = String::from_utf8_lossy(&self.buffer[body_start..body_end]).into_owned();
        self.buffer.drain(..body_end);
        Ok(Some(body))
    }
}

/// The index of the `\r\n\r\n` that ends the header block.
fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Reads `Content-Length` out of a header block.
///
/// Other headers are skipped rather than rejected: `Content-Type` is legal and
/// some servers send it, and the specification allows more.
fn content_length(header: &[u8]) -> Result<usize, String> {
    for line in header.split(|&byte| byte == b'\n') {
        let line = String::from_utf8_lossy(line);
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        // Header names are case-insensitive, and at least one server in the
        // wild sends `content-length`.
        if !name.trim().eq_ignore_ascii_case("Content-Length") {
            continue;
        }
        return value
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("unparseable Content-Length: {:?}", value.trim()));
    }
    Err("header block with no Content-Length".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(decoder: &mut Decoder) -> Vec<String> {
        let mut found = Vec::new();
        while let Some(message) = decoder.next_message().expect("decodes") {
            found.push(message);
        }
        found
    }

    #[test]
    fn round_trips_one_message() {
        let mut decoder = Decoder::new();
        decoder.feed(&encode(r#"{"jsonrpc":"2.0"}"#));
        assert_eq!(drain(&mut decoder), vec![r#"{"jsonrpc":"2.0"}"#]);
    }

    /// The header counts bytes, not characters. `é` is two bytes and `👋` is
    /// four, so a decoder that counted characters would stop short here and
    /// treat the tail of this message as the head of the next one — forever.
    #[test]
    fn counts_bytes_not_characters() {
        let body = r#"{"text":"é 👋 ok"}"#;
        assert!(body.len() > body.chars().count(), "the test body must be multi-byte");

        let framed = encode(body);
        assert!(framed.starts_with(format!("Content-Length: {}", body.len()).as_bytes()));

        let mut decoder = Decoder::new();
        decoder.feed(&framed);
        assert_eq!(drain(&mut decoder), vec![body]);
    }

    /// A pipe splits wherever it likes, including inside the header, inside the
    /// body, and between the two halves of a multi-byte character.
    #[test]
    fn reassembles_a_message_split_across_reads() {
        let body = r#"{"text":"é👋"}"#;
        let framed = encode(body);

        for split in 1..framed.len() {
            let mut decoder = Decoder::new();
            decoder.feed(&framed[..split]);
            let early = decoder.next_message().expect("no error mid-message");
            decoder.feed(&framed[split..]);
            let late = drain(&mut decoder);

            match early {
                // Splitting after the last byte is not really a split.
                Some(message) => assert_eq!(message, body),
                None => assert_eq!(late, vec![body], "split at {split} lost the message"),
            }
        }
    }

    #[test]
    fn separates_two_messages_in_one_read() {
        let mut buffer = encode(r#"{"id":1}"#);
        buffer.extend_from_slice(&encode(r#"{"id":2}"#));

        let mut decoder = Decoder::new();
        decoder.feed(&buffer);
        assert_eq!(drain(&mut decoder), vec![r#"{"id":1}"#, r#"{"id":2}"#]);
    }

    #[test]
    fn tolerates_extra_headers_and_odd_casing() {
        let body = r#"{"ok":true}"#;
        let mut decoder = Decoder::new();
        decoder.feed(
            format!(
                "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
        assert_eq!(drain(&mut decoder), vec![body]);
    }

    #[test]
    fn an_empty_body_is_a_message() {
        let mut decoder = Decoder::new();
        decoder.feed(&encode(""));
        assert_eq!(drain(&mut decoder), vec![""]);
    }

    /// A stream with no header terminator must fail rather than buffer forever.
    #[test]
    fn refuses_an_endless_header() {
        let mut decoder = Decoder::new();
        decoder.feed(&vec![b'x'; MAX_HEADER_BYTES + 1]);
        assert!(decoder.next_message().is_err());
    }

    #[test]
    fn refuses_a_nonsense_length() {
        let mut decoder = Decoder::new();
        decoder.feed(b"Content-Length: banana\r\n\r\n{}");
        assert!(decoder.next_message().is_err());
    }

    #[test]
    fn refuses_a_header_with_no_length() {
        let mut decoder = Decoder::new();
        decoder.feed(b"Content-Type: application/json\r\n\r\n{}");
        assert!(decoder.next_message().is_err());
    }

    /// The guard is on the declared length, before anything is allocated.
    #[test]
    fn refuses_an_implausible_length() {
        let mut decoder = Decoder::new();
        decoder.feed(format!("Content-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1).as_bytes());
        assert!(decoder.next_message().is_err());
    }
}
