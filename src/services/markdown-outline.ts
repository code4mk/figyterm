/**
 * The heading tree of a Markdown document, for the outline panel.
 *
 * Parsed from the buffer's live text rather than from the rendered preview, so
 * the outline works with the preview closed and each entry can carry the source
 * line it came from — which is what lets clicking one move the editor's cursor
 * rather than only scrolling a rendered document.
 *
 * The line numbers here have to agree with the ones `Markdown` stamps onto its
 * rendered headings (`data-md-line`), since the outline scrolls the preview by
 * looking them up. Both count 1-based lines over the same `\r\n`-normalised
 * text and both skip fenced code, which is the only rule that could make them
 * disagree.
 */

export interface OutlineEntry {
  /** 1 for `#`, 6 for `######`. */
  level: number;
  text: string;
  /** 1-based line in the source. */
  line: number;
}

/** Opening or closing fence: ``` or ~~~, with optional indent and info string. */
const FENCE = /^\s{0,3}(```|~~~)/;

/** ATX heading. Setext (`===` underlines) is not supported — see below. */
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Strips the inline markup that would otherwise show up as literal characters
 * in the outline — `**Bold**`, `` `code` ``, `[label](url)`.
 */
function plainText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    // A link becomes its label; a bare autolink becomes the URL.
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => label || href)
    .replace(/<([^>]+)>/g, "$1")
    .trim();
}

/**
 * Every heading in `source`.
 *
 * Setext headings are deliberately not recognised. They'd need a lookahead that
 * distinguishes an `---` underline from a horizontal rule and from a table's
 * separator row, and essentially nobody writing a project's docs uses them —
 * the cost of getting it subtly wrong is higher than the value.
 */
export function parseOutline(source: string): OutlineEntry[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE);

    if (fence) {
      // Only the same fence character closes the block, so a ``` inside a ~~~
      // block doesn't end it early.
      if (fenceMatch && fenceMatch[1][0] === fence[0]) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }

    const heading = line.match(ATX);
    if (!heading) continue;

    const text = plainText(heading[2]);
    // A bare `#` with nothing after it is a divider in some styles, not an entry.
    if (!text) continue;

    entries.push({ level: heading[1].length, text, line: i + 1 });
  }

  return entries;
}

/**
 * A heading's anchor, the way GitHub forms it.
 *
 * Lowercased, punctuation dropped, spaces to hyphens — so a link written
 * `[Quick Start](#quick-start)` finds the `## Quick Start` it refers to. Not
 * exhaustive (GitHub also de-duplicates repeats with `-1` suffixes), but it
 * covers what people actually write by hand.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** The heading an in-page link points at, or null when nothing matches. */
export function findBySlug(entries: OutlineEntry[], slug: string): OutlineEntry | null {
  const wanted = slug.replace(/^#/, "").toLowerCase();
  return entries.find((entry) => slugify(entry.text) === wanted) ?? null;
}

/**
 * Which entry the cursor is inside — the last heading at or above `line`.
 *
 * Returns -1 when the cursor sits above the first heading. Used to mark the
 * reader's place in the outline as they move through the document.
 */
export function activeOutlineIndex(entries: OutlineEntry[], line: number): number {
  let found = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].line <= line) found = i;
    else break;
  }
  return found;
}

/**
 * Re-bases the outline so the shallowest heading sits at indent zero.
 *
 * A document whose top level is `##` (common when the `#` title lives in
 * frontmatter or is the filename) would otherwise render with every entry
 * indented once for no reason.
 */
export function normalizeDepth(entries: OutlineEntry[]): { entry: OutlineEntry; depth: number }[] {
  if (entries.length === 0) return [];
  const shallowest = Math.min(...entries.map((entry) => entry.level));
  return entries.map((entry) => ({ entry, depth: entry.level - shallowest }));
}
