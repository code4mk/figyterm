/**
 * Turning an edit into something you can read.
 *
 * `edit` hands back the text it replaced and the text it wrote. Rendering
 * those as "everything removed, then everything added" is what the first
 * version did, and on a six-line replacement that changed one word it is
 * twelve lines of noise with the answer hidden in it.
 *
 * So: a line diff, and the unchanged lines kept as context with long runs
 * elided. The repository's own `diff.ts` is next door and does not fit —
 * it *parses* `git diff` output, where this has two strings and no git.
 * Its word-level highlighting is the obvious next step and deliberately
 * not taken yet: the transcript's rows render plain text, and a second
 * renderer is a bigger change than this is worth today.
 */

import type { DiffLine } from "./figycode-blocks";

/** Lines either side of a change that are shown for context. */
const CONTEXT = 2;

/**
 * Where the quadratic table stops being free.
 *
 * 400×400 is 160,000 cells, which is nothing; a 5,000-line replacement is
 * twenty-five million and a visibly frozen window. Past the limit the
 * answer is the honest crude one — all of it removed, all of it added —
 * because an edit that size is not something anybody reads line by line.
 */
const MAX_LINES = 400;

/**
 * The diff between two pieces of text, numbered from `startLine`.
 *
 * Removed lines carry the number they had; added and unchanged lines carry
 * the number they now have. One column, because that is what the
 * transcript's rows have, and because the number anybody wants from a
 * transcript is "where is this now".
 */
export function lineDiff(before: string, after: string, startLine = 1): DiffLine[] {
  const old = split(before);
  const now = split(after);

  if (old.length > MAX_LINES || now.length > MAX_LINES) {
    return [
      ...old.map((text, i) => ({ no: startLine + i, sign: "-" as const, text })),
      ...now.map((text, i) => ({ no: startLine + i, sign: "+" as const, text })),
    ];
  }

  const rows = walk(old, now, startLine);
  return elide(rows);
}

/** Every line of a new file, as additions. */
export function addedLines(text: string, startLine = 1): DiffLine[] {
  return split(text).map((line, i) => ({ no: startLine + i, sign: "+" as const, text: line }));
}

/**
 * `"a\nb\n"` → `["a", "b"]`.
 *
 * The trailing empty string a final newline produces is dropped: it is not
 * a line, and showing it adds a blank row to the end of every diff.
 */
function split(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence, then read back as rows.
 *
 * The table is the standard one. What matters for the output is the
 * backtrack order: a removal is emitted before the addition that replaces
 * it, because `-` then `+` is how every diff anybody has read is laid out.
 */
function walk(old: string[], now: string[], startLine: number): DiffLine[] {
  const table: number[][] = Array.from({ length: old.length + 1 }, () =>
    new Array<number>(now.length + 1).fill(0)
  );
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = now.length - 1; j >= 0; j--) {
      table[i][j] =
        old[i] === now[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < now.length) {
    if (old[i] === now[j]) {
      rows.push({ no: startLine + j, sign: " ", text: old[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ no: startLine + i, sign: "-", text: old[i] });
      i++;
    } else {
      rows.push({ no: startLine + j, sign: "+", text: now[j] });
      j++;
    }
  }
  while (i < old.length) rows.push({ no: startLine + i, sign: "-", text: old[i++] });
  while (j < now.length) rows.push({ no: startLine + j, sign: "+", text: now[j++] });
  return rows;
}

/**
 * Keeps a couple of lines either side of each change and elides the rest.
 *
 * A diff is read for what changed; the unchanged lines are there to say
 * *where*. Twenty of them say it no better than two, and every one of them
 * is a row in a transcript somebody is scrolling.
 */
function elide(rows: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.sign === " ") return;
    for (let i = Math.max(0, index - CONTEXT); i <= Math.min(rows.length - 1, index + CONTEXT); i++) {
      keep[i] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipping = false;
  rows.forEach((row, index) => {
    if (keep[index]) {
      out.push(row);
      skipping = false;
      return;
    }
    // One `…` per run, however long the run is.
    if (!skipping) {
      out.push({ no: null, sign: "…", text: "" });
      skipping = true;
    }
  });
  return out;
}
