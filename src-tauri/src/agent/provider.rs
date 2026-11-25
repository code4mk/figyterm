//! Talking to the model.
//!
//! One trait, and one implementation of it that speaks OpenAI's
//! `/v1/chat/completions`. The provider is a base URL, a key and a model
//! name — so OpenAI, OpenRouter, a local llama.cpp server, DeepSeek and
//! anything else that implements the same four fields are a setting rather
//! than a port.
//!
//! ## Streaming, and why the parser is its own thing
//!
//! Server-sent events arrive as `data: {json}` lines in chunks that do not
//! respect line boundaries: a tool call's arguments routinely land four
//! characters at a time, spread across three TCP reads, with a half-line
//! left in the buffer at the end of each. [`StreamAssembler`] is that
//! reassembly, and it is pure — bytes in, events out — because every bug it
//! can have is a bug you cannot reproduce against a live endpoint.
//!
//! ## Cancellation
//!
//! Escape has to stop a turn that is mid-flight, not mark it stopped and let
//! it finish. The request is raced against a `oneshot` through
//! `tokio::select!`, the same way the API client's send path does it, so the
//! connection is dropped rather than drained.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc::UnboundedSender, oneshot};

use crate::agent::message::{Message, ToolCall, Usage};

/// Where the model is, and which one.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`,
    /// `http://localhost:11434/v1` — the part before `/chat/completions`.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// Sent only when set, because several compatible endpoints reject an
    /// explicit `null` and others have their own default worth keeping.
    pub temperature: Option<f32>,
    pub timeout: Duration,
}

/// One request for one turn.
pub struct TurnRequest {
    pub messages: Vec<Message>,
    /// The tool definitions, already in OpenAI form. **Byte-identical across
    /// every turn of a session** — see `tools::registry`.
    pub tools: Value,
}

/// What came back when the stream ended.
#[derive(Debug, Clone, Default)]
pub struct Completion {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    /// `stop`, `tool_calls`, `length` — the provider's word for why it
    /// stopped. `length` is the one worth acting on: the answer was cut off.
    pub finish_reason: String,
}

/* ─── Trying again ───────────────────────────────────────────────────────── */

/// How many times one request is attempted, including the first.
///
/// Four, and then it stops. A rate limit that has not cleared in a
/// minute is not clearing in the next thirty seconds either, and an
/// agent that retries forever is one nobody can tell from a hang.
const ATTEMPTS: usize = 4;

/// The first wait. Doubles each time, to [`BACKOFF_CAP`].
const BACKOFF_BASE: Duration = Duration::from_secs(2);
const BACKOFF_CAP: Duration = Duration::from_secs(30);

/// Whether trying the same request again could plausibly work.
///
/// The distinction is between *the service cannot right now* and *the
/// request is wrong*. Retrying a 401 is a way of being rate-limited for
/// having the wrong key; retrying a 429 is the documented thing to do.
pub fn retryable(status: u16) -> bool {
    matches!(status, 408 | 409 | 425 | 429 | 500 | 502 | 503 | 504)
}

/// How long to wait before attempt `attempt` (1-based, so the first
/// retry is 1).
///
/// `Retry-After` wins when the server sent one — it knows, and ignoring
/// it is how a client earns a longer ban. Otherwise exponential, with a
/// little jitter so that two windows rate-limited by the same burst do
/// not come back in lockstep and cause the next one.
pub fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    if let Some(seconds) = retry_after {
        return Duration::from_secs(seconds.min(BACKOFF_CAP.as_secs()));
    }
    let doubled = BACKOFF_BASE.saturating_mul(1u32 << attempt.min(5).saturating_sub(1));
    let capped = doubled.min(BACKOFF_CAP);

    /*
      Jitter from the clock rather than from a random number generator.

      This needs to be *uneven*, not unpredictable, and a dependency for
      one number is a poor trade in a binary shipping on three platforms.

      **Microseconds, not nanoseconds.** The first version took
      `subsec_nanos() % 1000`, which is always zero on a platform whose
      clock has microsecond resolution — macOS, as it happens — so every
      client backed off by exactly the same amount and the jitter did
      nothing at all. A test catches it now.
    */
    let spread = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_micros()) % 500)
        .unwrap_or(0);
    capped + Duration::from_millis(spread)
}

/// `Retry-After: 30`, in seconds. An HTTP-date form is ignored rather
/// than parsed: these APIs send the delta form, and a wrong date is a
/// worse answer than no date.
fn retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// What the window is told while a turn runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// A piece of the assistant's prose, as it is produced.
    Text { text: String },
    /// A tool call has a name. Its arguments may still be arriving.
    ToolCallStarted { id: String, name: String },
    /// A piece of a tool call's arguments, as it is produced.
    ///
    /// Thrown away until now, which is why writing a file looked
    /// like nothing happening: `write` is instant and the *content*
    /// takes half a minute to say, so the window sat on a spinner
    /// while two hundred lines of the thing being written streamed
    /// past unshown.
    ToolCallArguments { id: String, delta: String },
    /// The turn is over.
    Done { finish_reason: String },
    /// The provider could not take it, and this is the wait before the
    /// next try. Said out loud, because a silent thirty-second pause is
    /// indistinguishable from a hang.
    Retrying {
        attempt: u32,
        total: u32,
        seconds: u64,
        reason: String,
    },
}

pub trait Provider: Send + Sync {
    /// Runs one turn, emitting events as it goes.
    ///
    /// `cancel` is dropped or fired to stop; firing it drops the connection
    /// rather than reading the rest of the answer into a buffer nobody wants.
    fn complete(
        &self,
        request: TurnRequest,
        events: UnboundedSender<StreamEvent>,
        cancel: oneshot::Receiver<()>,
    ) -> impl std::future::Future<Output = Result<Completion, String>> + Send;
}

/* ─── The OpenAI-compatible client ───────────────────────────────────────── */

pub struct OpenAiProvider {
    config: ProviderConfig,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            config,
        }
    }

    /// The request body.
    ///
    /// `stream_options.include_usage` is the one easily missed line: without
    /// it a streamed response reports no usage at all, and the ledger — the
    /// thing that makes a cost regression visible — records zeroes for every
    /// turn while looking like it works.
    pub fn body(&self, request: &TurnRequest) -> Value {
        let mut body = json!({
            "model": self.config.model,
            "messages": request.messages.iter().map(Message::as_openai).collect::<Vec<_>>(),
            "stream": true,
            "stream_options": { "include_usage": true },
        });

        if let Some(array) = request.tools.as_array() {
            if !array.is_empty() {
                body["tools"] = request.tools.clone();
                body["tool_choice"] = json!("auto");
            }
        }
        if let Some(temperature) = self.config.temperature {
            body["temperature"] = json!(temperature);
        }
        body
    }
}

impl Provider for OpenAiProvider {
    async fn complete(
        &self,
        request: TurnRequest,
        events: UnboundedSender<StreamEvent>,
        mut cancel: oneshot::Receiver<()>,
    ) -> Result<Completion, String> {
        let url = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));
        let body = self.body(&request);

        /*
          Retries happen here, and **only before the answer has started.**

          That is the subtlety. Once a token has been streamed it has
          been shown to the user and counted; starting the request again
          would replay the answer from the beginning, and the window
          would render it twice. So a connection that drops mid-answer is
          reported with what arrived, and only a refusal to begin —
          429, 503, a connection that never opened — is tried again.
        */
        let mut attempt = 1u32;
        let mut response = loop {
            let sent = tokio::select! {
                biased;
                _ = &mut cancel => return Err(CANCELLED.into()),
                result = self
                    .client
                    .post(&url)
                    .bearer_auth(&self.config.api_key)
                    .timeout(self.config.timeout)
                    .json(&body)
                    .send() => result,
            };

            let (wait, why) = match sent {
                Ok(response) if response.status().is_success() => break response,
                Ok(response) => {
                    let status = response.status().as_u16();
                    if !retryable(status) || attempt >= ATTEMPTS as u32 {
                        let text = response.text().await.unwrap_or_default();
                        return Err(explain_failure(status, &text));
                    }
                    let after = retry_after(&response);
                    let text = response.text().await.unwrap_or_default();
                    (backoff(attempt, after), explain_failure(status, &text))
                }
                // A connection that never opened is the other retryable
                // case, and the commonest one on a laptop lid.
                Err(error) => {
                    if attempt >= ATTEMPTS as u32 {
                        return Err(format!("Could not reach the model: {error}"));
                    }
                    (backoff(attempt, None), format!("Could not reach the model: {error}"))
                }
            };

            let _ = events.send(StreamEvent::Retrying {
                attempt,
                total: ATTEMPTS as u32,
                seconds: wait.as_secs().max(1),
                reason: why,
            });

            // Interruptible: Escape during a thirty-second backoff has to
            // mean Escape, not "wait thirty seconds and then stop".
            tokio::select! {
                biased;
                _ = &mut cancel => return Err(CANCELLED.into()),
                _ = tokio::time::sleep(wait) => {}
            }
            attempt += 1;
            if attempt > ATTEMPTS as u32 {
                return Err("The provider would not take the request.".into());
            }
        };

        let mut assembler = StreamAssembler::default();

        /*
          `chunk()` rather than a `Stream`, which is what the API client's
          send path uses: it needs no extra feature on reqwest and no futures
          crate, and it selects against the cancel receiver as cleanly.
        */
        loop {
            let chunk = tokio::select! {
                biased;
                _ = &mut cancel => return Err(CANCELLED.into()),
                next = response.chunk() => next
                    .map_err(|e| format!("The model's reply stopped early: {e}"))?,
            };
            let Some(chunk) = chunk else { break };

            for event in assembler.push(&String::from_utf8_lossy(&chunk)) {
                // A closed receiver means the window went away mid-turn. The
                // turn still finishes — the ledger wants its usage row — but
                // nobody is listening, so the send failing is not an error.
                let _ = events.send(event);
            }
        }

        let completion = assembler.finish();
        let _ = events.send(StreamEvent::Done {
            finish_reason: completion.finish_reason.clone(),
        });
        Ok(completion)
    }
}

/// The word the loop and the window agree on for "the user stopped it".
pub const CANCELLED: &str = "Interrupted";

/// An HTTP failure, in a sentence that says what to do about it.
///
/// Four numbers cover almost everything that goes wrong here, and each one
/// has a different remedy — telling them apart is the difference between a
/// user fixing it and a user filing a bug.
fn explain_failure(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message").or(Some(e)))
                .map(|m| m.as_str().map(str::to_string).unwrap_or_else(|| m.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status {
        401 | 403 => format!("The model provider refused the key ({status}): {detail}"),
        404 => format!("No such model or endpoint ({status}): {detail}"),
        429 => format!("Rate limited by the provider ({status}): {detail}"),
        500..=599 => format!("The provider is having trouble ({status}): {detail}"),
        _ => format!("The provider returned {status}: {detail}"),
    }
}

/* ─── Reassembling the stream ────────────────────────────────────────────── */

/// Turns SSE chunks into events and, at the end, one [`Completion`].
///
/// Holds three pieces of state, each for a way the wire format is awkward:
/// a buffer for the half-line every chunk boundary leaves behind, the
/// accumulating text, and the tool calls — which arrive **by index**, with
/// the name once and the arguments as a long dribble of fragments.
#[derive(Default)]
pub struct StreamAssembler {
    buffer: String,
    content: String,
    /// By the index the provider assigns, which is the only thing tying a
    /// fragment to the call it belongs to.
    calls: Vec<PartialCall>,
    usage: Usage,
    finish_reason: String,
}

#[derive(Default, Clone)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
    /// Whether the name has been announced, so it is announced once.
    announced: bool,
}

impl StreamAssembler {
    /// Feeds a chunk and returns whatever became whole.
    pub fn push(&mut self, chunk: &str) -> Vec<StreamEvent> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();

        // Everything up to the last newline is complete; what follows is the
        // half-line that the next chunk finishes.
        let Some(last) = self.buffer.rfind('\n') else {
            return out;
        };
        let complete: String = self.buffer.drain(..=last).collect();

        for line in complete.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                // A malformed frame is skipped rather than failing the turn:
                // the answer so far is worth more than the frame is.
                continue;
            };
            self.absorb(&value, &mut out);
        }
        out
    }

    fn absorb(&mut self, value: &Value, out: &mut Vec<StreamEvent>) {
        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            self.usage = Usage::from_json(usage);
        }

        let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
            return;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = reason.to_string();
        }

        let Some(delta) = choice.get("delta") else {
            return;
        };

        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                self.content.push_str(text);
                out.push(StreamEvent::Text { text: text.into() });
            }
        }

        let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) else {
            return;
        };
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if self.calls.len() <= index {
                self.calls.resize(index + 1, PartialCall::default());
            }
            let slot = &mut self.calls[index];
            let mut fragment: Option<String> = None;

            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(function) = call.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    if !name.is_empty() {
                        slot.name.push_str(name);
                    }
                }
                if let Some(args) = function.get("arguments").and_then(Value::as_str) {
                    slot.arguments.push_str(args);
                    fragment = Some(args.to_string());
                }
            }

            // Announced as soon as it has a name, so the window can say
            // "Reading…" while the arguments are still arriving.
            if !slot.announced && !slot.name.is_empty() {
                slot.announced = true;
                out.push(StreamEvent::ToolCallStarted {
                    id: slot.id.clone(),
                    name: slot.name.clone(),
                });
            }

            /*
              And the arguments behind the name.

              After the announcement, so the window has a row to put
              them on — and only once there is an id, because a
              fragment belonging to nothing is a fragment nobody can
              place. Providers send the id with the first chunk of a
              call, so this costs at most the first few characters.
            */
            if let Some(delta) = fragment {
                if !slot.id.is_empty() {
                    out.push(StreamEvent::ToolCallArguments {
                        id: slot.id.clone(),
                        delta,
                    });
                }
            }
        }
    }

    pub fn finish(self) -> Completion {
        let tool_calls = self
            .calls
            .into_iter()
            .filter(|call| !call.name.is_empty())
            .enumerate()
            .map(|(i, call)| ToolCall {
                // A provider that streams no id still needs one, because the
                // tool result has to quote it back.
                id: if call.id.is_empty() {
                    format!("call_{i}")
                } else {
                    call.id
                },
                name: call.name,
                arguments: call.arguments,
            })
            .collect::<Vec<_>>();

        let finish_reason = if self.finish_reason.is_empty() {
            if tool_calls.is_empty() { "stop" } else { "tool_calls" }.to_string()
        } else {
            self.finish_reason
        };

        Completion {
            content: self.content,
            tool_calls,
            usage: self.usage,
            finish_reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(delta: Value) -> String {
        format!("data: {}\n\n", json!({ "choices": [{ "delta": delta }] }))
    }

    #[test]
    fn text_arrives_as_it_is_produced() {
        let mut a = StreamAssembler::default();
        let events = a.push(&frame(json!({ "content": "Hello" })));
        assert!(matches!(&events[0], StreamEvent::Text { text } if text == "Hello"));
        a.push(&frame(json!({ "content": " there" })));
        assert_eq!(a.finish().content, "Hello there");
    }

    #[test]
    fn a_chunk_that_ends_mid_line_is_held_until_the_rest_arrives() {
        // The case that makes this a state machine rather than a function.
        let mut a = StreamAssembler::default();
        let whole = frame(json!({ "content": "split" }));
        let (first, second) = whole.split_at(whole.len() / 2);

        assert!(a.push(first).is_empty(), "half a line must produce nothing");
        let events = a.push(second);
        assert!(matches!(&events[0], StreamEvent::Text { text } if text == "split"));
    }

    #[test]
    fn several_frames_in_one_chunk_all_come_out() {
        let mut a = StreamAssembler::default();
        let chunk = format!(
            "{}{}",
            frame(json!({ "content": "a" })),
            frame(json!({ "content": "b" }))
        );
        assert_eq!(a.push(&chunk).len(), 2);
        assert_eq!(a.finish().content, "ab");
    }

    #[test]
    fn tool_call_arguments_are_glued_back_together_in_order() {
        // How they actually arrive: the name once, then the JSON a few
        // characters at a time.
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "id": "call_a",
                             "function": { "name": "read", "arguments": "" } }]
        })));
        for piece in [r#"{"pa"#, r#"th":"s"#, r#"rc/main.rs"}"#] {
            a.push(&frame(json!({
                "tool_calls": [{ "index": 0, "function": { "arguments": piece } }]
            })));
        }

        let done = a.finish();
        assert_eq!(done.tool_calls.len(), 1);
        assert_eq!(done.tool_calls[0].name, "read");
        assert_eq!(done.tool_calls[0].arguments, r#"{"path":"src/main.rs"}"#);
        assert_eq!(done.tool_calls[0].parsed().unwrap()["path"], "src/main.rs");
    }

    #[test]
    fn a_tool_call_is_announced_once_as_soon_as_it_has_a_name() {
        let mut a = StreamAssembler::default();
        let first = a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "grep" } }]
        })));
        assert!(matches!(&first[0], StreamEvent::ToolCallStarted { name, .. } if name == "grep"));

        // Announced once — and the arguments behind it, which is a
        // different event. Writing a file is half a minute of these
        // and a moment of the tool; without them the window shows a
        // spinner for the whole of the interesting part.
        let second = a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "function": { "arguments": "{}" } }]
        })));
        assert_eq!(second.len(), 1, "no second announcement");
        assert!(
            matches!(&second[0], StreamEvent::ToolCallArguments { id, delta } if id == "c1" && delta == "{}")
        );
    }

    #[test]
    fn arguments_with_no_id_yet_are_held_rather_than_sent_nowhere() {
        // A fragment belonging to no call is one the window cannot
        // put on a row. Providers send the id with the first chunk,
        // so this costs at most the first few characters.
        let mut a = StreamAssembler::default();
        let out = a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "function": { "arguments": "{\"p" } }]
        })));
        assert!(out.is_empty(), "nothing to attach it to yet");
    }

    #[test]
    fn parallel_calls_are_kept_apart_by_index() {
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({
            "tool_calls": [
                { "index": 0, "id": "c0", "function": { "name": "read", "arguments": "{\"a\":" } },
                { "index": 1, "id": "c1", "function": { "name": "grep", "arguments": "{\"b\":" } }
            ]
        })));
        a.push(&frame(json!({
            "tool_calls": [
                { "index": 1, "function": { "arguments": "2}" } },
                { "index": 0, "function": { "arguments": "1}" } }
            ]
        })));

        let done = a.finish();
        assert_eq!(done.tool_calls.len(), 2);
        assert_eq!(done.tool_calls[0].arguments, r#"{"a":1}"#);
        assert_eq!(done.tool_calls[1].arguments, r#"{"b":2}"#);
    }

    #[test]
    fn a_name_that_arrives_in_pieces_is_still_one_name() {
        // Rarer, and real: some providers fragment the name too.
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "re" } }]
        })));
        a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "function": { "name": "ad" } }]
        })));
        assert_eq!(a.finish().tool_calls[0].name, "read");
    }

    #[test]
    fn the_done_sentinel_and_comments_are_not_json() {
        let mut a = StreamAssembler::default();
        assert!(a.push(": keep-alive\n\ndata: [DONE]\n\n").is_empty());
    }

    #[test]
    fn a_malformed_frame_does_not_lose_the_answer() {
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({ "content": "before" })));
        a.push("data: {not json\n\n");
        a.push(&frame(json!({ "content": " after" })));
        assert_eq!(a.finish().content, "before after");
    }

    #[test]
    fn usage_is_taken_from_the_frame_that_carries_it() {
        let mut a = StreamAssembler::default();
        a.push(&format!(
            "data: {}\n\n",
            json!({
                "choices": [],
                "usage": { "prompt_tokens": 900, "completion_tokens": 20,
                           "prompt_tokens_details": { "cached_tokens": 700 } }
            })
        ));
        let done = a.finish();
        assert_eq!(done.usage.input, 900);
        assert_eq!(done.usage.hit_rate(), 78);
    }

    #[test]
    fn a_missing_finish_reason_is_inferred_from_what_came_back() {
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({ "content": "done" })));
        assert_eq!(a.finish().finish_reason, "stop");

        let mut b = StreamAssembler::default();
        b.push(&frame(json!({
            "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "read" } }]
        })));
        assert_eq!(b.finish().finish_reason, "tool_calls");
    }

    #[test]
    fn a_call_with_no_id_still_gets_one() {
        // The result has to quote an id back, so inventing one beats failing.
        let mut a = StreamAssembler::default();
        a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "function": { "name": "read", "arguments": "{}" } }]
        })));
        assert_eq!(a.finish().tool_calls[0].id, "call_0");
    }

    #[test]
    fn usage_is_asked_for_explicitly_in_the_body() {
        // Without `include_usage` a streamed turn reports nothing, and the
        // ledger records zeroes while appearing to work.
        let provider = OpenAiProvider::new(ProviderConfig {
            base_url: "http://x/v1".into(),
            api_key: "k".into(),
            model: "m".into(),
            temperature: None,
            timeout: Duration::from_secs(1),
        });
        let body = provider.body(&TurnRequest {
            messages: vec![Message::user("hi")],
            tools: json!([]),
        });
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        // An empty tool list is left out entirely: several endpoints reject
        // `tools: []`.
        assert!(body.get("tools").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn a_service_that_cannot_right_now_is_retried_and_a_wrong_request_is_not() {
        // The distinction the whole policy rests on: retrying a 401 is a
        // way of getting rate-limited for having the wrong key.
        for busy in [429, 500, 502, 503, 504, 408] {
            assert!(retryable(busy), "{busy} should be retried");
        }
        for wrong in [400, 401, 403, 404, 422] {
            assert!(!retryable(wrong), "{wrong} should not be retried");
        }
    }

    #[test]
    fn the_server_s_own_retry_after_wins() {
        // It knows, and ignoring it is how a client earns a longer ban.
        assert_eq!(backoff(1, Some(7)).as_secs(), 7);
        // Within reason: a server asking for an hour is asking for more
        // than a turn can wait.
        assert!(backoff(1, Some(9_999)) <= BACKOFF_CAP);
    }

    #[test]
    fn the_wait_grows_and_then_stops_growing() {
        let first = backoff(1, None);
        let second = backoff(2, None);
        let fourth = backoff(4, None);
        assert!(second > first, "it should back off");
        assert!(fourth > second);
        // Jitter is added on top of the cap, so this is the cap plus a
        // little rather than exactly the cap.
        assert!(backoff(12, None) < BACKOFF_CAP + Duration::from_secs(1));
    }

    #[test]
    fn two_clients_rate_limited_together_do_not_come_back_in_lockstep() {
        // Jitter, which is why the number is not exactly a power of two.
        let waits: Vec<u128> = (0..6).map(|_| backoff(2, None).as_millis()).collect();
        assert!(
            waits.iter().any(|w| *w != waits[0]) || waits[0] % 1000 != 0,
            "the backoff looks perfectly even: {waits:?}"
        );
    }

    #[test]
    fn failures_are_explained_by_what_the_user_can_do_about_them() {
        let unauthorised = explain_failure(401, r#"{"error":{"message":"bad key"}}"#);
        assert!(unauthorised.contains("refused the key"));
        assert!(unauthorised.contains("bad key"));
        assert!(explain_failure(429, "{}").contains("Rate limited"));
        assert!(explain_failure(503, "upstream down").contains("having trouble"));
    }
}
