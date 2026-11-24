//! `grep(pattern, glob, limit)` — where something is, not what is around it.
//!
//! The second rule in `TOOLS.md`: **search returns locations, not content.**
//! A tool that hands back three lines of context per hit has handed back a
//! small file for a question the model usually answers from the path alone —
//! and then pays for it on every remaining turn. `path:line: the matched
//! line` is enough to choose, and `read` is one call away for the two hits
//! that turn out to matter.
//!
//! The walk itself is `operations::search_files`, which the editor's project
//! search already uses: it honours `.gitignore`, skips binaries and streams
//! its hits through a callback that can stop it. Stopping it at the cap is
//! the difference between a capped *result* and a capped *walk* — the second
//! is the one that does not spend ten seconds finding matches nobody is
//! shown.

use std::collections::BTreeMap;

use serde_json::json;

use super::output::{clip_line, truncation_note};
use super::{arg_str, arg_usize, Class, Tool, ToolContext, ToolError, ToolOutput, ToolSpec};
use crate::agent::workspace::display_path;
use crate::filesystem::operations::{self, SearchOptions};

const DEFAULT_LIMIT: usize = 40;
const MAX_LIMIT: usize = 200;

/// Matched lines are already trimmed by the walker; this keeps a long one
/// from being the whole result.
const MAX_LINE: usize = 200;

/// How many hits the walk is allowed to find before it is told to stop.
///
/// Higher than the display cap so the count can say "and 300 more" honestly,
/// bounded so a one-letter pattern across a monorepo does not run for a
/// minute to produce a number nobody reads.
const SCAN_CEILING: usize = 2_000;

pub struct Grep;

impl Tool for Grep {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "grep",
            description: "Search the project's text files for a pattern and return the \
                locations — `path:line: matched line` — grouped by file. Respects \
                .gitignore and skips binaries. Use this to find where something is, then \
                `read` the ranges that matter. Searching for a symbol? `definition` and \
                `references` are exact where this is textual.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Text to find, or a regular expression when regex is true."
                    },
                    "glob": {
                        "type": "string",
                        "description":
                            "Restrict to paths matching this glob, e.g. `src/**/*.ts` or \
                             `*.rs`. Matched against the path relative to the project root."
                    },
                    "regex": {
                        "type": "boolean",
                        "description": "Treat the pattern as a regular expression. Default false."
                    },
                    "case_sensitive": {
                        "type": "boolean",
                        "description": "Default false."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum hits to return. Default 40, maximum 200."
                    }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
            class: Class::Read,
        }
    }

    fn call(&self, ctx: &ToolContext, args: &serde_json::Value) -> Result<ToolOutput, ToolError> {
        let pattern = arg_str(args, "pattern", "grep")?;
        let limit = arg_usize(args, "limit", DEFAULT_LIMIT, MAX_LIMIT);
        let glob = args
            .get("glob")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|g| !g.trim().is_empty());

        let opts = SearchOptions {
            case_sensitive: super::arg_bool(args, "case_sensitive"),
            regex: super::arg_bool(args, "regex"),
            whole_word: false,
            include_hidden: false,
            include_ignored: false,
        };

        let mut hits: Vec<(String, u32, String)> = Vec::new();
        let mut seen = 0usize;

        operations::search_files(ctx.root(), &pattern, &opts, &mut |m| {
            let shown = display_path(ctx.root(), std::path::Path::new(&m.path));
            if let Some(glob) = &glob {
                if !glob_matches(glob, &shown) {
                    return true;
                }
            }
            seen += 1;
            if hits.len() < limit {
                hits.push((shown, m.line, m.text));
            }
            seen < SCAN_CEILING
        })
        .map_err(|e| format!("grep: {e}"))?;

        if seen == 0 {
            return Ok(ToolOutput::text(match &glob {
                Some(g) => format!("No matches for `{pattern}` in {g}."),
                None => format!("No matches for `{pattern}`."),
            }));
        }

        /*
          Grouped by file, with the path written once.

          Forty hits in one file is forty copies of that path otherwise, and
          the path is usually the longest thing on the line. It also reads the
          way a person would skim it: which files, then where in them.
        */
        let mut by_file: BTreeMap<String, Vec<(u32, String)>> = BTreeMap::new();
        for (path, line, text) in &hits {
            by_file
                .entry(path.clone())
                .or_default()
                .push((*line, text.clone()));
        }

        let mut out = format!(
            "{} {} for `{pattern}` in {} {}\n",
            seen,
            if seen == 1 { "match" } else { "matches" },
            by_file.len(),
            if by_file.len() == 1 { "file" } else { "files" }
        );
        for (path, lines) in &by_file {
            out.push_str(&format!("{path}\n"));
            for (line, text) in lines {
                out.push_str(&format!("  {line}: {}\n", clip_line(text, MAX_LINE)));
            }
        }

        if seen > hits.len() {
            out.push_str(&truncation_note(
                seen - hits.len(),
                "match",
                "narrow the pattern, or pass a glob",
            ));
            out.push('\n');
        }

        Ok(ToolOutput::text(out).with_detail(json!({
            "pattern": pattern,
            "matches": seen,
            "shown": hits.len(),
            "files": by_file.len(),
        })))
    }
}

/// A glob, in the small dialect people actually type at a search box.
///
/// `*` within a segment, `?` for one character, `**` across segments, and a
/// pattern with no separator in it — `*.rs` — matching the basename anywhere
/// in the tree, which is what everyone means by it and what every tool that
/// does otherwise gets complained about for.
///
/// Written here rather than taken from a crate because the dialect is the
/// decision: `globset` would bring the full specification, including
/// character classes and alternates, and the extra surface is behaviour
/// nobody asked for in an argument a model writes.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return true;
    }
    if !pattern.contains('/') {
        let base = path.rsplit('/').next().unwrap_or(path);
        return match_segment(pattern, base);
    }
    match_path(
        &pattern.split('/').collect::<Vec<_>>(),
        &path.split('/').collect::<Vec<_>>(),
    )
}

/// Segment lists, with `**` able to swallow any number of them.
fn match_path(pattern: &[&str], path: &[&str]) -> bool {
    match (pattern.first(), path.first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(&"**"), _) => {
            // Zero segments, or one and try again — which is the whole of
            // what `**` means.
            if match_path(&pattern[1..], path) {
                return true;
            }
            !path.is_empty() && match_path(pattern, &path[1..])
        }
        (Some(_), None) => false,
        (Some(p), Some(s)) => match_segment(p, s) && match_path(&pattern[1..], &path[1..]),
    }
}

/// One segment, with `*` and `?`. Iterative backtracking rather than
/// recursion: a pathological pattern against a long name is a stack otherwise.
fn match_segment(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_extension_matches_anywhere_in_the_tree() {
        // What everyone means by `*.rs`, and what a strict reading would not do.
        assert!(glob_matches("*.rs", "src/agent/tools/read.rs"));
        assert!(glob_matches("*.rs", "main.rs"));
        assert!(!glob_matches("*.rs", "src/main.ts"));
    }

    #[test]
    fn a_rooted_pattern_is_rooted() {
        assert!(glob_matches("src/*.ts", "src/main.ts"));
        assert!(!glob_matches("src/*.ts", "app/src/main.ts"));
        // `*` does not cross a separator.
        assert!(!glob_matches("src/*.ts", "src/deep/main.ts"));
    }

    #[test]
    fn double_star_crosses_separators_and_may_match_nothing() {
        assert!(glob_matches("src/**/*.ts", "src/a/b/c/main.ts"));
        assert!(glob_matches("src/**/*.ts", "src/main.ts"));
        assert!(!glob_matches("src/**/*.ts", "lib/main.ts"));
    }

    #[test]
    fn a_leading_double_star_matches_at_any_depth() {
        assert!(glob_matches("**/test/*.rs", "a/b/test/x.rs"));
        assert!(glob_matches("**/test/*.rs", "test/x.rs"));
        assert!(!glob_matches("**/test/*.rs", "a/tests/x.rs"));
    }

    #[test]
    fn a_question_mark_is_exactly_one_character() {
        assert!(glob_matches("v?.ts", "v1.ts"));
        assert!(!glob_matches("v?.ts", "v10.ts"));
    }

    #[test]
    fn a_pattern_with_several_stars_does_not_give_up_too_early() {
        // The case a greedy non-backtracking matcher gets wrong.
        assert!(glob_matches("*a*b*c*", "xxaxxbxxcxx"));
        assert!(!glob_matches("*a*b*c*", "xxaxxcxxbxx"));
    }

    #[test]
    fn an_empty_pattern_matches_everything() {
        assert!(glob_matches("", "anything/at/all.rs"));
        assert!(glob_matches("   ", "anything/at/all.rs"));
    }

    #[test]
    fn the_spec_describes_the_grouping_the_output_uses() {
        // Cheap guard on the description drifting from the behaviour: the
        // model chooses this tool on that sentence.
        assert!(Grep.spec().description.contains("path:line"));
    }
}
