/**
 * The console's log: what happened, in the order it happened.
 *
 * The window has plenty of places that show the *result* of something — the
 * response pane, the import report, the sync dot. What it has never had is a
 * place that says what it did. When a send never leaves, when a script sets a
 * variable to the wrong thing, when a sync pass quietly pushes nothing, the
 * evidence has nowhere to appear and the answer is "it just doesn't work".
 *
 * Pure, and out of the store, because the two things that can go wrong here are
 * arithmetic: a buffer that grows without bound, and a filter that hides the
 * line somebody is looking for.
 */

export type ConsoleLevel = "info" | "warn" | "error";

/** Which part of the window spoke. Shown as a chip, and filterable. */
export type ConsoleSource = "request" | "script" | "runner" | "import" | "sync" | "store";

export interface ConsoleEntry {
  /** Monotonic within a session: a stable key, and an order that does not
   * depend on the clock, which can go backwards. */
  id: number;
  at: number;
  level: ConsoleLevel;
  source: ConsoleSource;
  text: string;
  /** The second line, when there is more to say than fits on one. */
  detail?: string;
  /** The tab it came from, so a line can take you back to it. */
  tabId?: string;
}

/** What a caller supplies; the id and the clock are the log's business. */
export type NewConsoleEntry = Omit<ConsoleEntry, "id" | "at">;

/**
 * How many lines are kept.
 *
 * A window left open for a day sending on a timer produces tens of thousands
 * of lines, and a log that keeps all of them is a memory leak that takes a day
 * to show up — which is the worst kind to find. Five hundred is far more than
 * anybody scrolls back through and small enough to be free.
 */
export const CONSOLE_LIMIT = 500;

/**
 * Adds a line, dropping the oldest once the buffer is full.
 *
 * Returns a new array rather than mutating: the store hands this straight to
 * React, and a mutated array is one that does not re-render.
 */
export function append(
  entries: ConsoleEntry[],
  entry: NewConsoleEntry,
  nextId: number,
  now: number,
  limit = CONSOLE_LIMIT
): ConsoleEntry[] {
  const line: ConsoleEntry = { ...entry, id: nextId, at: now };
  // A limit of zero means "keep nothing", not "keep one".
  if (limit <= 0) return [];
  const next = entries.length >= limit ? entries.slice(entries.length - limit + 1) : entries.slice();
  next.push(line);
  return next;
}

export interface ConsoleFilter {
  /** Levels to show. An empty set shows all of them, because a filter that
   * hides everything is one somebody has to undo before the console is of any
   * use again. */
  levels: Set<ConsoleLevel>;
  /** Matched against the text and the detail, case-insensitively. */
  query: string;
}

export function matches(entry: ConsoleEntry, filter: ConsoleFilter): boolean {
  if (filter.levels.size > 0 && !filter.levels.has(entry.level)) return false;

  const needle = filter.query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    entry.text.toLowerCase().includes(needle) ||
    (entry.detail?.toLowerCase().includes(needle) ?? false) ||
    entry.source.includes(needle)
  );
}

/** What the collapsed bar says: how many need attention. */
export function summarise(entries: ConsoleEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const entry of entries) {
    if (entry.level === "error") errors++;
    else if (entry.level === "warn") warnings++;
  }
  return { errors, warnings };
}

/** `hh:mm:ss`, in local time, zero-padded so the column does not jitter. */
export function clockOf(at: number): string {
  const when = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * One line, as text somebody can paste into a bug report.
 *
 * The detail goes on the same line rather than below it: a copied line that
 * spans two is one that will be quoted as one and pasted as two.
 */
export function formatLine(entry: ConsoleEntry): string {
  const head = `${clockOf(entry.at)}  ${entry.level.toUpperCase().padEnd(5)} ${entry.source}`;
  return entry.detail ? `${head}  ${entry.text} — ${entry.detail}` : `${head}  ${entry.text}`;
}

/** The whole log, for the copy-all button. */
export function formatAll(entries: ConsoleEntry[]): string {
  return entries.map(formatLine).join("\n");
}
