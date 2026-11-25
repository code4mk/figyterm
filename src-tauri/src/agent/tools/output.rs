//! What a tool is allowed to hand back, and how it says it held something
//! back.
//!
//! The rule the whole agent is built around: **a tool result is a permanent
//! subscription.** The API is stateless, so everything returned on turn 3 is
//! re-sent on every turn until the session ends — three thousand tokens on
//! turn 3 of a thirty-turn session is about eighty thousand input tokens.
//!
//! So every tool caps its output, and every cap announces itself. A silent
//! truncation is the expensive kind: the model cannot tell a short answer
//! from a cut one, so it re-runs the call with a query it has to guess at,
//! and pays for both. An explicit one tells it what to do instead.

/// Rough tokens for a string, for the caps below.
///
/// Four bytes to a token is the usual English approximation and it is wrong
/// for code — identifiers and punctuation tokenise worse — but it is wrong
/// in the safe direction here, under-counting dense text and so cutting
/// sooner. A real tokenizer would be a dependency and a per-model one at
/// that, for a number that only has to decide where to stop.
pub fn approx_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

/// The line a truncated result ends with.
///
/// `how` is the advice, and it is the point of the whole function: "re-run
/// with a narrower pattern" is a next step, where "output truncated" is a
/// dead end the model will walk into again.
pub fn truncation_note(remaining: usize, unit: &str, how: &str) -> String {
    let plural = if remaining == 1 { "" } else { "s" };
    format!("--- truncated: {remaining} more {unit}{plural}. {how} ---")
}

/// Keeps a long line readable without letting one minified file cost a turn.
///
/// A bundled `.js` is one line of two hundred thousand characters. Returning
/// it is a session's budget spent on something nobody can read anyway.
pub fn clip_line(line: &str, max: usize) -> String {
    let mut out = String::new();
    for (count, ch) in line.chars().enumerate() {
        if count >= max {
            out.push_str(&format!("… +{} more characters", line.chars().count() - max));
            break;
        }
        out.push(ch);
    }
    out
}

/// Caps a block of lines, returning the kept ones and a note when it cut.
pub fn cap_lines(lines: Vec<String>, max: usize, how: &str) -> (Vec<String>, Option<String>) {
    if lines.len() <= max {
        return (lines, None);
    }
    let remaining = lines.len() - max;
    let mut kept = lines;
    kept.truncate(max);
    (kept, Some(truncation_note(remaining, "line", how)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_result_says_how_many_it_cut_and_what_to_do() {
        let note = truncation_note(1847, "line", "re-run with `| tail -50`, or grep it");
        assert!(note.contains("1847 more lines"));
        assert!(note.contains("tail"));
    }

    #[test]
    fn one_remaining_is_not_plural() {
        assert!(truncation_note(1, "match", "narrow the pattern").contains("1 more match."));
    }

    #[test]
    fn a_result_that_fits_is_not_annotated() {
        let (kept, note) = cap_lines(vec!["a".into(), "b".into()], 10, "…");
        assert_eq!(kept.len(), 2);
        assert!(note.is_none());
    }

    #[test]
    fn a_result_that_does_not_fit_is_cut_and_annotated() {
        let lines: Vec<String> = (0..50).map(|i| i.to_string()).collect();
        let (kept, note) = cap_lines(lines, 10, "narrow it");
        assert_eq!(kept.len(), 10);
        assert_eq!(kept.last().unwrap(), "9");
        assert!(note.unwrap().contains("40 more lines"));
    }

    #[test]
    fn a_long_line_is_clipped_and_says_by_how_much() {
        let clipped = clip_line(&"x".repeat(500), 100);
        assert!(clipped.starts_with(&"x".repeat(100)));
        assert!(clipped.contains("+400 more characters"));
    }

    #[test]
    fn clipping_counts_characters_rather_than_bytes() {
        // Four bytes each, one character each: a byte-wise clip would cut
        // one in half and produce invalid text.
        let line = "😀😀😀😀😀";
        assert_eq!(clip_line(line, 3).chars().next(), Some('😀'));
        assert!(clip_line(line, 3).contains("+2 more"));
        assert_eq!(clip_line(line, 99), line);
    }

    #[test]
    fn the_token_estimate_rounds_up_so_nothing_counts_as_free() {
        assert_eq!(approx_tokens(""), 0);
        assert_eq!(approx_tokens("abc"), 1);
        assert_eq!(approx_tokens("abcd"), 1);
        assert_eq!(approx_tokens("abcde"), 2);
    }
}
