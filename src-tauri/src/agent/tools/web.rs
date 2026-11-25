//! `search_web` and `fetch_url` — the two that leave the machine.
//!
//! Both are **`net` class**, which means asked about every time, with the
//! query or the URL shown. `acceptEdits` means edits; a request to an
//! address the model composed is not covered by having approved one.
//!
//! The pair is deliberate and the order matters. `search_web` returns
//! titles, URLs and a short extract — enough to decide which page is worth
//! having — and `fetch_url` brings back one page. An agent that fetched
//! every result would spend a session's budget confirming that four of the
//! five were the wrong page.

use serde_json::{json, Value};

use super::output::{cap_lines, truncation_note};
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};

const DEFAULT_RESULTS: usize = 5;
const MAX_RESULTS: usize = 15;

/// Characters of a page handed back by `fetch_url`.
///
/// About 3,000 tokens: a long reference page's worth, and a number that is
/// re-sent on every later turn of the session. Anything bigger is a
/// subscription nobody meant to take out.
const PAGE_CHARS: usize = 12_000;

/// Lines of it, after which the rest is cut with a note.
const PAGE_LINES: usize = 200;

pub struct SearchWeb;

impl Tool for SearchWeb {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "search_web",
            description: "Search the web and return titles, URLs and a short extract of \
                each result. Use it for things outside the project — a library's API, an \
                error message nobody here wrote, what a version changed. Read one of the \
                results with `fetch_url` when the extract is not enough.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description":
                            "What to look for, as a sentence rather than keywords — the \
                             search is semantic."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many results. Default 5, maximum 15."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            class: Class::Net,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let query = arg_str(args, "query", "search_web")?;
        let limit = arg_usize(args, "limit", DEFAULT_RESULTS, MAX_RESULTS);

        let (found, cost) = ctx
            .web()?
            .search(&query, limit)
            .map_err(|e| format!("search_web: {e}"))?;

        if found.is_empty() {
            return Ok(ToolOutput::text(format!("No results for “{query}”.")));
        }

        let mut text = format!("{} results for “{query}”\n", found.len());
        for result in &found {
            text.push_str(&format!("\n{}\n{}\n", result.title, result.url));
            if let Some(published) = &result.published {
                // The date, trimmed to the day: an agent asking about a
                // library wants to know whether it is reading last year.
                text.push_str(&format!("{}  ", published.split('T').next().unwrap_or(published)));
            }
            if !result.snippet.is_empty() {
                text.push_str(&result.snippet);
                text.push('\n');
            }
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "query": query,
            "results": found.len(),
            "costUsd": cost,
        })))
    }
}

pub struct FetchUrl;

impl Tool for FetchUrl {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "fetch_url",
            description: "Read one web page as text. The page is extracted and stripped of \
                markup, so this is cheap compared with the HTML — but it is still a long \
                result that stays in the conversation, so fetch the page you need rather \
                than every result.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The full URL, as `search_web` returned it."
                    }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
            class: Class::Net,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &Value) -> Result<ToolOutput, ToolError> {
        let url = arg_str(args, "url", "fetch_url")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!("fetch_url: {url} is not an http(s) URL"));
        }

        let (page, cost) = ctx
            .web()?
            .fetch(&url, PAGE_CHARS)
            .map_err(|e| format!("fetch_url: {e}"))?;

        let lines: Vec<String> = page
            .text
            .lines()
            .map(str::trim_end)
            .map(str::to_string)
            .collect();
        let total = lines.len();
        let (kept, note) = cap_lines(lines, PAGE_LINES, "search for the part you need instead");

        let mut text = format!("{}\n{}\n\n{}\n", page.title, page.url, kept.join("\n"));
        if let Some(note) = note {
            text.push_str(&note);
            text.push('\n');
        } else if total == 0 {
            text.push_str(&truncation_note(0, "line", "the page was empty"));
        }

        Ok(ToolOutput::text(text).with_detail(json!({
            "url": page.url,
            "title": page.title,
            "lines": total,
            "costUsd": cost,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::web::{Found, Page, Web};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeWeb {
        results: Vec<Found>,
        page: Option<Page>,
        error: Option<String>,
        asked: Mutex<Vec<String>>,
    }

    impl Web for FakeWeb {
        fn search(&self, query: &str, limit: usize) -> Result<(Vec<Found>, f64), String> {
            self.asked.lock().unwrap().push(format!("{query}|{limit}"));
            if let Some(error) = &self.error {
                return Err(error.clone());
            }
            Ok((self.results.clone(), 0.004))
        }
        fn fetch(&self, url: &str, max: usize) -> Result<(Page, f64), String> {
            self.asked.lock().unwrap().push(format!("{url}|{max}"));
            if let Some(error) = &self.error {
                return Err(error.clone());
            }
            match &self.page {
                Some(page) => Ok((page.clone(), 0.001)),
                None => Err("nothing scripted".into()),
            }
        }
    }

    fn ctx(web: Arc<FakeWeb>) -> ToolContext {
        ToolContext::new(PathBuf::from(std::env::temp_dir())).with_web(web)
    }

    fn result(title: &str, url: &str) -> Found {
        Found {
            title: title.into(),
            url: url.into(),
            published: Some("2026-02-03T10:00:00.000Z".into()),
            snippet: "What the page says about it.".into(),
        }
    }

    #[test]
    fn results_come_back_as_titles_urls_and_an_extract() {
        let web = Arc::new(FakeWeb {
            results: vec![result("Tokio", "https://docs.rs/tokio")],
            ..FakeWeb::default()
        });
        let out = SearchWeb
            .call(&ctx(Arc::clone(&web)), &json!({ "query": "rust async runtime" }))
            .unwrap();

        assert!(out.text.contains("1 results"));
        assert!(out.text.contains("https://docs.rs/tokio"));
        assert!(out.text.contains("What the page says"));
        // Trimmed to the day: the year is the part that matters.
        assert!(out.text.contains("2026-02-03"));
        assert!(!out.text.contains("10:00:00"));
    }

    #[test]
    fn the_limit_is_passed_through_and_clamped() {
        let web = Arc::new(FakeWeb::default());
        let _ = SearchWeb.call(
            &ctx(Arc::clone(&web)),
            &json!({ "query": "x", "limit": 999 }),
        );
        assert_eq!(web.asked.lock().unwrap()[0], "x|15");
    }

    #[test]
    fn nothing_found_is_an_answer() {
        let web = Arc::new(FakeWeb::default());
        let out = SearchWeb.call(&ctx(web), &json!({ "query": "zzzz" })).unwrap();
        assert!(out.text.contains("No results"));
    }

    #[test]
    fn a_page_is_returned_with_its_title_and_url() {
        let web = Arc::new(FakeWeb {
            page: Some(Page {
                url: "https://x/docs".into(),
                title: "Docs".into(),
                text: "First line.\nSecond line.".into(),
            }),
            ..FakeWeb::default()
        });
        let out = FetchUrl
            .call(&ctx(web), &json!({ "url": "https://x/docs" }))
            .unwrap();
        assert!(out.text.starts_with("Docs\nhttps://x/docs"));
        assert!(out.text.contains("Second line."));
    }

    #[test]
    fn a_long_page_is_capped_and_says_so() {
        // The number that would otherwise be re-sent on every later turn.
        let long = (0..1000).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let web = Arc::new(FakeWeb {
            page: Some(Page {
                url: "https://x".into(),
                title: "Long".into(),
                text: long,
            }),
            ..FakeWeb::default()
        });
        let out = FetchUrl.call(&ctx(web), &json!({ "url": "https://x" })).unwrap();
        assert!(out.text.contains("800 more lines"));
        assert!(!out.text.contains("line 999"));
    }

    #[test]
    fn something_that_is_not_a_url_is_refused_before_the_request() {
        let web = Arc::new(FakeWeb::default());
        let err = FetchUrl
            .call(&ctx(Arc::clone(&web)), &json!({ "url": "docs.rs/tokio" }))
            .unwrap_err();
        assert!(err.contains("not an http(s) URL"));
        assert!(web.asked.lock().unwrap().is_empty(), "nothing should have been sent");
    }

    #[test]
    fn a_provider_failure_is_reported_with_its_own_words() {
        let web = Arc::new(FakeWeb {
            error: Some("Exa refused the key (401)".into()),
            ..FakeWeb::default()
        });
        let err = SearchWeb.call(&ctx(web), &json!({ "query": "x" })).unwrap_err();
        assert!(err.contains("refused the key"));
    }

    #[test]
    fn with_no_key_configured_the_tools_say_so_rather_than_failing_oddly() {
        let bare = ToolContext::new(PathBuf::from(std::env::temp_dir()));
        let err = SearchWeb.call(&bare, &json!({ "query": "x" })).unwrap_err();
        assert!(err.contains("Exa"), "got: {err}");
    }

    #[test]
    fn both_leave_the_machine_and_are_classed_as_such() {
        // The class is what makes the window ask every time, with the query
        // or the URL on the card.
        assert_eq!(SearchWeb.spec().class, Class::Net);
        assert_eq!(FetchUrl.spec().class, Class::Net);
    }
}
