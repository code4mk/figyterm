//! Looking things up outside the project.
//!
//! Exa, behind a trait. Two calls — `/search` and `/contents` — checked
//! against the reference on **2026-11-25**, and worth writing down because
//! the field names are the kind that get guessed wrong: `numResults`, not
//! `num_results`; the extract comes back under `contents.text` rather than
//! at the top level; and `score`, which every other search API returns, is
//! **not** in Exa's result schema.
//!
//! ## Why a search tool is not a browser
//!
//! A documentation page is forty thousand tokens of HTML and three
//! thousand of text, and the agent is reading it for one function
//! signature. Exa returns the text already extracted, which is the whole
//! reason to use a search API rather than fetching pages and parsing them
//! here: no HTML parser, no readability heuristic, no JavaScript.
//!
//! Both calls are **`net` class**, so they are asked about every time. A
//! request to a URL the model composed is not something to auto-approve on
//! the strength of having approved an edit.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

const SEARCH_URL: &str = "https://api.exa.ai/search";
const CONTENTS_URL: &str = "https://api.exa.ai/contents";

/// Long enough for a deep search, short enough that a turn does not hang on
/// one. Exa's own queue headers suggest seconds rather than tens of them.
const TIMEOUT: Duration = Duration::from_secs(45);

/// One result, trimmed to what a model can act on.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub title: String,
    pub url: String,
    pub published: Option<String>,
    /// A short extract. Not the page — that is what `fetch_url` is for.
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub text: String,
}

/// What the two tools call. A trait so they can be tested without a key.
pub trait Web: Send + Sync {
    fn search(&self, query: &str, limit: usize) -> Result<(Vec<Found>, f64), String>;
    fn fetch(&self, url: &str, max_chars: usize) -> Result<(Page, f64), String>;
}

/* ─── Parsing, which is the half worth testing ───────────────────────────── */

#[derive(Deserialize)]
struct ExaResult {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    published_date: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    highlights: Option<Vec<String>>,
}

/// Exa's envelope, in either shape it comes back in.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ExaBody {
    #[serde(default)]
    results: Vec<ExaResult>,
    #[serde(default)]
    cost_dollars: Option<CostDollars>,
    /// Per-URL outcome, on `/contents` only.
    #[serde(default)]
    statuses: Option<Vec<Value>>,
}

#[derive(Deserialize, Default)]
struct CostDollars {
    #[serde(default)]
    total: f64,
}

/// What a result is worth showing as its one or two lines of context.
///
/// Highlights first: they are the parts of the page that matched, which is
/// a better answer to "is this the right page" than its opening sentence.
fn snippet_of(result: &ExaResult, max: usize) -> String {
    let raw = match &result.highlights {
        Some(items) if !items.is_empty() => items.join(" … "),
        _ => result.text.clone().unwrap_or_default(),
    };
    let flattened = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= max {
        return flattened;
    }
    let cut: String = flattened.chars().take(max).collect();
    format!("{cut}…")
}

/// The search response, as results.
pub fn parse_search(body: &str, snippet_chars: usize) -> Result<(Vec<Found>, f64), String> {
    let parsed: ExaBody =
        serde_json::from_str(body).map_err(|e| format!("Exa sent something unreadable: {e}"))?;
    let cost = parsed.cost_dollars.as_ref().map(|c| c.total).unwrap_or(0.0);

    let found = parsed
        .results
        .iter()
        // A result with no URL is not a result; it is a row we cannot cite.
        .filter(|r| r.url.is_some())
        .map(|r| Found {
            title: r.title.clone().unwrap_or_else(|| "(untitled)".into()),
            url: r.url.clone().unwrap_or_default(),
            published: r.published_date.clone(),
            snippet: snippet_of(r, snippet_chars),
        })
        .collect();
    Ok((found, cost))
}

/// The contents response, as one page.
pub fn parse_contents(body: &str, url: &str) -> Result<(Page, f64), String> {
    let parsed: ExaBody =
        serde_json::from_str(body).map_err(|e| format!("Exa sent something unreadable: {e}"))?;
    let cost = parsed.cost_dollars.as_ref().map(|c| c.total).unwrap_or(0.0);

    let Some(first) = parsed.results.into_iter().next() else {
        // `/contents` reports a per-URL failure in `statuses` rather than
        // as an HTTP error, so an empty result list usually has a reason in
        // it worth repeating.
        let why = parsed
            .statuses
            .as_ref()
            .and_then(|s| s.first())
            .and_then(|s| s.get("error"))
            .and_then(|e| e.get("tag"))
            .and_then(Value::as_str)
            .unwrap_or("nothing came back");
        return Err(format!("could not read {url}: {why}"));
    };

    let text = first.text.unwrap_or_default();
    if text.trim().is_empty() {
        return Err(format!("{url} has no readable text — it may be a PDF or an app"));
    }
    Ok((
        Page {
            url: first.url.unwrap_or_else(|| url.to_string()),
            title: first.title.unwrap_or_else(|| url.to_string()),
            text,
        },
        cost,
    ))
}

/// An HTTP failure, in a sentence with a next step where there is one.
pub fn explain(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| v.get("tag").and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(160).collect());

    match status {
        401 | 403 => format!("Exa refused the key ({status}): {detail}"),
        402 => format!("Exa says the account is out of credit ({status}): {detail}"),
        429 => format!("Exa is rate limiting ({status}): {detail}"),
        500..=599 => format!("Exa is having trouble ({status}): {detail}"),
        _ => format!("Exa returned {status}: {detail}"),
    }
}

/* ─── The client ─────────────────────────────────────────────────────────── */

pub struct Exa {
    key: String,
    client: reqwest::Client,
    /// The runtime to run the request on.
    ///
    /// The tools are synchronous and run on a blocking thread — see
    /// `session.rs`, which dispatches every tool through `spawn_blocking` —
    /// so this blocks on the handle rather than being `async` itself.
    /// `Handle::block_on` is allowed from a blocking thread and panics
    /// inside an async one, which is exactly the distinction we want
    /// enforced.
    handle: tokio::runtime::Handle,
}

impl Exa {
    pub fn new(key: String, handle: tokio::runtime::Handle) -> Self {
        Self {
            key,
            client: reqwest::Client::new(),
            handle,
        }
    }

    fn post(&self, url: &str, body: Value) -> Result<String, String> {
        let client = self.client.clone();
        // `x-api-key` with the raw key. Exa accepts a bearer token too; the
        // header is what its own examples use and what its errors mention.
        let key = self.key.clone();
        let url = url.to_string();

        self.handle.block_on(async move {
            let response = client
                .post(&url)
                .header("x-api-key", key)
                .timeout(TIMEOUT)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("could not reach Exa: {e}"))?;

            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            if !(200..300).contains(&status) {
                return Err(explain(status, &text));
            }
            Ok(text)
        })
    }
}

impl Web for Exa {
    fn search(&self, query: &str, limit: usize) -> Result<(Vec<Found>, f64), String> {
        /*
          The extract is asked for in the same call.

          `contents.text` with a small `maxCharacters` is one round trip
          instead of two, and the extract is what decides whether a result
          is worth fetching in full. Four hundred characters is about a
          hundred tokens per result — enough to judge, far short of the
          page.
        */
        let body = json!({
            "query": query,
            "numResults": limit.clamp(1, 25),
            "type": "auto",
            "contents": {
                "text": { "maxCharacters": 400 },
                "highlights": true
            }
        });
        parse_search(&self.post(SEARCH_URL, body)?, 300)
    }

    fn fetch(&self, url: &str, max_chars: usize) -> Result<(Page, f64), String> {
        let body = json!({
            "urls": [url],
            "text": { "maxCharacters": max_chars }
        });
        parse_contents(&self.post(CONTENTS_URL, body)?, url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_search_response_becomes_results() {
        let body = json!({
            "requestId": "r1",
            "results": [{
                "title": "The tokio runtime",
                "url": "https://docs.rs/tokio",
                "publishedDate": "2026-01-02T00:00:00.000Z",
                "text": "Tokio is an asynchronous runtime for Rust."
            }],
            "costDollars": { "total": 0.005 }
        })
        .to_string();

        let (found, cost) = parse_search(&body, 300).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].url, "https://docs.rs/tokio");
        assert_eq!(found[0].title, "The tokio runtime");
        assert!(found[0].snippet.starts_with("Tokio is an asynchronous"));
        assert!((cost - 0.005).abs() < 1e-9);
    }

    #[test]
    fn highlights_are_preferred_to_the_opening_sentence() {
        // They are the parts that matched, which is a better answer to "is
        // this the right page" than whatever the page opens with.
        let body = json!({
            "results": [{
                "title": "t", "url": "https://x",
                "text": "Boilerplate about cookies and navigation.",
                "highlights": ["spawn_blocking runs a closure on a thread pool"]
            }]
        })
        .to_string();
        let (found, _) = parse_search(&body, 300).unwrap();
        assert!(found[0].snippet.contains("spawn_blocking"));
    }

    #[test]
    fn a_snippet_is_flattened_and_cut() {
        let body = json!({
            "results": [{ "title": "t", "url": "https://x",
                          "text": format!("line one\n\n   line two {}", "x".repeat(500)) }]
        })
        .to_string();
        let (found, _) = parse_search(&body, 40).unwrap();
        assert!(!found[0].snippet.contains('\n'), "newlines waste the line");
        assert!(found[0].snippet.ends_with('…'));
        assert_eq!(found[0].snippet.chars().count(), 41);
    }

    #[test]
    fn a_result_with_no_url_is_dropped() {
        // There is nothing to cite and nothing to fetch.
        let body = json!({ "results": [{ "title": "t" }, { "title": "u", "url": "https://x" }] })
            .to_string();
        let (found, _) = parse_search(&body, 100).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_missing_title_does_not_lose_the_result() {
        let body = json!({ "results": [{ "url": "https://x" }] }).to_string();
        let (found, _) = parse_search(&body, 100).unwrap();
        assert_eq!(found[0].title, "(untitled)");
    }

    #[test]
    fn no_results_is_an_empty_list_rather_than_an_error() {
        let (found, _) = parse_search(&json!({ "results": [] }).to_string(), 100).unwrap();
        assert!(found.is_empty());
    }

    #[test]
    fn a_fetched_page_comes_back_as_text() {
        let body = json!({
            "results": [{ "title": "Docs", "url": "https://x", "text": "The real content." }],
            "costDollars": { "total": 0.001 }
        })
        .to_string();
        let (page, cost) = parse_contents(&body, "https://x").unwrap();
        assert_eq!(page.title, "Docs");
        assert_eq!(page.text, "The real content.");
        assert!(cost > 0.0);
    }

    #[test]
    fn a_page_that_would_not_crawl_says_why() {
        // `/contents` reports this in `statuses`, with a 200.
        let body = json!({
            "results": [],
            "statuses": [{ "id": "https://x", "status": "error",
                           "error": { "tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404 } }]
        })
        .to_string();
        let error = parse_contents(&body, "https://x").unwrap_err();
        assert!(error.contains("CRAWL_NOT_FOUND"));
    }

    #[test]
    fn a_page_with_no_text_is_named_as_such() {
        let body = json!({ "results": [{ "url": "https://x/a.pdf", "text": "   " }] }).to_string();
        let error = parse_contents(&body, "https://x/a.pdf").unwrap_err();
        assert!(error.contains("no readable text"));
    }

    #[test]
    fn failures_say_what_to_do_about_them() {
        assert!(explain(401, r#"{"error":"invalid api key","tag":"UNAUTHORIZED"}"#)
            .contains("refused the key"));
        assert!(explain(402, "{}").contains("out of credit"));
        assert!(explain(429, "{}").contains("rate limiting"));
        assert!(explain(503, "upstream").contains("having trouble"));
    }

    #[test]
    fn an_unreadable_body_is_an_error_rather_than_a_panic() {
        assert!(parse_search("not json", 100).is_err());
        assert!(parse_contents("not json", "https://x").is_err());
    }
}
