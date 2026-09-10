/**
 * Fuzzy path matching for quick open.
 *
 * The autocomplete engine can't be reused for this, despite both being
 * "filter a list as the user types": it matches command-line tokens by prefix
 * (`matchesPrefix` in `figy-autocomplete-engine.ts`), which is the right rule
 * for a shell completion and the wrong one for a file finder — nobody types
 * `src/components/Editor/EditorModal.tsx` to find it, they type `edmod`.
 *
 * So: subsequence matching, scored so that the match a person meant sorts
 * first. The rules that do the real work are the bonuses for matching at a word
 * boundary and for matching in the filename rather than somewhere up the
 * directory path — `edmod` should find `Editor/EditorModal.tsx`, not
 * `e...d...m...o...d` scattered through a long path that happens to contain
 * those letters in order.
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
  /** Indices into the matched string, for highlighting. */
  matches: number[];
}

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

/** Base value of any matched character, so longer matches beat shorter ones. */
const MATCH = 2;
/** A match immediately after a separator, or at a camelCase hump. */
const WORD_START = 10;
/** A match directly after the previous one. */
const CONSECUTIVE = 8;
/** Every character matched inside the filename rather than the directories. */
const IN_FILENAME = 4;
/** Charged once per gap, not per skipped character: one big jump is fine. */
const GAP = -3;
/** An exact, contiguous, case-insensitive hit inside the filename. */
const SUBSTRING = 40;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (SEPARATORS.has(previous)) return true;
  // camelCase: a capital preceded by a lowercase starts a word.
  return previous === previous.toLowerCase() && text[index] !== text[index].toLowerCase();
}

/**
 * Scores `query` against `target`, or returns null when it isn't a subsequence.
 *
 * `filenameStart` is where the basename begins, so matches there can be
 * weighted more heavily than matches in the directory part.
 */
export function fuzzyScore(
  query: string,
  target: string,
  filenameStart = 0
): { score: number; matches: number[] } | null {
  if (!query) return { score: 0, matches: [] };
  if (query.length > target.length) return null;

  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();

  const matches: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -2;

  for (let q = 0; q < needle.length; q++) {
    // Whitespace in the query is a separator between terms, not something to
    // find in the path.
    if (needle[q] === " ") continue;

    const found = haystack.indexOf(needle[q], cursor);
    if (found === -1) return null;

    score += MATCH;
    if (found === previousIndex + 1) {
      score += CONSECUTIVE;
    } else {
      score += GAP;
    }
    if (isWordStart(target, found)) score += WORD_START;
    if (found >= filenameStart) score += IN_FILENAME;

    matches.push(found);
    previousIndex = found;
    cursor = found + 1;
  }

  // Typing part of a filename verbatim is the overwhelmingly common case, and
  // it should always beat a scattered subsequence that happens to score well.
  const filename = haystack.slice(filenameStart);
  const contiguous = filename.indexOf(needle.replace(/ /g, ""));
  if (contiguous !== -1) {
    score += SUBSTRING;
    if (contiguous === 0) score += WORD_START;
  }

  // Shorter paths win ties: with two equally good matches, the one nearer the
  // root is nearly always the one meant.
  score -= Math.floor(target.length / 40);

  return { score, matches };
}

/**
 * Ranks `items` against `query`, best first.
 *
 * `limit` is applied after sorting, so the caller gets the best N rather than
 * the first N found — which matters because the file list arrives in directory
 * order, not relevance order.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
  limit = 100
): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];

  for (const item of items) {
    const text = key(item);
    const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    const scored = fuzzyScore(query, text, cut + 1);
    if (scored) {
      results.push({ item, score: scored.score, matches: scored.matches });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
