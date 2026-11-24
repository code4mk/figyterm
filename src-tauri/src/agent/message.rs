//! The conversation, and what it looks like on the wire.
//!
//! One shape for both halves: what the loop holds in memory and what goes to
//! the provider are the same list, serialised. The format is OpenAI's
//! `/v1/chat/completions`, which is not the best shape anyone has designed
//! but is the one every provider and every router accepts — so the provider
//! is a base URL and a key rather than a rewrite.
//!
//! ## The rule the whole file is arranged around
//!
//! **History is append-only, and a message's bytes never change once sent.**
//!
//! The API is stateless: turn 20 re-sends turns 1–19, and caching is a prefix
//! match over exactly those bytes. Rewriting an earlier message — tidying a
//! tool result, re-serialising arguments, renumbering an id — invalidates
//! every cached token after it, costs 1.25× to write the prefix again, and
//! says nothing at all while it happens. It is the most expensive silent bug
//! in an agent, and the defence against it is this type: nothing here has a
//! mutating method, and [`ToolCall::arguments`] is kept as the raw string the
//! model produced rather than as parsed JSON that would be re-serialised,
//! byte-for-byte differently, on the next turn.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One call the model asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    /// The provider's id, which the result must quote back.
    pub id: String,
    pub name: String,
    /// **The raw JSON text the model produced.** Not a `Value`: parsing and
    /// re-serialising would change the bytes — key order, spacing, number
    /// formatting — and those bytes are in the prefix of every later turn.
    pub arguments: String,
}

impl ToolCall {
    /// The arguments as JSON, for dispatch. Malformed JSON is a tool result
    /// rather than a crash: the model can be told and try again.
    pub fn parsed(&self) -> Result<Value, String> {
        if self.arguments.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&self.arguments)
            .map_err(|e| format!("{}: the arguments were not valid JSON ({e})", self.name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
    /// Assistant turns only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Tool results only: which call this answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(Role::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(Role::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(Role::Assistant, content)
    }

    /// What the model said, plus what it asked to run.
    pub fn assistant_calling(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
        }
    }

    /// A tool's answer, quoting the id of the call it answers.
    pub fn tool_result(id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(id.into()),
        }
    }

    fn plain(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    /// The OpenAI form.
    ///
    /// Written by hand rather than derived, because the shape differs per
    /// role in ways serde attributes would express badly: an assistant turn
    /// that only calls tools sends `content: null`, and a tool result sends
    /// no `tool_calls` key at all rather than an empty array. Providers are
    /// forgiving about the first and several are not about the second.
    pub fn as_openai(&self) -> Value {
        let role = match self.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        };

        let mut out = json!({ "role": role });
        let object = out.as_object_mut().expect("just built");

        if self.role == Role::Assistant && self.content.is_empty() && !self.tool_calls.is_empty() {
            object.insert("content".into(), Value::Null);
        } else {
            object.insert("content".into(), Value::String(self.content.clone()));
        }

        if !self.tool_calls.is_empty() {
            object.insert(
                "tool_calls".into(),
                Value::Array(
                    self.tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments,
                                }
                            })
                        })
                        .collect(),
                ),
            );
        }

        if let Some(id) = &self.tool_call_id {
            object.insert("tool_call_id".into(), Value::String(id.clone()));
        }

        out
    }
}

/// What a turn cost, as the provider reports it.
///
/// `cached` is the number worth watching: a healthy long session reads
/// 70–95% of its input from cache, and zero across turns with an identical
/// prefix means something is invalidating it. That is a bug, not a tuning
/// opportunity, and it is invisible without this field.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input: u32,
    pub output: u32,
    /// Input tokens served from the provider's cache.
    pub cached: u32,
}

impl Usage {
    /// Reads whichever spelling the endpoint uses.
    ///
    /// `prompt_tokens`/`completion_tokens` is OpenAI's, and several
    /// compatible endpoints answer with Anthropic's `input_tokens`. The
    /// cached count hides one level down in OpenAI's
    /// `prompt_tokens_details.cached_tokens`, and at the top level elsewhere.
    /// Reading both is four lines; guessing wrong makes the cache hit rate
    /// read as zero forever.
    pub fn from_json(usage: &Value) -> Self {
        let number = |keys: &[&str]| -> u32 {
            for key in keys {
                if let Some(n) = usage.get(*key).and_then(Value::as_u64) {
                    return n as u32;
                }
            }
            0
        };
        let cached = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .unwrap_or_else(|| number(&["cached_tokens", "cache_read_input_tokens"]));

        Self {
            input: number(&["prompt_tokens", "input_tokens"]),
            output: number(&["completion_tokens", "output_tokens"]),
            cached,
        }
    }

    /// What share of the input came from cache, 0–100.
    pub fn hit_rate(&self) -> u8 {
        if self.input == 0 {
            return 0;
        }
        ((self.cached as f64 / self.input as f64) * 100.0).round() as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_assistant_turn_that_only_calls_tools_sends_a_null_content() {
        let message = Message::assistant_calling(
            "",
            vec![ToolCall {
                id: "call_1".into(),
                name: "read".into(),
                arguments: r#"{"path":"src/main.rs"}"#.into(),
            }],
        );
        let json = message.as_openai();
        assert!(json["content"].is_null());
        assert_eq!(json["tool_calls"][0]["type"], "function");
        assert_eq!(json["tool_calls"][0]["function"]["name"], "read");
    }

    #[test]
    fn a_tool_result_quotes_the_call_it_answers_and_sends_no_tool_calls_key() {
        let json = Message::tool_result("call_1", "src/main.rs (2 lines)").as_openai();
        assert_eq!(json["role"], "tool");
        assert_eq!(json["tool_call_id"], "call_1");
        assert!(json.get("tool_calls").is_none());
    }

    #[test]
    fn an_ordinary_turn_sends_a_string_content_even_when_empty() {
        let json = Message::user("").as_openai();
        assert_eq!(json["content"], "");
    }

    #[test]
    fn arguments_are_kept_as_the_model_wrote_them() {
        /*
          The bytes go back out on every later turn, and caching is a prefix
          match over them. Re-serialising `{"b":1,"a":2}` as `{"a":2,"b":1}`
          is a different prefix and a silently rewritten cache.
        */
        let raw = r#"{ "b": 1,  "a": 2 }"#;
        let call = ToolCall {
            id: "c".into(),
            name: "read".into(),
            arguments: raw.into(),
        };
        let json = Message::assistant_calling("", vec![call.clone()]).as_openai();
        assert_eq!(json["tool_calls"][0]["function"]["arguments"], raw);
        // And it still parses for dispatch.
        assert_eq!(call.parsed().unwrap()["a"], 2);
    }

    #[test]
    fn empty_arguments_parse_as_an_empty_object() {
        // A tool with no required parameters is called with `""` by several
        // providers, and refusing that would fail a legal call.
        let call = ToolCall {
            id: "c".into(),
            name: "git_status".into(),
            arguments: String::new(),
        };
        assert_eq!(call.parsed().unwrap(), json!({}));
    }

    #[test]
    fn malformed_arguments_are_an_answerable_error() {
        let call = ToolCall {
            id: "c".into(),
            name: "read".into(),
            arguments: "{not json".into(),
        };
        let err = call.parsed().unwrap_err();
        assert!(err.starts_with("read: the arguments were not valid JSON"));
    }

    #[test]
    fn usage_is_read_in_either_dialect() {
        let openai = json!({
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": { "cached_tokens": 800 }
        });
        assert_eq!(
            Usage::from_json(&openai),
            Usage { input: 1000, output: 50, cached: 800 }
        );

        let anthropic = json!({
            "input_tokens": 1000,
            "output_tokens": 50,
            "cache_read_input_tokens": 900
        });
        assert_eq!(
            Usage::from_json(&anthropic),
            Usage { input: 1000, output: 50, cached: 900 }
        );
    }

    #[test]
    fn a_missing_usage_block_is_zeroes_rather_than_a_failure() {
        assert_eq!(Usage::from_json(&json!({})), Usage::default());
        assert_eq!(Usage::default().hit_rate(), 0);
    }

    #[test]
    fn the_hit_rate_is_the_number_a_broken_cache_shows_as_zero() {
        let usage = Usage { input: 1000, output: 10, cached: 850 };
        assert_eq!(usage.hit_rate(), 85);
    }
}
