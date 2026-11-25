//! Jev (typesafe.ai) choosing which tools the model is offered.
//!
//! **Optional, and off until somebody turns it on.** The reasoning is in
//! `docs/figy-code-plan/TASKS.md` section 3 and is short enough to
//! repeat: the window's whole tool set is about 3.8K tokens, read from
//! cache at a tenth of a cent, and tools are the *first* bytes of the
//! request — so a router that changes the set rewrites everything after
//! it at full price. At twenty-four tools the arithmetic is against
//! this. At a hundred it is not, and the seam is here for that day.
//!
//! What makes it safe to switch on anyway is four rules, and three of
//! them are in this file:
//!
//! 1. **The floor is never dropped.** `tools::FLOOR` is unioned into
//!    every answer. A router sees one message; a session is longer than
//!    one message, and a set picked from "explain this file" that
//!    cannot read a second file is a cage rather than a saving.
//! 2. **Any failure offers everything.** Down, slow, rate-limited,
//!    answering nonsense — all of it costs a few hundred milliseconds
//!    and nothing else. This runs on the hot path of a turn and is not
//!    allowed to break one.
//! 3. **The bill comes back with the answer**, so it lands in the
//!    turn's ledger row beside Exa's. A router nobody can see the price
//!    of is the thing this project refuses to ship.
//!
//! The fourth is in `session.rs`: the offered set only ever grows, so a
//! stable answer produces identical bytes and the cache holds.
//!
//! ## What the API is
//!
//! `POST https://api.typesafe.ai/v1/systemone`, bearer auth, one
//! `choice` question whose `criteria` map tool names to their
//! descriptions, with the user's message as the `state`. The answer
//! carries `probabilities` over every name, which is what is wanted
//! here rather than the single `choice` — a turn usually needs more
//! than one tool, and the question being asked is "which of these are
//! plausibly involved", not "which one".
//!
//! Checked against the reference on **2026-11-25**.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::ledger::Surface;
use crate::agent::session::{Pick, Picker};
use crate::agent::tools;

pub const DEFAULT_URL: &str = "https://api.typesafe.ai/v1/systemone";
pub const DEFAULT_MODEL: &str = "jev-latest";

/// Dollars per million input tokens, as published on 2026-11-25.
///
/// Carried as a default rather than a constant in the billing path, for
/// the same reason the model prices are a setting: the one certain
/// thing about a price in a binary is that it is out of date.
pub const DEFAULT_PRICE: f64 = 0.042;

/// Short. A router that takes longer than this has already cost more
/// than it can save, and the fallback — offer everything — is a
/// perfectly good turn.
const TIMEOUT: Duration = Duration::from_secs(6);

/// How likely a tool has to be to make the cut.
///
/// Deliberately low. The cost of including a tool that is not needed is
/// a hundred tokens in the prefix; the cost of leaving out one that is
/// needed is a turn where the model cannot do the thing it was asked.
/// Those are not the same size of mistake, so the threshold is set
/// where it errs toward offering.
const THRESHOLD: f64 = 0.15;

pub struct Jev {
    client: reqwest::Client,
    handle: tokio::runtime::Handle,
    key: String,
    url: String,
    model: String,
    price_per_mtok: f64,
    surface: Surface,
}

impl Jev {
    pub fn new(key: String, handle: tokio::runtime::Handle, surface: Surface) -> Self {
        Self {
            client: reqwest::Client::new(),
            handle,
            key,
            url: DEFAULT_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            price_per_mtok: DEFAULT_PRICE,
            surface,
        }
    }

    pub fn with_model(mut self, model: Option<String>) -> Self {
        if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
            self.model = model;
        }
        self
    }

    pub fn with_price(mut self, price: Option<f64>) -> Self {
        if let Some(price) = price.filter(|p| *p >= 0.0) {
            self.price_per_mtok = price;
        }
        self
    }

    #[cfg(test)]
    fn with_url(mut self, url: String) -> Self {
        self.url = url;
        self
    }

    fn ask(&self, prompt: &str) -> Result<String, String> {
        let body = json!({
            "model": self.model,
            "state": prompt,
            "questions": {
                "tools": {
                    "type": "choice",
                    "instructions":
                        "A coding agent has been asked to do the following in a software \
                         project. Which of these tools will it need? Consider every tool \
                         that is plausibly part of carrying the request out, not only the \
                         first one it would reach for.",
                    "criteria": criteria(self.surface),
                }
            }
        });

        let client = self.client.clone();
        let key = self.key.clone();
        let url = self.url.clone();

        self.handle.block_on(async move {
            let response = client
                .post(&url)
                .bearer_auth(key)
                .timeout(TIMEOUT)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("could not reach the tool picker: {e}"))?;

            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            if !(200..300).contains(&status) {
                return Err(format!("the tool picker answered {status}: {}", first_line(&text)));
            }
            Ok(text)
        })
    }
}

/// `{tool name: what it is for}`, as Jev's `choice` wants it.
///
/// The first sentence of each description rather than all of it. The
/// criteria are sent on every call and billed per input token, and the
/// sentence that says what a tool is *for* is the one the choice turns
/// on — the three that follow are about how to use it, which is the
/// model's problem and not the router's.
fn criteria(surface: Surface) -> Value {
    let mut map = serde_json::Map::new();
    for spec in tools::specs_for(surface) {
        map.insert(spec.name.to_string(), Value::String(first_sentence(spec.description)));
    }
    Value::Object(map)
}

fn first_sentence(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.find(". ") {
        Some(at) => flat[..=at].to_string(),
        None => flat,
    }
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() > 160 {
        line.chars().take(159).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

/// The names worth offering, out of one answer.
///
/// Everything above the threshold, the single `choice` whatever its
/// probability — a router that names one tool and scores it 0.1 still
/// means that one — and the floor, always.
///
/// A malformed answer is `None`, which the caller reads as "offer
/// everything". Nothing here guesses: a router that returns a shape we
/// do not recognise has not answered.
pub fn parse(body: &str, threshold: f64) -> Option<(Vec<String>, u64)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let answer = value.get("answers")?.get("tools")?;
    let probabilities = answer.get("probabilities")?.as_object()?;

    let mut names: BTreeSet<String> = BTreeSet::new();
    for (name, score) in probabilities {
        if score.as_f64().unwrap_or(0.0) >= threshold {
            names.insert(name.clone());
        }
    }
    if let Some(choice) = answer.get("choice").and_then(Value::as_str) {
        names.insert(choice.to_string());
    }
    for name in tools::FLOOR {
        names.insert((*name).to_string());
    }

    let input = value
        .get("usage")
        .and_then(|usage| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some((names.into_iter().collect(), input))
}

impl Picker for Jev {
    fn tools_for(&self, prompt: &str) -> Pick {
        let everything = || {
            Pick::free(
                tools::specs_for(self.surface)
                    .into_iter()
                    .map(|spec| spec.name.to_string())
                    .collect(),
            )
        };

        /*
          Every failure is the same failure: offer everything.

          Unreachable, rate-limited, a shape we do not recognise, an
          answer with nothing above the threshold — all of them mean
          the router did not narrow anything, and the turn should
          proceed exactly as it would without one. The alternative is
          a window where a third-party outage looks like the agent
          forgetting how to edit files.
        */
        let Ok(body) = self.ask(prompt) else {
            return everything();
        };
        let Some((names, input_tokens)) = parse(&body, THRESHOLD) else {
            return everything();
        };
        if names.is_empty() {
            return everything();
        }

        Pick {
            names,
            cost_usd: input_tokens as f64 * self.price_per_mtok / 1_000_000.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(probabilities: Value, input: u64) -> String {
        json!({
            "model": "jev-1.14.0",
            "answers": { "tools": { "type": "choice", "probabilities": probabilities } },
            "usage": { "input_tokens": input, "output_tokens": 0 }
        })
        .to_string()
    }

    #[test]
    fn the_likely_tools_come_back_and_so_does_what_it_cost() {
        let (names, input) = parse(
            &answer(json!({ "read": 0.9, "edit": 0.6, "git_commit": 0.01 }), 1500),
            THRESHOLD,
        )
        .unwrap();
        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"edit".to_string()));
        assert!(!names.contains(&"git_commit".to_string()), "0.01 is a no");
        assert_eq!(input, 1500);
    }

    /// A router sees one message; a session is longer than one message.
    #[test]
    fn the_floor_is_in_every_answer_however_narrow() {
        let (names, _) = parse(&answer(json!({ "edit": 0.9 }), 0), THRESHOLD).unwrap();
        for always in tools::FLOOR {
            assert!(
                names.contains(&always.to_string()),
                "{always} must survive any narrowing"
            );
        }
    }

    /// Naming one and scoring it low still means that one.
    #[test]
    fn the_single_choice_is_kept_whatever_its_probability() {
        let body = json!({
            "answers": {
                "tools": { "type": "choice", "choice": "bash", "probabilities": { "bash": 0.04 } }
            }
        })
        .to_string();
        let (names, _) = parse(&body, THRESHOLD).unwrap();
        assert!(names.contains(&"bash".to_string()));
    }

    #[test]
    fn a_shape_we_do_not_recognise_is_not_an_answer() {
        // Which the caller reads as "offer everything" rather than as
        // "offer nothing", because those differ by a broken turn.
        assert!(parse("not json", THRESHOLD).is_none());
        assert!(parse(r#"{"answers":{}}"#, THRESHOLD).is_none());
        assert!(parse(r#"{"answers":{"tools":{"type":"choice"}}}"#, THRESHOLD).is_none());
    }

    #[test]
    fn usage_that_is_missing_is_zero_rather_than_a_guess() {
        let body = r#"{"answers":{"tools":{"type":"choice","probabilities":{"read":0.9}}}}"#;
        let (_, input) = parse(body, THRESHOLD).unwrap();
        assert_eq!(input, 0);
    }

    /// The criteria are billed per input token on every call, so they
    /// carry the sentence that says what a tool is *for* and not the
    /// three that say how to use it.
    #[test]
    fn the_criteria_are_one_sentence_per_tool() {
        let map = criteria(Surface::Window);
        let object = map.as_object().unwrap();
        assert_eq!(object.len(), tools::specs().len());

        let read = object["read"].as_str().unwrap();
        assert!(read.ends_with('.'), "{read}");
        assert!(
            read.len() < 200,
            "a criterion is a sentence, not a manual: {read}"
        );
    }

    #[test]
    fn a_description_with_no_full_stop_is_taken_whole() {
        assert_eq!(first_sentence("Lists what is in a folder"), "Lists what is in a folder");
        assert_eq!(first_sentence("One. Two."), "One.");
        assert_eq!(first_sentence("  spread   over\n lines  "), "spread over lines");
    }
}
