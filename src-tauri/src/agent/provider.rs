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

/// What the window is told while a turn runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// A piece of the assistant's prose, as it is produced.
    Text { text: String },
    /// A tool call has a name. Its arguments may still be arriving.
    ToolCallStarted { id: String, name: String },
    /// The turn is over.
    Done { finish_reason: String },
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
        let built = self
            .client
            .post(&url)
            .bearer_auth(&self.config.api_key)
            .timeout(self.config.timeout)
            .json(&self.body(&request));

        let mut response = tokio::select! {
            biased;
            _ = &mut cancel => return Err(CANCELLED.into()),
            result = built.send() => result.map_err(|e| format!("Could not reach the model: {e}"))?,
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(explain_failure(status.as_u16(), &body));
        }

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

        let second = a.push(&frame(json!({
            "tool_calls": [{ "index": 0, "function": { "arguments": "{}" } }]
        })));
        assert!(second.is_empty(), "a call is announced once, not per fragment");
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
    fn failures_are_explained_by_what_the_user_can_do_about_them() {
        let unauthorised = explain_failure(401, r#"{"error":{"message":"bad key"}}"#);
        assert!(unauthorised.contains("refused the key"));
        assert!(unauthorised.contains("bad key"));
        assert!(explain_failure(429, "{}").contains("Rate limited"));
        assert!(explain_failure(503, "upstream down").contains("having trouble"));
    }
}
