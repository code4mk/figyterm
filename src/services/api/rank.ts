/**
 * Where a request sits among its siblings.
 *
 * Not an integer position. Positions mean that inserting anything renumbers
 * everything after it, and two machines that each drag a request into the same
 * folder while offline produce two renumberings of the whole folder that cannot
 * both be right. A **fractional index** is a string that sorts lexicographically
 * and always has room between any two neighbours, so an insert touches exactly
 * one row and two concurrent inserts produce two different keys that both
 * survive. Nothing else about sync works without this.
 *
 * The keys are digits of a base-62 alphabet chosen so that ASCII order and
 * alphabet order agree — which is what lets SQLite's `ORDER BY rank` be the
 * sort, with no comparator in the query.
 *
 * The one invariant the arithmetic depends on: **no key ends in the first
 * digit** (`0`). A key ending in the smallest digit has nothing below it to
 * subdivide, and `between` maintains this by construction.
 */

/** ASCII-ordered, so string comparison is digit comparison. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FIRST = DIGITS[0]!;

function digit(key: string, index: number): number {
  const character = key[index];
  return character === undefined ? 0 : DIGITS.indexOf(character);
}

/**
 * A key strictly between `before` and `after`.
 *
 * `null` means "no neighbour on that side": `between(null, null)` is the first
 * key in an empty list, `between(last, null)` appends, `between(null, first)`
 * prepends.
 *
 * Throws when the two are out of order or equal, because that is a caller bug —
 * silently returning something would put a row in a position nobody asked for,
 * and the next insert in the same gap would be wrong too.
 */
export function between(before: string | null, after: string | null): string {
  const low = before ?? "";
  const high = after ?? null;

  if (high !== null && low >= high) {
    throw new Error(`Ranks out of order: ${JSON.stringify(low)} is not below ${JSON.stringify(high)}`);
  }

  // Walk past the part the two keys agree on; the answer shares that prefix.
  if (high !== null) {
    let shared = 0;
    while (shared < high.length && (low[shared] ?? FIRST) === high[shared]) shared++;
    if (shared > 0) {
      return high.slice(0, shared) + between(low.slice(shared) || null, high.slice(shared) || null);
    }
  }

  const lowDigit = low === "" ? 0 : digit(low, 0);
  const highDigit = high === null ? DIGITS.length : digit(high, 0);

  // Room between the leading digits: take the middle one and stop.
  if (highDigit - lowDigit > 1) {
    return DIGITS[Math.round((lowDigit + highDigit) / 2)]!;
  }

  // The leading digits are adjacent, so the answer has to be longer.
  //
  // If the upper bound has more than one digit, borrowing its first digit alone
  // already lands below it — `between('A', 'B1')` is `'B'`. Otherwise there is
  // nothing to borrow and the answer extends the lower bound instead:
  // `between('A', 'B')` is `'A'` followed by a key above nothing at all.
  if (high !== null && high.length > 1) {
    return high.slice(0, 1);
  }
  return DIGITS[lowDigit]! + between(low.slice(1) || null, null);
}

/** The key for something appended to a list ordered by `rank`. */
export function rankAfter<T extends { rank: string }>(siblings: T[]): string {
  const last = siblings.length === 0 ? null : siblings[siblings.length - 1]!.rank;
  return between(last, null);
}

/**
 * The key for something dropped at `index` in a list that is already sorted.
 *
 * `index` is where it should end up, counted in the list **without** the row
 * being moved — the caller removes it first, which is also what makes dropping
 * a row back where it already was a no-op rather than an error.
 */
export function rankAt<T extends { rank: string }>(siblings: T[], index: number): string {
  const position = Math.max(0, Math.min(index, siblings.length));
  const before = position === 0 ? null : siblings[position - 1]!.rank;
  const after = position >= siblings.length ? null : siblings[position]!.rank;
  return between(before, after);
}

/** Sorts by rank, with the name as the tiebreak an import might need. */
export function byRank<T extends { rank: string; name: string }>(a: T, b: T): number {
  if (a.rank === b.rank) return a.name.localeCompare(b.name);
  return a.rank < b.rank ? -1 : 1;
}
