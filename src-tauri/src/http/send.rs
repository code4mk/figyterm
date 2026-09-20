//! One request, from a parsed URL to the last byte of the body.
//!
//! Nothing here knows about Tauri. Progress goes out through a callback the
//! command layer wires to an event, the same division `lsp/server.rs` keeps —
//! which is what lets the hard part (redirects, cancellation, truncation) be
//! reasoned about without a window in the picture.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE,
    LOCATION, PROXY_AUTHORIZATION,
};
use reqwest::{Client, Method, Response, StatusCode, Url};
use tokio::sync::oneshot;

use super::{
    BodyField, BodyInput, BodyOut, ErrorKind, HeaderPair, Hop, Progress, SendError, SendInput,
    SendOutput, SentRequest, Timing,
};

/// How often progress is reported while a body downloads. Every chunk would be
/// thousands of events for a large response, and the webview cannot paint that
/// fast anyway.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// The largest file this will attach to a request.
///
/// Read into memory rather than streamed, because a redirect means sending the
/// same body twice and a stream can only be read once. Streaming with a rebuilt
/// reader per hop is a later phase; refusing a file this app cannot resend is
/// better than discovering it at hop two.
const MAX_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;

/// A body, prepared once and applied to every hop.
///
/// It exists because a multipart form cannot be cloned: `reqwest` consumes the
/// form when it builds the request, so a redirect needs it built again. Holding
/// the parts — with any file already read — is what makes the second hop send
/// the same thing as the first.
#[derive(Debug)]
enum Payload {
    None,
    Bytes(Vec<u8>),
    Multipart(Vec<PreparedPart>),
}

#[derive(Debug)]
struct PreparedPart {
    name: String,
    value: Vec<u8>,
    /// Set for a file part: the name the server is told, and the type.
    file_name: Option<String>,
    content_type: Option<String>,
}

impl Payload {
    fn len(&self) -> u64 {
        match self {
            Payload::None => 0,
            Payload::Bytes(bytes) => bytes.len() as u64,
            Payload::Multipart(parts) => parts.iter().map(|p| p.value.len() as u64).sum(),
        }
    }
}

/// Percent-encoding for a form field.
///
/// `{{templates}}` are gone by now — the webview resolves them before this — so
/// everything reserved is encoded, which is what a form post requires and what
/// distinguishes this from pasting the same text into a raw body.
fn form_encode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Reads a file that is going into a request, refusing one too large to resend.
fn read_attachment(path: &str) -> Result<(Vec<u8>, String), SendError> {
    let meta = std::fs::metadata(path).map_err(|e| SendError::invalid(format!("{path}: {e}")))?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(SendError::invalid(format!(
            "{path} is {} MB, which is larger than this can attach",
            meta.len() / (1024 * 1024)
        )));
    }
    let bytes = std::fs::read(path).map_err(|e| SendError::invalid(format!("{path}: {e}")))?;
    let name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    Ok((bytes, name))
}

fn prepare_parts(fields: &[BodyField]) -> Result<Vec<PreparedPart>, SendError> {
    let mut parts = Vec::with_capacity(fields.len());
    for field in fields {
        match &field.file_path {
            Some(path) => {
                let (bytes, file_name) = read_attachment(path)?;
                parts.push(PreparedPart {
                    name: field.key.clone(),
                    value: bytes,
                    file_name: Some(file_name),
                    content_type: field.content_type.clone(),
                });
            }
            None => parts.push(PreparedPart {
                name: field.key.clone(),
                value: field.value.clone().into_bytes(),
                file_name: None,
                content_type: field.content_type.clone(),
            }),
        }
    }
    Ok(parts)
}

/// Turns what the editor holds into what goes on the wire.
///
/// Returns the payload and, where the shape decides it, the content type — a
/// form is always form-encoded, and a GraphQL request is always JSON, whatever
/// the header table happens to say.
fn prepare(body: Option<BodyInput>) -> Result<(Payload, Option<&'static str>), SendError> {
    match body {
        None | Some(BodyInput::None) => Ok((Payload::None, None)),

        Some(BodyInput::Raw { text }) => Ok((
            if text.is_empty() {
                Payload::None
            } else {
                Payload::Bytes(text.into_bytes())
            },
            None,
        )),

        Some(BodyInput::Urlencoded { fields }) => {
            let text = fields
                .iter()
                .map(|field| format!("{}={}", form_encode(&field.key), form_encode(&field.value)))
                .collect::<Vec<_>>()
                .join("&");
            Ok((
                Payload::Bytes(text.into_bytes()),
                Some("application/x-www-form-urlencoded"),
            ))
        }

        // The boundary is `reqwest`'s to choose, so the content type is set
        // when the request is built rather than here.
        Some(BodyInput::FormData { fields }) => {
            Ok((Payload::Multipart(prepare_parts(&fields)?), None))
        }

        Some(BodyInput::File { path }) => {
            let (bytes, _) = read_attachment(&path)?;
            Ok((Payload::Bytes(bytes), None))
        }

        Some(BodyInput::Graphql { query, variables }) => {
            let parsed: serde_json::Value = if variables.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(&variables).map_err(|e| {
                    SendError::invalid(format!("The GraphQL variables are not valid JSON: {e}"))
                })?
            };
            let payload = if parsed.is_null() {
                serde_json::json!({ "query": query })
            } else {
                serde_json::json!({ "query": query, "variables": parsed })
            };
            Ok((
                Payload::Bytes(payload.to_string().into_bytes()),
                Some("application/json"),
            ))
        }
    }
}

/// Statuses that carry a `Location` worth following.
fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// Whether two URLs are the same origin, which decides whether credentials
/// survive a redirect. A token minted for your API must not be handed to
/// whatever host an open redirect names.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Turns a transport failure into something the UI can offer a remedy for.
///
/// `reqwest` answers "was it a timeout, a connect, a body" directly; everything
/// finer has to be read off the source chain, because the TLS and DNS errors
/// underneath are other crates' types. Sniffing text is unlovely, and it is
/// still better than telling someone their expired certificate is an
/// "unknown error".
fn classify(error: &reqwest::Error) -> SendError {
    let mut detail = String::new();
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(err) = source {
        detail.push_str(&err.to_string().to_lowercase());
        detail.push(' ');
        source = err.source();
    }

    let kind = if error.is_timeout() {
        ErrorKind::Timeout
    } else if detail.contains("certificate")
        || detail.contains("tls")
        || detail.contains("ssl")
        || detail.contains("handshake")
    {
        ErrorKind::Tls
    } else if error.is_connect() {
        ErrorKind::Connect
    } else if error.is_body() || error.is_decode() {
        ErrorKind::Body
    } else {
        ErrorKind::Other
    };

    // The `Display` of a `reqwest::Error` is often just "error sending
    // request"; the cause underneath is the part worth reading.
    let mut message = error.to_string();
    if let Some(cause) = std::error::Error::source(error) {
        message = format!("{message}: {cause}");
    }
    SendError::new(kind, message)
}

fn pairs(headers: &HeaderMap) -> Vec<HeaderPair> {
    headers
        .iter()
        .map(|(name, value)| HeaderPair {
            name: name.as_str().to_string(),
            // Not every header is UTF-8; showing the bytes loosely is better
            // than hiding the header.
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
        })
        .collect()
}

fn build_headers(input: &[super::HeaderInput]) -> Result<HeaderMap, SendError> {
    let mut map = HeaderMap::new();
    for header in input {
        let name = HeaderName::from_bytes(header.name.trim().as_bytes())
            .map_err(|_| SendError::invalid(format!("Not a valid header name: {}", header.name)))?;
        let value = HeaderValue::from_str(&header.value).map_err(|_| {
            SendError::invalid(format!(
                "Not a valid value for {}: {}",
                header.name, header.value
            ))
        })?;
        // `append`, not `insert`: `Set-Cookie` and `Accept` are legitimately
        // repeated, and a request editor that silently kept only the last row
        // would be lying about what it sent.
        map.append(name, value);
    }
    Ok(map)
}

/// What is left of the request's time budget, or `None` when it has no limit.
fn remaining(deadline: Option<Instant>) -> Result<Option<Duration>, SendError> {
    match deadline {
        None => Ok(None),
        Some(deadline) => {
            let now = Instant::now();
            if now >= deadline {
                Err(SendError::new(
                    ErrorKind::Timeout,
                    "Timed out before the response arrived",
                ))
            } else {
                Ok(Some(deadline - now))
            }
        }
    }
}

/// Applies the redirect rules to the next hop, in place.
///
/// The rules are the ones every client has converged on: 303 always becomes a
/// GET, 301 and 302 become one only for POST, and 307 and 308 exist precisely
/// to preserve the method and the body. Dropping the body means dropping the
/// headers that described it, or the next request claims a `Content-Type` for
/// something it isn't sending.
fn apply_redirect(
    status: StatusCode,
    method: &mut Method,
    payload: &mut Payload,
    headers: &mut HeaderMap,
) {
    let to_get = match status.as_u16() {
        303 => *method != Method::HEAD,
        301 | 302 => *method == Method::POST,
        _ => false,
    };

    if to_get {
        *method = Method::GET;
        *payload = Payload::None;
        headers.remove(CONTENT_TYPE);
        headers.remove(CONTENT_LENGTH);
    }
}

/// Sends the request, following redirects by hand, and reads the body.
pub async fn execute(
    client: Client,
    input: SendInput,
    mut cancel: oneshot::Receiver<()>,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<SendOutput, SendError> {
    let mut method = Method::from_bytes(input.method.trim().to_uppercase().as_bytes())
        .map_err(|_| SendError::invalid(format!("Not a valid HTTP method: {}", input.method)))?;

    let mut url = Url::parse(input.url.trim())
        .map_err(|e| SendError::invalid(format!("{}: {}", input.url, e)))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(SendError::invalid(format!(
            "Only http and https are supported here, not {}",
            url.scheme()
        )));
    }

    let mut headers = build_headers(&input.headers)?;
    let (mut payload, implied_type) = prepare(input.body)?;

    /*
      A form is a form, whatever the header table says.

      This used to let a hand-typed `Content-Type` win on the grounds that
      overriding one is sometimes the point. That is true of a *raw* body —
      JSON sent as `application/vnd.api+json` is an ordinary thing to want, and
      that path is untouched, because a raw body's type is only ever filled in
      where no header was typed.

      It is not true here. For a form, a multipart or a GraphQL request the
      type is a fact about the bytes on the wire, not a preference: the body is
      `a=1&b=2` and calling it `application/x-amz-json-1.1` does not make it
      JSON, it makes the server parse a form as JSON and fail. An imported
      collection carrying a stale type — which is ordinary, headers outlive the
      body they were written for — would send every form request mislabelled.

      Multipart is the sharper case still: `reqwest` picks the boundary while
      building the request, so any `multipart/form-data` typed by hand names a
      boundary that is not in the body, and nothing can read it.
    */
    match (&payload, implied_type) {
        (_, Some(content_type)) => {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        // No implied type to insert, but the boundary is still not ours to
        // name: leaving a typed one in place is worse than having none.
        (Payload::Multipart(_), None) => {
            headers.remove(CONTENT_TYPE);
        }
        _ => {}
    }

    let options = input.options;
    let started = Instant::now();
    let deadline =
        (options.timeout_ms > 0).then(|| started + Duration::from_millis(options.timeout_ms));

    let mut redirects: Vec<Hop> = Vec::new();
    let mut hops = 0u32;

    // Every iteration is one request on the wire. It ends either by breaking
    // with the response to read, or by rewriting `url`/`method`/`body` for the
    // next hop.
    let (mut response, sent) = loop {
        let hop_started = Instant::now();

        let mut request = client.request(method.clone(), url.clone());
        request = request.headers(headers.clone());
        request = match &payload {
            Payload::None => request,
            Payload::Bytes(bytes) => request.body(bytes.clone()),
            // Rebuilt per hop: a form is consumed when the request is built,
            // and the second hop would otherwise send nothing at all.
            Payload::Multipart(parts) => {
                let mut form = reqwest::multipart::Form::new();
                for part in parts {
                    let mut piece = reqwest::multipart::Part::bytes(part.value.clone());
                    if let Some(name) = &part.file_name {
                        piece = piece.file_name(name.clone());
                    }
                    if let Some(kind) = &part.content_type {
                        piece = piece.mime_str(kind).map_err(|e| {
                            SendError::invalid(format!("{kind} is not a content type: {e}"))
                        })?;
                    }
                    form = form.part(part.name.clone(), piece);
                }
                request.multipart(form)
            }
        };
        if let Some(left) = remaining(deadline)? {
            request = request.timeout(left);
        }

        // Built before it is executed so the headers the client assembled —
        // `Content-Length`, `User-Agent`, anything it fills in for us — can be
        // reported as what actually went out.
        let built = request
            .build()
            .map_err(|e| SendError::invalid(e.to_string()))?;
        let sent = SentRequest {
            method: built.method().as_str().to_string(),
            url: built.url().to_string(),
            headers: pairs(built.headers()),
            body_bytes: payload.len(),
        };

        let response = tokio::select! {
            biased;
            _ = &mut cancel => return Err(SendError::new(ErrorKind::Cancelled, "Cancelled")),
            result = client.execute(built) => result.map_err(|e| classify(&e))?,
        };

        let status = response.status();
        if !(options.follow_redirects && is_redirect(status)) {
            break (response, sent);
        }

        let Some(location) = response.headers().get(LOCATION) else {
            // A redirect status with nowhere to go is the server's answer, and
            // showing it is more useful than inventing an error.
            break (response, sent);
        };
        let location = location.to_str().map_err(|_| {
            SendError::new(
                ErrorKind::Other,
                "The redirect's Location header is not text",
            )
        })?;
        let next = url.join(location).map_err(|e| {
            SendError::new(
                ErrorKind::Other,
                format!("The redirect points at {location}, which is not a URL: {e}"),
            )
        })?;

        hops += 1;
        if hops > options.max_redirects {
            return Err(SendError::new(
                ErrorKind::TooManyRedirects,
                format!("Gave up after {} redirects", options.max_redirects),
            ));
        }

        redirects.push(Hop {
            status: status.as_u16(),
            from: url.to_string(),
            to: next.to_string(),
            elapsed_ms: hop_started.elapsed().as_millis() as u64,
        });

        if !same_origin(&url, &next) {
            headers.remove(AUTHORIZATION);
            headers.remove(PROXY_AUTHORIZATION);
            headers.remove(COOKIE);
        }
        apply_redirect(status, &mut method, &mut payload, &mut headers);
        url = next;
    };

    let wait_ms = started.elapsed().as_millis() as u64;
    let download_started = Instant::now();

    let status = response.status();
    let head = pairs(response.headers());
    let total = response.content_length();
    let final_url = response.url().to_string();
    let remote_address = response.remote_addr().map(|addr| addr.to_string());
    let http_version = format!("{:?}", response.version());

    let (bytes, truncated) = read_body(
        &mut response,
        &mut cancel,
        options.max_body_bytes,
        total,
        &input.id,
        on_progress,
    )
    .await?;

    // Counted before the bytes are turned into anything, so the size reported
    // is the size on the wire rather than the length of a base64 rendering.
    let byte_count = bytes.len() as u64;
    let (text, base64) = match String::from_utf8(bytes) {
        Ok(text) => (Some(text), None),
        Err(err) => (None, Some(BASE64.encode(err.as_bytes()))),
    };

    Ok(SendOutput {
        id: input.id,
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        headers: head,
        body: BodyOut {
            text,
            base64,
            bytes: byte_count,
            truncated,
        },
        timing: Timing {
            total_ms: started.elapsed().as_millis() as u64,
            wait_ms,
            download_ms: download_started.elapsed().as_millis() as u64,
        },
        final_url,
        remote_address,
        redirects,
        sent,
    })
}

/// Reads the body chunk by chunk, so it can be cancelled, reported on, and
/// stopped at a size rather than discovered to be too large once it is already
/// in memory.
async fn read_body(
    response: &mut Response,
    cancel: &mut oneshot::Receiver<()>,
    max_bytes: u64,
    total: Option<u64>,
    id: &str,
    on_progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(Vec<u8>, bool), SendError> {
    let mut buffer: Vec<u8> =
        Vec::with_capacity(total.unwrap_or(8 * 1024).min(1024 * 1024) as usize);
    let mut last_report = Instant::now();
    let mut truncated = false;

    loop {
        let chunk = tokio::select! {
            biased;
            _ = &mut *cancel => return Err(SendError::new(ErrorKind::Cancelled, "Cancelled")),
            chunk = response.chunk() => chunk.map_err(|e| classify(&e))?,
        };

        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);

        if buffer.len() as u64 >= max_bytes {
            buffer.truncate(max_bytes as usize);
            truncated = true;
            // Dropping the response here closes the connection rather than
            // downloading gigabytes we have already decided not to keep.
            break;
        }

        if last_report.elapsed() >= PROGRESS_INTERVAL {
            last_report = Instant::now();
            on_progress(Progress {
                id: id.to_string(),
                received: buffer.len() as u64,
                total,
            });
        }
    }

    on_progress(Progress {
        id: id.to_string(),
        received: buffer.len() as u64,
        total,
    });
    Ok((buffer, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> super::super::HeaderInput {
        super::super::HeaderInput {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn redirect_statuses_are_the_five_that_carry_a_location() {
        for status in [301, 302, 303, 307, 308] {
            assert!(
                is_redirect(StatusCode::from_u16(status).unwrap()),
                "{status}"
            );
        }
        for status in [200, 204, 300, 304, 400, 500] {
            assert!(
                !is_redirect(StatusCode::from_u16(status).unwrap()),
                "{status}"
            );
        }
    }

    /// 304 is the one that catches people out: it is a 3xx, it is not a
    /// redirect, and following it would turn a cache hit into a second request.
    #[test]
    fn not_modified_is_not_a_redirect() {
        assert!(!is_redirect(StatusCode::NOT_MODIFIED));
    }

    #[test]
    fn origins_compare_on_scheme_host_and_port() {
        let a = Url::parse("https://api.example.com/v1").unwrap();
        assert!(same_origin(
            &a,
            &Url::parse("https://api.example.com/other").unwrap()
        ));
        // The default port is the same origin as writing it out.
        assert!(same_origin(
            &a,
            &Url::parse("https://api.example.com:443/x").unwrap()
        ));
        assert!(!same_origin(
            &a,
            &Url::parse("http://api.example.com/v1").unwrap()
        ));
        assert!(!same_origin(
            &a,
            &Url::parse("https://evil.example.com/v1").unwrap()
        ));
        assert!(!same_origin(
            &a,
            &Url::parse("https://api.example.com:8443/v1").unwrap()
        ));
    }

    #[test]
    fn a_post_through_302_becomes_a_get_without_its_body() {
        let mut method = Method::POST;
        let mut payload = Payload::Bytes(b"{}".to_vec());
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        apply_redirect(StatusCode::FOUND, &mut method, &mut payload, &mut headers);

        assert_eq!(method, Method::GET);
        assert_eq!(payload.len(), 0);
        assert!(headers.get(CONTENT_TYPE).is_none());
    }

    #[test]
    fn a_post_through_307_keeps_its_method_and_body() {
        let mut method = Method::POST;
        let mut payload = Payload::Bytes(b"{}".to_vec());
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        apply_redirect(
            StatusCode::TEMPORARY_REDIRECT,
            &mut method,
            &mut payload,
            &mut headers,
        );

        assert_eq!(method, Method::POST);
        assert_eq!(payload.len(), 2);
        assert!(headers.get(CONTENT_TYPE).is_some());
    }

    /// 303 is "go and look over there instead", whatever the method was —
    /// which is exactly how the POST-redirect-GET pattern is meant to work.
    #[test]
    fn a_put_through_303_becomes_a_get() {
        let mut method = Method::PUT;
        let mut payload = Payload::Bytes(b"x".to_vec());
        let mut headers = HeaderMap::new();

        apply_redirect(
            StatusCode::SEE_OTHER,
            &mut method,
            &mut payload,
            &mut headers,
        );

        assert_eq!(method, Method::GET);
        assert_eq!(payload.len(), 0);
    }

    /// A HEAD stays a HEAD: turning it into a GET would download a body the
    /// caller explicitly asked not to receive.
    #[test]
    fn a_head_through_303_stays_a_head() {
        let mut method = Method::HEAD;
        let mut payload = Payload::None;
        let mut headers = HeaderMap::new();

        apply_redirect(
            StatusCode::SEE_OTHER,
            &mut method,
            &mut payload,
            &mut headers,
        );

        assert_eq!(method, Method::HEAD);
    }

    #[test]
    fn a_get_through_301_is_left_alone() {
        let mut method = Method::GET;
        let mut payload = Payload::None;
        let mut headers = HeaderMap::new();

        apply_redirect(
            StatusCode::MOVED_PERMANENTLY,
            &mut method,
            &mut payload,
            &mut headers,
        );

        assert_eq!(method, Method::GET);
    }

    // ─── The body's own content type ────────────────────────────────────────

    /// A helper mirroring what `execute` does with the two, so the rule can be
    /// tested without a server on the other end.
    fn typed(body: Option<BodyInput>, header: Option<&str>) -> Option<String> {
        let mut headers = HeaderMap::new();
        if let Some(value) = header {
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
        }
        let (payload, implied) = prepare(body).unwrap();
        match (&payload, implied) {
            (_, Some(content_type)) => {
                headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
            }
            (Payload::Multipart(_), None) => {
                headers.remove(CONTENT_TYPE);
            }
            _ => {}
        }
        headers
            .get(CONTENT_TYPE)
            .map(|value| value.to_str().unwrap().to_string())
    }

    fn form() -> BodyInput {
        BodyInput::Urlencoded {
            fields: vec![BodyField {
                key: "grant_type".into(),
                value: "client_credentials".into(),
                file_path: None,
                content_type: None,
            }],
        }
    }

    /*
      The bug this test exists for.

      An imported collection carried `Content-Type: application/x-amz-json-1.1`
      on a request whose body is a form. Sending the form bytes under that name
      makes the server parse a form as JSON and refuse — as an authentication
      failure, in the case that found this, which sent everybody to check a
      password that was right all along.

      Headers outlive the body they were written for. The body is the thing
      that knows what it is.
    */
    #[test]
    fn a_form_overrides_a_content_type_left_over_in_the_header_table() {
        assert_eq!(
            typed(Some(form()), Some("application/x-amz-json-1.1")).as_deref(),
            Some("application/x-www-form-urlencoded")
        );
    }

    #[test]
    fn a_form_with_no_header_is_still_typed() {
        assert_eq!(
            typed(Some(form()), None).as_deref(),
            Some("application/x-www-form-urlencoded")
        );
    }

    /// GraphQL is JSON on the wire whatever the table says, for the same
    /// reason: the bytes are `{"query": …}`.
    #[test]
    fn graphql_is_json_whatever_was_typed() {
        let body = BodyInput::Graphql {
            query: "{ me { id } }".into(),
            variables: String::new(),
        };
        assert_eq!(
            typed(Some(body), Some("text/plain")).as_deref(),
            Some("application/json")
        );
    }

    /// `reqwest` picks the boundary while building the request, so a
    /// `multipart/form-data` typed by hand names a boundary that is not in the
    /// body and nothing can read it. Better none than a wrong one.
    #[test]
    fn a_typed_multipart_header_is_removed_so_the_boundary_is_right() {
        let body = BodyInput::FormData {
            fields: vec![BodyField {
                key: "file".into(),
                value: "x".into(),
                file_path: None,
                content_type: None,
            }],
        };
        assert_eq!(typed(Some(body), Some("multipart/form-data")), None);
    }

    /*
      The other half, and the reason this is not simply "the body always wins".

      A raw body's type is a preference: JSON sent as
      `application/vnd.api+json` is an ordinary thing to want, and that is what
      typing a header is for. Raw never implies a type at this level, so the
      header stands.
    */
    #[test]
    fn a_raw_body_still_lets_a_typed_header_stand() {
        let body = BodyInput::Raw {
            text: "{}".into(),
        };
        assert_eq!(
            typed(Some(body), Some("application/vnd.api+json")).as_deref(),
            Some("application/vnd.api+json")
        );
    }

    // ─── Bodies ─────────────────────────────────────────────────────────────

    #[test]
    fn a_form_body_is_encoded_and_typed() {
        let (payload, content_type) = prepare(Some(BodyInput::Urlencoded {
            fields: vec![
                BodyField {
                    key: "user name".into(),
                    value: "ada lovelace".into(),
                    file_path: None,
                    content_type: None,
                },
                BodyField {
                    key: "note".into(),
                    value: "a&b=c".into(),
                    file_path: None,
                    content_type: None,
                },
            ],
        }))
        .unwrap();

        assert_eq!(content_type, Some("application/x-www-form-urlencoded"));
        match payload {
            Payload::Bytes(bytes) => assert_eq!(
                String::from_utf8(bytes).unwrap(),
                "user+name=ada+lovelace&note=a%26b%3Dc"
            ),
            _ => panic!("a form is bytes"),
        }
    }

    #[test]
    fn a_graphql_body_is_the_json_the_wire_expects() {
        let (payload, content_type) = prepare(Some(BodyInput::Graphql {
            query: "{ me { id } }".into(),
            variables: r#"{"id":1}"#.into(),
        }))
        .unwrap();

        assert_eq!(content_type, Some("application/json"));
        match payload {
            Payload::Bytes(bytes) => {
                let sent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(sent["query"], "{ me { id } }");
                assert_eq!(sent["variables"]["id"], 1);
            }
            _ => panic!("graphql is bytes"),
        }
    }

    #[test]
    fn graphql_with_no_variables_sends_none() {
        let (payload, _) = prepare(Some(BodyInput::Graphql {
            query: "{ me { id } }".into(),
            variables: "  ".into(),
        }))
        .unwrap();
        match payload {
            Payload::Bytes(bytes) => {
                let sent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert!(sent.get("variables").is_none());
            }
            _ => panic!("graphql is bytes"),
        }
    }

    /// Variables that will not parse are refused before anything is sent: a
    /// server rejecting them would be a much more confusing way to find out.
    #[test]
    fn graphql_variables_that_are_not_json_are_refused() {
        let error = prepare(Some(BodyInput::Graphql {
            query: "{}".into(),
            variables: "{oops".into(),
        }))
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn a_missing_attachment_is_refused_by_name() {
        let error = prepare(Some(BodyInput::File {
            path: "/definitely/not/here.png".into(),
        }))
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidRequest);
        assert!(error.message.contains("/definitely/not/here.png"));
    }

    #[test]
    fn an_empty_raw_body_sends_nothing() {
        let (payload, _) = prepare(Some(BodyInput::Raw {
            text: String::new(),
        }))
        .unwrap();
        assert_eq!(payload.len(), 0);
    }

    /// The multipart parts are held rather than built, so that a redirect can
    /// build them a second time — a form cannot be cloned once it is a request.
    #[test]
    fn multipart_text_parts_are_prepared_for_every_hop() {
        let (payload, content_type) = prepare(Some(BodyInput::FormData {
            fields: vec![BodyField {
                key: "caption".into(),
                value: "me".into(),
                file_path: None,
                content_type: None,
            }],
        }))
        .unwrap();

        assert_eq!(content_type, None, "the boundary decides the type");
        match payload {
            Payload::Multipart(parts) => {
                assert_eq!(parts.len(), 1);
                assert_eq!(parts[0].name, "caption");
                assert!(parts[0].file_name.is_none());
            }
            _ => panic!("form data is multipart"),
        }
    }

    #[test]
    fn repeated_headers_are_all_sent() {
        let map = build_headers(&[
            header("Accept", "text/html"),
            header("Accept", "application/json"),
        ])
        .unwrap();
        assert_eq!(map.get_all("accept").iter().count(), 2);
    }

    #[test]
    fn header_names_are_trimmed_and_bad_ones_refused() {
        let map = build_headers(&[header("  X-Trace  ", "1")]).unwrap();
        assert_eq!(map.get("x-trace").unwrap(), "1");

        let bad = build_headers(&[header("X Trace", "1")]).unwrap_err();
        assert_eq!(bad.kind, ErrorKind::InvalidRequest);

        // A newline in a value is header injection, and `HeaderValue` refuses it.
        let injected = build_headers(&[header("X-Trace", "a\r\nX-Admin: true")]).unwrap_err();
        assert_eq!(injected.kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn a_budget_already_spent_is_a_timeout_rather_than_a_send() {
        let past = Instant::now() - Duration::from_secs(1);
        assert_eq!(remaining(Some(past)).unwrap_err().kind, ErrorKind::Timeout);
        assert!(remaining(None).unwrap().is_none());
        assert!(remaining(Some(Instant::now() + Duration::from_secs(5)))
            .unwrap()
            .is_some());
    }
}
