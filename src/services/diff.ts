/**
 * Turning `git diff` output into something a view can lay out two ways.
 *
 * `git diff` gives lines. A diff *view* needs a little more than that:
 *
 * - **Which words changed**, not just which lines. A line whose only
 *   difference is `a` → `the` reads as two entirely different lines when the
 *   whole row is tinted; the point of highlighting the words is that the eye
 *   goes straight to them. This is the thing GitHub does that a terminal
 *   `git diff` cannot.
 * - **Blocks, not a flat list.** A run of removals followed by a run of
 *   additions is one *change*, and both layouts need it as one thing: unified
 *   shows the removals then the additions, split puts them side by side. A
 *   flat list of rows can be rendered unified but not split, so the model
 *   keeps the runs paired and each layout flattens it its own way.
 *
 * The word diff is computed here rather than asked of git. `--word-diff` is a
 * different output format, not an addition to this one, so using it would mean
 * running and parsing a second diff per file. Since the two lines are already
 * in hand, a local token diff is both cheaper and easier to line up with the
 * rows it belongs to.
 */

/** A run of a line, either changed or not. Consecutive runs are merged. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  /** 1-based line number on its own side of the diff. */
  number: number;
  segments: DiffSegment[];
}

/**
 * A line that is the same on both sides.
 *
 * It carries *both* numbers, because they are not the same: everything added
 * or removed above it has pushed the two apart, and showing only one of them
 * is what makes a diff impossible to cross-reference against the file.
 */
export interface ContextLine {
  oldNumber: number;
  newNumber: number;
  segments: DiffSegment[];
}

interface ContextBlock {
  kind: "context";
  lines: ContextLine[];
}

/**
 * One change: everything removed, then everything added.
 *
 * Either side can be empty — a pure insertion has no removals — and the two
 * are not necessarily the same length.
 */
interface ChangeBlock {
  kind: "change";
  removed: DiffLine[];
  added: DiffLine[];
}

export type DiffBlock = ContextBlock | ChangeBlock;

export interface DiffHunk {
  /** The `@@ … @@` line, verbatim. */
  header: string;
  blocks: DiffBlock[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** `new file`, `deleted file`, `rename from` — worth showing, once. */
  notes: string[];
  binary: boolean;
  added: number;
  removed: number;
}

/** Header lines that say nothing a reader of the panel needs. */
const NOISE = [
  "diff --git ",
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "--- ",
  "+++ ",
];

/**
 * Above this many tokens on either side, the word diff drops to trimming the
 * common ends instead of running the full comparison.
 *
 * The table below is O(n·m); a minified bundle on one line would otherwise
 * lock the window up for seconds to highlight something nobody can read.
 */
const MAX_TOKENS = 400;

/**
 * How much two lines must have in common before their words are compared.
 *
 * A removal and an addition that happen to be adjacent are not necessarily
 * versions of each other — a deleted function and an unrelated new one, say —
 * and highlighting the handful of tokens they share ("const", "(", ")") picks
 * out noise and hides the fact that the whole line is different.
 */
const SIMILAR_ENOUGH = 0.3;

// ─── Word diff ──────────────────────────────────────────────────────────────

/**
 * Splits a line into diffable tokens.
 *
 * Words, runs of whitespace, and every other character on its own. Tokenising
 * by word alone would report `foo.bar` → `foo.baz` as one changed token
 * covering the lot; splitting per character would mark `a`→`the` as three
 * separate specks. This is the granularity that produces the highlight a
 * reader expects.
 */
function tokenize(line: string): string[] {
  return line.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

function merge(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && last.changed === segment.changed) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

/** Tokens shared at the start and end of two sequences. */
function commonEnds(a: string[], b: string[]): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return { head, tail };
}

/**
 * The classic LCS table, over tokens.
 *
 * Not Myers: the inputs here are one line each, already capped at
 * [`MAX_TOKENS`], and the straightforward version is short enough to read and
 * fast enough at that size. Myers would be the answer for whole files.
 */
function longestCommon(a: string[], b: string[]): boolean[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  // Walked back into two "is this token common" masks, which is all the
  // caller needs — the actual subsequence is never used.
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keptA[i] = true;
      keptB[j] = true;
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return [keptA, keptB];
}

/**
 * Absorbs whitespace that sits between two changed tokens.
 *
 * The subsequence legitimately matches the spaces *between* words, so
 * `the deferred part` → `both there now` comes back as three separate
 * highlights with two gaps punched through them. That is technically accurate
 * and reads as stripes; every tool that highlights words joins them up, and
 * this is where that happens.
 *
 * Neighbours are read from the original mask rather than the one being built,
 * so a run of alternating words and spaces resolves the same way regardless of
 * which end it is scanned from.
 */
function joinRuns(tokens: string[], kept: boolean[]): boolean[] {
  const out = kept.slice();
  for (let index = 1; index < tokens.length - 1; index++) {
    if (!out[index] || tokens[index].trim()) continue;
    if (!kept[index - 1] && !kept[index + 1]) out[index] = false;
  }
  return out;
}

function segmentsFrom(tokens: string[], kept: boolean[]): DiffSegment[] {
  return merge(tokens.map((text, index) => ({ text, changed: !kept[index] })));
}

/**
 * Marks the words that differ between two versions of a line.
 *
 * Returns null when the two are too different to be worth pairing, so the
 * caller can leave both lines plainly added and removed.
 */
export function wordDiff(
  before: string,
  after: string
): { before: DiffSegment[]; after: DiffSegment[] } | null {
  if (before === after) {
    return {
      before: [{ text: before, changed: false }],
      after: [{ text: after, changed: false }],
    };
  }

  const a = tokenize(before);
  const b = tokenize(after);

  // Too long for the table: trim what the two share at each end and call the
  // rest changed. It is the same answer for the common case of one edit in the
  // middle of a line, and it is instant.
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    const { head, tail } = commonEnds(a, b);
    if (head === 0 && tail === 0) return null;
    const side = (tokens: string[]): DiffSegment[] =>
      merge([
        { text: tokens.slice(0, head).join(""), changed: false },
        { text: tokens.slice(head, tokens.length - tail).join(""), changed: true },
        { text: tokens.slice(tokens.length - tail).join(""), changed: false },
      ]);
    return { before: side(a), after: side(b) };
  }

  const [keptA, keptB] = longestCommon(a, b);

  // Whitespace is common between almost any two lines, so counting it towards
  // similarity would pair a deleted line with an unrelated new one on the
  // strength of their shared indentation.
  const weight = (tokens: string[], kept: boolean[]) =>
    tokens.reduce(
      (total, token, index) =>
        total + (kept[index] && token.trim() ? token.length : 0),
      0
    );
  const shared = weight(a, keptA) + weight(b, keptB);
  const total = before.trim().length + after.trim().length;
  if (total > 0 && shared / total < SIMILAR_ENOUGH) return null;

  return {
    before: segmentsFrom(a, joinRuns(a, keptA)),
    after: segmentsFrom(b, joinRuns(b, keptB)),
  };
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** A removed/added run, before its words have been compared. */
interface RawChange {
  removed: { number: number; text: string }[];
  added: { number: number; text: string }[];
}

/**
 * Compares each removed line with the added line in the same position.
 *
 * Positional, and only within one change block. Anything cleverer — matching
 * by similarity across the whole block — reorders the diff relative to what
 * `git diff` printed, and a diff that disagrees with `git diff` about the order
 * of its own lines is worse than one that occasionally fails to highlight.
 */
function pairWords(raw: RawChange): ChangeBlock {
  const pairs = Math.min(raw.removed.length, raw.added.length);
  const removed: DiffLine[] = raw.removed.map((line) => ({
    number: line.number,
    segments: [{ text: line.text, changed: false }],
  }));
  const added: DiffLine[] = raw.added.map((line) => ({
    number: line.number,
    segments: [{ text: line.text, changed: false }],
  }));

  for (let index = 0; index < pairs; index++) {
    const marks = wordDiff(raw.removed[index].text, raw.added[index].text);
    if (!marks) continue;
    removed[index].segments = marks.before;
    added[index].segments = marks.after;
  }

  return { kind: "change", removed, added };
}

export function parseDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  const notes: string[] = [];
  let binary = false;
  let added = 0;
  let removed = 0;

  let hunk: DiffHunk | null = null;
  let pending: RawChange | null = null;
  let oldLine = 0;
  let newLine = 0;

  /** Closes the open change run, word-diffing it as it goes in. */
  const flush = () => {
    if (!pending || !hunk) return;
    hunk.blocks.push(pairWords(pending));
    pending = null;
  };

  const context = (text: string) => {
    if (!hunk) return;
    const last = hunk.blocks[hunk.blocks.length - 1];
    const line: ContextLine = {
      oldNumber: oldLine,
      newNumber: newLine,
      segments: [{ text, changed: false }],
    };
    if (last?.kind === "context") last.lines.push(line);
    else hunk.blocks.push({ kind: "context", lines: [line] });
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }

    if (raw.startsWith("@@")) {
      flush();
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLine = header ? Number(header[1]) : 1;
      newLine = header ? Number(header[2]) : 1;
      hunk = { header: raw, blocks: [] };
      hunks.push(hunk);
      continue;
    }

    if (raw.startsWith("new file") || raw.startsWith("deleted file")) {
      notes.push(raw);
      continue;
    }
    if (raw.startsWith("rename ")) {
      notes.push(raw);
      continue;
    }
    if (NOISE.some((prefix) => raw.startsWith(prefix))) continue;

    // `\ No newline at end of file`. A real difference, and one that otherwise
    // shows up as an unexplained diff in somebody else's tooling — but it
    // belongs to the line above rather than being a line of its own.
    if (raw.startsWith("\\")) {
      notes.push(raw.slice(2));
      continue;
    }

    if (!hunk) continue;

    if (raw.startsWith("+")) {
      pending ??= { removed: [], added: [] };
      pending.added.push({ number: newLine++, text: raw.slice(1) });
      added++;
    } else if (raw.startsWith("-")) {
      pending ??= { removed: [], added: [] };
      pending.removed.push({ number: oldLine++, text: raw.slice(1) });
      removed++;
    } else if (raw !== "") {
      flush();
      context(raw.slice(1));
      oldLine++;
      newLine++;
    }
    // A bare empty string is the split artefact of the trailing newline, not a
    // line. A genuinely blank context line arrives as a single space.
  }

  flush();
  return { hunks, notes, binary, added, removed };
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export type DiffRowKind = "context" | "add" | "del";

/** One rendered row of a unified diff. */
export interface UnifiedRow {
  kind: DiffRowKind;
  oldNumber: number | null;
  newNumber: number | null;
  segments: DiffSegment[];
}

/** One rendered row of a split diff. Either side can be absent. */
export interface SplitRow {
  left: { number: number; segments: DiffSegment[]; kind: DiffRowKind } | null;
  right: { number: number; segments: DiffSegment[]; kind: DiffRowKind } | null;
}

export function toUnified(hunk: DiffHunk): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const block of hunk.blocks) {
    if (block.kind === "context") {
      for (const line of block.lines) {
        rows.push({
          kind: "context",
          oldNumber: line.oldNumber,
          newNumber: line.newNumber,
          segments: line.segments,
        });
      }
      continue;
    }
    // Removals first, then additions — grouped, not interleaved. `-`, `-`,
    // `+`, `+` is how every diff reads; alternating them makes a two-line
    // change look like two one-line changes.
    for (const line of block.removed) {
      rows.push({
        kind: "del",
        oldNumber: line.number,
        newNumber: null,
        segments: line.segments,
      });
    }
    for (const line of block.added) {
      rows.push({
        kind: "add",
        oldNumber: null,
        newNumber: line.number,
        segments: line.segments,
      });
    }
  }
  return rows;
}

export function toSplit(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const block of hunk.blocks) {
    if (block.kind === "context") {
      for (const line of block.lines) {
        rows.push({
          left: {
            number: line.oldNumber,
            segments: line.segments,
            kind: "context",
          },
          right: {
            number: line.newNumber,
            segments: line.segments,
            kind: "context",
          },
        });
      }
      continue;
    }

    // Zipped, with a blank on whichever side runs out first: that gap is the
    // point of a split view — it is where lines were added or removed rather
    // than changed.
    const height = Math.max(block.removed.length, block.added.length);
    for (let index = 0; index < height; index++) {
      const left = block.removed[index];
      const right = block.added[index];
      rows.push({
        left: left
          ? { number: left.number, segments: left.segments, kind: "del" }
          : null,
        right: right
          ? { number: right.number, segments: right.segments, kind: "add" }
          : null,
      });
    }
  }
  return rows;
}
