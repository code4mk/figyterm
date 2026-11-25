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
use crate::agent::session::{BoxFuture, Pick, Picker};
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

/// How much of the probability mass to keep.
///
/// **Not a threshold**, and the difference cost a real answer. Jev's
/// `probabilities` are a distribution over *one* choice — they sum to
/// one — so a fixed cut-off means something different depending on how
/// many tools are plausible. Asked to "add a timeout and run the
/// tests" it answered `bash 0.37, grep 0.22, read 0.21, edit 0.13`,
/// and a 0.15 cut-off dropped `edit` from a task whose whole point was
/// editing a file. Spread the same confidence over ten plausible tools
/// and a fixed cut-off drops all of them.
///
/// So: take them in order until this much of the mass is accounted
/// for. It adapts to how sure the answer is, which is what a
/// distribution is for.
///
/// Set high, because the two mistakes are not the same size. An extra
/// tool costs a hundred tokens in the prefix. A missing one costs a
/// turn where the model cannot do what it was asked.
const KEEP_MASS: f64 = 0.9;

pub struct Jev {
    client: reqwest::Client,
    key: String,
    url: String,
    model: String,
    price_per_mtok: f64,
    surface: Surface,
}

impl Jev {
    pub fn new(key: String, surface: Surface) -> Self {
        Self {
            client: reqwest::Client::new(),
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

    /// Awaited, never blocked on.
    ///
    /// This is called from inside the turn, which is async code on a
    /// runtime worker. The first version used `Handle::block_on` here
    /// and panicked with "cannot start a runtime from within a
    /// runtime" on the first message anybody sent with the router
    /// switched on — taking the turn's task with it, so the window sat
    /// waiting for an event that was never coming. Tools get away with
    /// blocking clients because they go through `spawn_blocking`. This
    /// does not.
    async fn ask(&self, prompt: &str) -> Result<String, String> {
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

        let response = self
            .client
            .post(&self.url)
            .bearer_auth(&self.key)
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
/// The likeliest tools until `keep_mass` of the probability is
/// accounted for, the single `choice` whatever its probability — a
/// router that names one tool and scores it 0.1 still means that one —
/// and the floor, always.
///
/// A malformed answer is `None`, which the caller reads as "offer
/// everything". Nothing here guesses: a router that returns a shape we
/// do not recognise has not answered.
pub fn parse(body: &str, keep_mass: f64) -> Option<(Vec<String>, u64)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let answer = value.get("answers")?.get("tools")?;
    let probabilities = answer.get("probabilities")?.as_object()?;

    // Likeliest first, and ties broken by name so the same answer
    // always produces the same set — which is what lets an unchanged
    // pick leave the prefix untouched.
    let mut ranked: Vec<(&String, f64)> = probabilities
        .iter()
        .map(|(name, score)| (name, score.as_f64().unwrap_or(0.0)))
        .filter(|(_, score)| *score > 0.0)
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut mass = 0.0;
    for (name, score) in ranked {
        if mass >= keep_mass {
            break;
        }
        names.insert(name.clone());
        mass += score;
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
    fn tools_for<'a>(&'a self, prompt: &'a str) -> BoxFuture<'a, Pick> {
        Box::pin(async move { self.pick(prompt).await })
    }
}

impl Jev {
    /// One call, with the failure kept rather than swallowed.
    ///
    /// `tools_for` turns every failure into "offer everything", which
    /// is right during a turn and useless when the question is
    /// whether the thing works at all. This is the same call with the
    /// error still attached, for the button that asks.
    pub async fn check(&self, prompt: &str) -> Result<Pick, String> {
        let body = self.ask(prompt).await?;
        let (names, input_tokens) =
            parse(&body, KEEP_MASS).ok_or_else(|| format!("could not read the answer: {}", first_line(&body)))?;
        Ok(Pick {
            names,
            cost_usd: input_tokens as f64 * self.price_per_mtok / 1_000_000.0,
            note: None,
        })
    }

    async fn pick(&self, prompt: &str) -> Pick {
        let total = tools::specs_for(self.surface).len();
        /*
          A fallback that says so, where somebody can read it.

          Quiet during the turn — an outage should cost a few hundred
          milliseconds and nothing else — but not invisible. `/context`
          shows this line, which is the difference between "the router
          is not helping" and "the router is not running". Working
          that out from the transcript is impossible, because the two
          look identical.
        */
        let everything = |why: String| Pick {
            names: tools::specs_for(self.surface)
                .into_iter()
                .map(|spec| spec.name.to_string())
                .collect(),
            cost_usd: 0.0,
            note: Some(format!("every tool — {why}")),
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
        let body = match self.ask(prompt).await {
            Ok(body) => body,
            Err(error) => {
                log::warn!("tool picker: {error} — offering every tool");
                return everything(error);
            }
        };
        let Some((names, input_tokens)) = parse(&body, KEEP_MASS) else {
            let why = format!("could not read its answer: {}", first_line(&body));
            log::warn!("tool picker: {why}");
            return everything(why);
        };
        if names.is_empty() {
            log::warn!("tool picker: chose nothing — offering every tool");
            return everything("it chose nothing".into());
        }
        log::info!("tool picker: {} tools, {input_tokens} tokens in", names.len());

        let cost_usd = input_tokens as f64 * self.price_per_mtok / 1_000_000.0;
        Pick {
            note: Some(format!(
                "{} of {total} chosen by {} · {input_tokens} tokens in",
                names.len(),
                self.model
            )),
            names,
            cost_usd,
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

    /*
      The bug this file shipped with, as a test.

      With the router switched on, the first message sent — "hi" —
      produced nothing at all. No answer, no error, no event, and a
      composer that stayed disabled. `Handle::block_on` inside the
      turn's own async task panics with "cannot start a runtime from
      within a runtime", which took the task down before a single
      event had been emitted.

      Two things are asserted. It does not panic, and an endpoint that
      cannot be reached answers with every tool rather than none — the
      fallback that means a router is never the reason a turn fails.
    */
    #[tokio::test(flavor = "current_thread")]
    async fn a_router_that_cannot_be_reached_offers_everything_and_does_not_panic() {
        let jev = Jev::new("nope".into(), Surface::Window)
            // Nothing listens here, so `send` fails rather than hangs.
            .with_url("http://127.0.0.1:1/v1/systemone".into());

        let pick = jev.tools_for("hi").await;
        assert_eq!(pick.names.len(), tools::specs().len(), "every tool, not none");
        assert_eq!(pick.cost_usd, 0.0, "a call that did not happen is not billed");
    }

    #[test]
    fn the_likely_tools_come_back_and_so_does_what_it_cost() {
        let (names, input) = parse(
            &answer(json!({ "read": 0.55, "edit": 0.4, "git_commit": 0.05 }), 1500),
            KEEP_MASS,
        )
        .unwrap();
        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"edit".to_string()));
        assert!(
            !names.contains(&"git_commit".to_string()),
            "the tail past the mass is dropped"
        );
        assert_eq!(input, 1500);
    }

    /*
      The answer the real endpoint gave, and the reason this is a
      nucleus rather than a threshold.

      "Add a timeout to the retry and run the tests" came back as
      `bash 0.37, grep 0.22, read 0.21, edit 0.13` — a distribution
      over one choice, summing to one. A flat 0.15 cut-off dropped
      `edit` from a task whose whole point was editing a file, which
      is the exact failure a tool picker is not allowed to have.
    */
    #[test]
    fn a_spread_answer_keeps_the_tool_the_task_actually_needs() {
        let real = json!({
            "ask_user": 0.0, "bash": 0.37, "bash_kill": 0.0, "bash_output": 0.0,
            "definition": 0.02, "delete": 0.0, "diagnostics": 0.0, "edit": 0.13,
            "fetch_url": 0.0, "git_blame": 0.0, "git_commit": 0.0, "git_diff": 0.0,
            "git_log": 0.0, "git_status": 0.0, "grep": 0.22, "ls": 0.03, "move": 0.0,
            "plan": 0.0, "read": 0.21, "references": 0.01, "search_web": 0.0,
            "task": 0.0, "todo_write": 0.01, "write": 0.0
        });
        let (names, _) = parse(&answer(real, 974), KEEP_MASS).unwrap();

        assert!(names.contains(&"edit".to_string()), "it was asked to edit a file");
        assert!(names.contains(&"bash".to_string()), "and to run the tests");
        assert!(names.contains(&"grep".to_string()));
        assert!(names.contains(&"read".to_string()));
        // And it is still a narrowing, not a surrender.
        assert!(names.len() < tools::specs().len() / 2, "{names:?}");
        assert!(!names.contains(&"git_commit".to_string()));
    }

    /// Spread thin enough and everything plausible survives, which is
    /// the behaviour a fixed cut-off got exactly backwards.
    #[test]
    fn an_answer_with_no_opinion_keeps_most_of_what_it_listed() {
        let flat = json!({
            "read": 0.1, "edit": 0.1, "grep": 0.1, "bash": 0.1, "ls": 0.1,
            "write": 0.1, "move": 0.1, "delete": 0.1, "git_log": 0.1, "task": 0.1
        });
        let (names, _) = parse(&answer(flat, 0), KEEP_MASS).unwrap();
        assert!(names.len() >= 9, "nine tenths of the mass is nine tools: {names:?}");
    }

    /// A router sees one message; a session is longer than one message.
    #[test]
    fn the_floor_is_in_every_answer_however_narrow() {
        let (names, _) = parse(&answer(json!({ "edit": 0.9 }), 0), KEEP_MASS).unwrap();
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
        let (names, _) = parse(&body, KEEP_MASS).unwrap();
        assert!(names.contains(&"bash".to_string()));
    }

    #[test]
    fn a_shape_we_do_not_recognise_is_not_an_answer() {
        // Which the caller reads as "offer everything" rather than as
        // "offer nothing", because those differ by a broken turn.
        assert!(parse("not json", KEEP_MASS).is_none());
        assert!(parse(r#"{"answers":{}}"#, KEEP_MASS).is_none());
        assert!(parse(r#"{"answers":{"tools":{"type":"choice"}}}"#, KEEP_MASS).is_none());
    }

    #[test]
    fn usage_that_is_missing_is_zero_rather_than_a_guess() {
        let body = r#"{"answers":{"tools":{"type":"choice","probabilities":{"read":0.9}}}}"#;
        let (_, input) = parse(body, KEEP_MASS).unwrap();
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

    /*
      Against the real endpoint, by hand.

      `#[ignore]`, because a test that needs a key and a network is not
      a test anybody should have to have. It is here because every
      other test in this file checks our *parsing* of a shape taken
      from the documentation, and the documentation is not the API.
      One real call settles whether the request we build is accepted,
      whether the answer is the shape we read, and — the question that
      prompted it — whether anything reaches the dashboard at all.

          TYPESAFE_API_KEY=… cargo test --lib real_api -- --ignored --nocapture
    */
    #[tokio::test]
    #[ignore = "needs a key and a network"]
    async fn against_the_real_api() {
        let Ok(key) = std::env::var("TYPESAFE_API_KEY") else {
            panic!("set TYPESAFE_API_KEY");
        };
        let jev = Jev::new(key, Surface::Window);

        let raw = jev
            .ask("add a timeout to the retry in the http client and run the tests")
            .await;
        match &raw {
            Ok(body) => println!("\n--- raw answer ---\n{body}\n"),
            Err(error) => println!("\n--- refused ---\n{error}\n"),
        }

        let body = raw.expect("the endpoint answered");
        let parsed = parse(&body, KEEP_MASS);
        println!("--- parsed ---\n{parsed:?}\n");
        let (names, input) = parsed.expect("the answer is the shape we read");
        println!("picked {} of {}: {names:?}", names.len(), tools::specs().len());
        println!("billed {input} input tokens");
    }

    #[test]
    fn a_description_with_no_full_stop_is_taken_whole() {
        assert_eq!(first_sentence("Lists what is in a folder"), "Lists what is in a folder");
        assert_eq!(first_sentence("One. Two."), "One.");
        assert_eq!(first_sentence("  spread   over\n lines  "), "spread over lines");
    }
}
