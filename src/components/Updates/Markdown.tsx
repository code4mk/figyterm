import React from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

/**
 * A GitHub-flavoured Markdown renderer.
 *
 * Written for GitHub release notes, and now also the editor's `.md` preview.
 * Release bodies are remote, user-authored content, so this never touches
 * `dangerouslySetInnerHTML` and has no HTML passthrough: everything becomes
 * React elements, which makes markup injection structurally impossible rather
 * than a matter of sanitising correctly. Unsupported syntax degrades to plain
 * text, which is the right failure mode for both a changelog and a preview.
 *
 * `variant` is the only thing that separates the two uses. `compact` is the
 * original release-note styling; `document` is sized to read a whole file and
 * stamps each heading with its source line — which is what the preview's
 * scroll sync and outline are built on.
 *
 * ## What's covered
 *
 * Following GitHub's own "Writing on GitHub" pages: headings (ATX and setext),
 * emphasis, strikethrough, code spans, fenced and indented code, links,
 * autolinks, reference links, images, nested lists, ordered lists with a
 * starting number, task lists, tables with alignment, blockquotes (nested, and
 * containing other blocks), alerts, footnotes, collapsed sections, horizontal
 * rules, hard line breaks and backslash escapes.
 *
 * ## What isn't, and why
 *
 * - **Raw HTML.** The safety property above is worth more than the syntax.
 *   `<details>` is the one exception, special-cased below, because collapsed
 *   sections are too common in READMEs to drop — and it's matched as whole
 *   lines, with no attributes carried through.
 * - **Math and Mermaid.** Both mean shipping a renderer (KaTeX, Mermaid) an
 *   order of magnitude larger than this file. Their source shows as a code
 *   block, which is at least readable.
 * - **Emoji shortcodes.** `:tada:` needs GitHub's several-thousand-entry map.
 * - **Underscore italics.** `_x_` needs a word-boundary rule to avoid mangling
 *   `snake_case` identifiers, and that needs lookbehind, which isn't safe to
 *   rely on across the WebKit versions this ships against. `*x*` works.
 */

export type MarkdownVariant = "compact" | "document";

/** Where a link points, once the kind is known. */
export type LinkKind = "external" | "anchor" | "path";

export function linkKind(href: string): LinkKind {
  if (/^https?:\/\//i.test(href)) return "external";
  if (href.startsWith("#")) return "anchor";
  return "path";
}

/**
 * Inline tokens, in priority order.
 *
 * The order is load-bearing: an escape has to win over the character it
 * escapes, an image over the link it looks like, a footnote reference over the
 * reference link it looks like, and `**bold**` over `*italic*`.
 */
const INLINE_SOURCE = [
  "(\\\\[\\\\`*_{}\\[\\]()#+\\-.!~|>])", // backslash escape
  "(`[^`\\n]+`)", // inline code
  "(!\\[[^\\]\\n]*\\]\\([^)\\s]*(?:\\s+\"[^\"\\n]*\")?\\))", // ![alt](src)
  "(\\[\\^[^\\]\\n]+\\])", // [^footnote]
  "(\\[[^\\]\\n]*\\]\\([^)\\s]*(?:\\s+\"[^\"\\n]*\")?\\))", // [text](url "title")
  "(\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\])", // [text][ref]
  "(\\*\\*[^*\\n]+\\*\\*)", // **bold**
  "(__[^_\\n]+__)", // __bold__
  "(~~[^~\\n]+~~)", // ~~strikethrough~~
  "(\\*[^*\\n]+\\*)", // *italic*
  "(https?://[^\\s<>()\\[\\]]+)", // bare url
  "(\\bwww\\.[^\\s<>()\\[\\]]+)", // www autolink
].join("|");

/**
 * A fresh matcher per call, deliberately.
 *
 * `lastIndex` is state, and a single `/g/` regex shared across calls cannot
 * survive `renderInline` recursing into itself: the inner call reset the index
 * to zero, the outer loop then re-matched the token it had just consumed, and
 * the preview hung on any `**bold**`. One regex object per invocation is the
 * cheapest correct answer — engines cache the compiled pattern, so this costs
 * an object, not a compile.
 */
function inlineMatcher(): RegExp {
  return new RegExp(INLINE_SOURCE, "g");
}

/** `[label]: https://example.com "Optional title"` */
const LINK_DEFINITION = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+"[^"]*")?\s*$/;

/** `[^1]: The note text.` */
const FOOTNOTE_DEFINITION = /^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/;

/** `> [!NOTE]`, and the four other kinds GitHub defines. */
const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/** `- [x] done` / `- [ ] todo`, captured as the mark and the rest. */
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/;

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

const FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+-]*)/;
const FENCE_ANY = /^\s{0,3}(?:```|~~~)/;

const SETEXT = /^\s{0,3}(=+|-+)\s*$/;

const CODE_DOC =
  "my-3 p-3 rounded-lg bg-ft-elevated overflow-x-auto text-[12px] font-mono text-ft-text leading-relaxed";
const CODE_COMPACT =
  "my-2 p-3 rounded-lg bg-ft-elevated overflow-x-auto text-[11px] font-mono text-ft-text-secondary";

const ALERT_STYLES: Record<string, { label: string; border: string; text: string }> = {
  NOTE: { label: "Note", border: "border-ft-accent", text: "text-ft-accent" },
  TIP: { label: "Tip", border: "border-ft-success", text: "text-ft-success" },
  IMPORTANT: { label: "Important", border: "border-ft-accent", text: "text-ft-accent" },
  WARNING: { label: "Warning", border: "border-ft-warning", text: "text-ft-warning" },
  CAUTION: { label: "Caution", border: "border-ft-error", text: "text-ft-error" },
};

/** Everything the block and inline passes need to share. */
interface Context {
  doc: boolean;
  onFollow?: (href: string) => void;
  /** Link reference definitions, keyed by lower-cased label. */
  refs: Map<string, string>;
  /** Footnote bodies, keyed by label. */
  footnotes: Map<string, string>;
  /** Labels in the order first referenced, which is how GitHub numbers them. */
  cited: string[];
  /** Monotonic, so every generated key is unique across the whole render. */
  next: () => string;
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Strips a `(url "title")` target down to the url. */
function hrefOf(target: string): string {
  return target.replace(/\s+"[^"]*"$/, "").trim();
}

// ─── Inline ─────────────────────────────────────────────────────────────────

function MarkdownLink({
  href,
  ctx,
  children,
}: {
  href: string;
  ctx: Context;
  children: React.ReactNode;
}) {
  const kind = linkKind(href);

  if (kind === "external") {
    return (
      <button
        type="button"
        onClick={() => openExternal(href).catch(() => {})}
        className="text-ft-accent hover:underline break-all text-left"
        title={href}
      >
        {children}
      </button>
    );
  }

  // A sibling file or an in-page anchor is only actionable if the caller says
  // how to follow it — the editor's preview does, the update modal doesn't.
  if (!ctx.onFollow) return <>{children}</>;

  return (
    <button
      type="button"
      onClick={() => ctx.onFollow?.(href)}
      className="text-ft-accent hover:underline break-all text-left"
      title={kind === "anchor" ? `Go to ${href}` : `Open ${href}`}
    >
      {children}
    </button>
  );
}

/**
 * An image reference.
 *
 * Remote images load — badges at the top of a README are most of the images in
 * practice, and the app sets no CSP. A relative path can't be loaded: that
 * needs Tauri's asset protocol, which this feature isn't the place to enable,
 * so it shows the alt text as a labelled placeholder instead of a broken image.
 */
function MarkdownImage({ alt, src }: { alt: string; src: string }) {
  if (isSafeHref(src)) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="inline-block max-w-full align-middle"
      />
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ft-elevated text-ft-text-muted text-[11px]"
      title={`${src} — local images aren't loaded in the preview`}
    >
      {alt || "image"}
    </span>
  );
}

function renderInline(text: string, keyPrefix: string, ctx: Context): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = inlineMatcher();
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith("\\")) {
      // An escape renders the character it protected, and nothing else.
      nodes.push(token.slice(1));
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="px-1 py-0.5 rounded bg-ft-elevated font-mono text-[11px] text-ft-text"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("![")) {
      const split = token.indexOf("](");
      nodes.push(
        <MarkdownImage
          key={key}
          alt={token.slice(2, split)}
          src={hrefOf(token.slice(split + 2, -1))}
        />
      );
    } else if (token.startsWith("[^")) {
      const label = token.slice(2, -1);
      if (!ctx.footnotes.has(label)) {
        // No definition for it — GitHub leaves the brackets visible, and so
        // does this rather than swallowing text the author can't see.
        nodes.push(token);
      } else {
        if (!ctx.cited.includes(label)) ctx.cited.push(label);
        nodes.push(
          <sup key={key} className="text-ft-accent text-[9px] align-super">
            [{ctx.cited.indexOf(label) + 1}]
          </sup>
        );
      }
    } else if (token.startsWith("[") && token.includes("](")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = hrefOf(token.slice(split + 2, -1));
      nodes.push(
        <MarkdownLink key={key} href={href} ctx={ctx}>
          {label ? renderInline(label, key, ctx) : href}
        </MarkdownLink>
      );
    } else if (token.startsWith("[") && token.includes("][")) {
      // `[text][ref]`, and `[text][]` which reuses the text as the label.
      const split = token.indexOf("][");
      const label = token.slice(1, split);
      const href = ctx.refs.get((token.slice(split + 2, -1) || label).toLowerCase());
      nodes.push(
        href ? (
          <MarkdownLink key={key} href={href} ctx={ctx}>
            {renderInline(label, key, ctx)}
          </MarkdownLink>
        ) : (
          token
        )
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold text-ft-text">
          {renderInline(token.slice(2, -2), key, ctx)}
        </strong>
      );
    } else if (token.startsWith("~~")) {
      nodes.push(
        <del key={key} className="line-through opacity-80">
          {renderInline(token.slice(2, -2), key, ctx)}
        </del>
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(token.slice(1, -1), key, ctx)}
        </em>
      );
    } else {
      // A bare URL, or a `www.` autolink which needs a scheme to be openable.
      const href = token.startsWith("www.") ? `https://${token}` : token;
      nodes.push(
        <MarkdownLink key={key} href={href} ctx={ctx}>
          {token}
        </MarkdownLink>
      );
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * Splits a paragraph on hard line breaks.
 *
 * Two trailing spaces, or a trailing backslash, mean "break here" in GFM. The
 * paragraph collector joins its lines with a space, so without this an address
 * block or a stanza came out as one run-on line.
 */
function withHardBreaks(lines: string[], keyPrefix: string, ctx: Context): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run: string[] = [];
  let part = 0;

  const flush = () => {
    if (run.length === 0) return;
    out.push(...renderInline(run.join(" "), `${keyPrefix}-p${part++}`, ctx));
    run = [];
  };

  lines.forEach((line, index) => {
    const hard = /( {2,}|\\)$/.test(line);
    run.push(line.replace(/( {2,}|\\)$/, "").trim());
    if (hard && index < lines.length - 1) {
      flush();
      out.push(<br key={`${keyPrefix}-br${index}`} />);
    }
  });
  flush();
  return out;
}

// ─── Lists ──────────────────────────────────────────────────────────────────

/** How deep a list item is indented, counting a tab as two spaces. */
function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, "  ").length : 0;
}

function isListItem(line: string): boolean {
  return BULLET.test(line) || NUMBERED.test(line);
}

interface ListItemNode {
  text: string;
  children: ListNode | null;
}

interface ListNode {
  ordered: boolean;
  /** The first item's number, so a list written `3.` starts at three. */
  start: number;
  items: ListItemNode[];
}

/**
 * Reads one list, including its sublists.
 *
 * Nesting is by indentation, which is what makes this recursive: a flat parser
 * rendered `- a` / `  - b` as siblings, so every nested README list came out
 * flat. An item indented at least two columns past its parent starts a sublist;
 * a shallower one ends this list and hands the line back to the caller.
 */
function parseList(lines: string[], start: number): [ListNode, number] {
  const base = indentOf(lines[start]);
  const ordered = NUMBERED.test(lines[start]);
  const firstNumber = ordered ? Number(lines[start].match(NUMBERED)![2]) : 1;
  const items: ListItemNode[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      // A blank line only ends the list if what follows isn't more of it —
      // "loose" lists in GFM have blank lines between their items.
      const next = lines[index + 1];
      if (next && isListItem(next) && indentOf(next) >= base) {
        index++;
        continue;
      }
      break;
    }

    const indent = indentOf(line);

    if (!isListItem(line)) {
      // An indented continuation line belongs to the item above it.
      if (indent >= base + 2 && items.length > 0) {
        items[items.length - 1].text += ` ${line.trim()}`;
        index++;
        continue;
      }
      break;
    }

    if (indent < base) break;

    if (indent >= base + 2) {
      const [child, next] = parseList(lines, index);
      if (items.length > 0) items[items.length - 1].children = child;
      index = next;
      continue;
    }

    const match = line.match(ordered ? NUMBERED : BULLET);
    // A marker change at the same depth (`-` becoming `1.`) starts a new list.
    if (!match) break;
    items.push({ text: ordered ? match[3] : match[2], children: null });
    index++;
  }

  return [{ ordered, start: firstNumber, items }, index];
}

function renderList(node: ListNode, keyPrefix: string, ctx: Context): React.ReactNode {
  // A checkbox list drops its bullets — two markers per line reads as a
  // rendering mistake.
  const isTaskList =
    !node.ordered && node.items.length > 0 && node.items.every((i) => TASK_ITEM.test(i.text));

  const content = node.items.map((item, i) => {
    const itemKey = `${keyPrefix}-${i}`;
    const task = item.text.match(TASK_ITEM);
    const sublist = item.children ? renderList(item.children, `${itemKey}-s`, ctx) : null;

    if (task) {
      const done = task[1].toLowerCase() === "x";
      return (
        <li key={itemKey} className="ml-1 list-none">
          <span className="flex items-baseline gap-2">
            <span
              aria-hidden
              className={`shrink-0 font-mono ${done ? "text-ft-success" : "text-ft-text-muted"}`}
            >
              {done ? "✓" : "○"}
            </span>
            <span className={done ? "text-ft-text-muted" : undefined}>
              {renderInline(task[2], itemKey, ctx)}
            </span>
          </span>
          {sublist}
        </li>
      );
    }

    return (
      <li key={itemKey} className="ml-4 list-outside">
        {renderInline(item.text, itemKey, ctx)}
        {sublist}
      </li>
    );
  });

  return node.ordered ? (
    <ol
      key={keyPrefix}
      start={node.start === 1 ? undefined : node.start}
      className="my-1.5 space-y-1 list-decimal"
    >
      {content}
    </ol>
  ) : (
    <ul key={keyPrefix} className={`my-1.5 space-y-1 ${isTaskList ? "list-none" : "list-disc"}`}>
      {content}
    </ul>
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

/** The `|---|:--:|` line that turns the row above it into a table header. */
function isTableRule(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    lines[index].includes("|") && index + 1 < lines.length && isTableRule(lines[index + 1])
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignmentOf(rule: string): "left" | "center" | "right" {
  const left = rule.startsWith(":");
  const right = rule.endsWith(":");
  if (left && right) return "center";
  return right ? "right" : "left";
}

// ─── Headings ───────────────────────────────────────────────────────────────

/**
 * A heading, at the size its level and variant call for.
 *
 * `data-md-line` carries the source line in the document variant — the
 * preview's scroll sync and its outline both look headings up by it, so the
 * numbers have to match what `parseOutline` computes from the same text.
 */
function renderHeading(
  level: number,
  text: string,
  sourceLine: number,
  ctx: Context
): React.ReactNode {
  const key = ctx.next();
  const compactSize = level <= 2 ? "text-xs" : "text-[11px]";
  const docSize =
    level === 1
      ? "text-lg"
      : level === 2
        ? "text-[15px]"
        : level === 3
          ? "text-[13.5px]"
          : "text-[12.5px]";

  return (
    <div
      key={key}
      data-md-line={ctx.doc ? sourceLine : undefined}
      className={
        ctx.doc
          ? // A rule under the top two levels is what makes a long document
            // scannable; deeper headings would only add noise.
            `${docSize} font-semibold text-ft-text mt-5 mb-2 first:mt-0 ${
              level <= 2 ? "pb-1 border-b border-ft-border-subtle" : ""
            }`
          : `${compactSize} font-semibold text-ft-text mt-4 mb-1.5 first:mt-0`
      }
    >
      {renderInline(text, key, ctx)}
    </div>
  );
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

/**
 * Renders a run of lines.
 *
 * Recursive, because a blockquote can hold anything a document can — lists,
 * code, nested quotes, an alert. Flattening quoted content into a single inline
 * run was the old behaviour and lost all of that.
 *
 * `lineOffset` keeps `data-md-line` honest inside nested content: the numbers
 * have to stay relative to the original file for the preview's scroll sync to
 * land on the right heading.
 */
function renderBlocks(lines: string[], ctx: Context, lineOffset = 0): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const { doc } = ctx;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    // Fenced code
    const fence = line.match(FENCE);
    if (fence) {
      const language = fence[1];
      const body: string[] = [];
      index++;
      while (index < lines.length && !FENCE_ANY.test(lines[index])) {
        body.push(lines[index]);
        index++;
      }
      index++; // the closing fence, or the end of input
      blocks.push(
        <div key={ctx.next()} className="relative">
          {/* The fence's language, where it declared one — worth seeing in a
              document full of shell and config snippets. */}
          {doc && language && (
            <span className="absolute right-2.5 top-2.5 text-[9px] uppercase tracking-wide text-ft-text-muted">
              {language}
            </span>
          )}
          <pre className={doc ? CODE_DOC : CODE_COMPACT}>
            <code>{body.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    /*
      Collapsed section.

      The one piece of HTML this renders, matched as whole lines with nothing
      carried across: `<details>` is too common in READMEs to drop, and a real
      `<details>` element is the only way to make it behave like one.
    */
    if (/^\s*<details>\s*$/i.test(line)) {
      const body: string[] = [];
      let summary = "Details";
      let depth = 1;
      const openedAt = index;
      index++;

      while (index < lines.length) {
        const inner = lines[index];
        if (/^\s*<details>\s*$/i.test(inner)) depth++;
        if (/^\s*<\/details>\s*$/i.test(inner)) {
          depth--;
          if (depth === 0) {
            index++;
            break;
          }
        }
        const heading = inner.match(/^\s*<summary>(.*)<\/summary>\s*$/i);
        if (heading && depth === 1) summary = heading[1];
        else body.push(inner);
        index++;
      }

      const key = ctx.next();
      blocks.push(
        <details
          key={key}
          className="my-2 rounded-lg border border-ft-border-subtle px-3 py-2"
        >
          <summary className="cursor-pointer text-ft-text font-medium">
            {renderInline(summary, key, ctx)}
          </summary>
          <div className="mt-1.5">{renderBlocks(body, ctx, lineOffset + openedAt + 1)}</div>
        </details>
      );
      continue;
    }

    // Blockquote, which may be an alert
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      const openedAt = index;
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        // One level of `>` comes off here; anything deeper recurses as a
        // nested quote when these lines are rendered.
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index++;
      }

      const alert = quoted[0]?.match(ALERT);
      if (alert) {
        const style = ALERT_STYLES[alert[1].toUpperCase()];
        blocks.push(
          <div key={ctx.next()} className={`my-2.5 pl-3 border-l-[3px] ${style.border}`}>
            <div
              className={`text-[11px] font-semibold uppercase tracking-wide ${style.text}`}
            >
              {style.label}
            </div>
            <div className="mt-0.5">
              {renderBlocks(quoted.slice(1), ctx, lineOffset + openedAt + 1)}
            </div>
          </div>
        );
        continue;
      }

      blocks.push(
        <blockquote
          key={ctx.next()}
          className="my-2 pl-3 border-l-2 border-ft-border-subtle text-ft-text-muted"
        >
          {renderBlocks(quoted, ctx, lineOffset + openedAt)}
        </blockquote>
      );
      continue;
    }

    // ATX heading
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push(renderHeading(heading[1].length, heading[2], lineOffset + index + 1, ctx));
      index++;
      continue;
    }

    /*
      Setext heading — a line of text underlined with `===` or `---`.

      Checked before the horizontal rule and the table, both of which the
      underline would otherwise match. The line above has to be ordinary text:
      without that guard, a `---` closing a table or following a list would
      promote the wrong line to a heading.
    */
    const underline = lines[index + 1]?.match(SETEXT);
    if (underline && !isListItem(line) && !isTableStart(lines, index) && !FENCE_ANY.test(line)) {
      blocks.push(
        renderHeading(
          underline[1].startsWith("=") ? 1 : 2,
          line.trim(),
          lineOffset + index + 1,
          ctx
        )
      );
      index += 2;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={ctx.next()} className="my-3 border-ft-border-subtle" />);
      index++;
      continue;
    }

    // Table
    if (isTableStart(lines, index)) {
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]).map(alignmentOf);
      index += 2;

      const body: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        body.push(splitRow(lines[index]));
        index++;
      }

      const tableKey = ctx.next();
      blocks.push(
        <div key={tableKey} className="my-3 overflow-x-auto">
          <table className="border-collapse text-left">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th
                    key={`${tableKey}-h${i}`}
                    className="border border-ft-border-subtle px-2.5 py-1.5 font-semibold text-ft-text bg-ft-elevated"
                    style={{ textAlign: align[i] ?? "left" }}
                  >
                    {renderInline(cell, `${tableKey}-h${i}`, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={`${tableKey}-r${r}`}>
                  {/* Padded to the header's width: a short row would otherwise
                      collapse the grid for every row after it. */}
                  {header.map((_, c) => (
                    <td
                      key={`${tableKey}-r${r}c${c}`}
                      className="border border-ft-border-subtle px-2.5 py-1.5 align-top"
                      style={{ textAlign: align[c] ?? "left" }}
                    >
                      {renderInline(row[c] ?? "", `${tableKey}-r${r}c${c}`, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Lists
    if (isListItem(line)) {
      const [tree, next] = parseList(lines, index);
      index = next;
      blocks.push(renderList(tree, ctx.next(), ctx));
      continue;
    }

    /*
      Indented code — four spaces. Inside a list those same four spaces mean a
      continuation line, which `parseList` has already claimed by the time this
      is reached.
    */
    if (/^ {4}\S/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (/^ {4}/.test(lines[index]) || !lines[index].trim())) {
        body.push(lines[index].slice(4));
        index++;
      }
      while (body.length > 0 && !body[body.length - 1].trim()) body.pop();
      blocks.push(
        <pre key={ctx.next()} className={doc ? CODE_DOC : CODE_COMPACT}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s{0,3}(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|<details>)/i.test(lines[index]) &&
      !isTableStart(lines, index) &&
      !SETEXT.test(lines[index + 1] ?? "")
    ) {
      paragraph.push(lines[index]);
      index++;
    }

    if (paragraph.length === 0) {
      // Nothing consumable here — take the line as text so the loop can't spin.
      paragraph.push(lines[index]);
      index++;
    }

    const paraKey = ctx.next();
    blocks.push(
      <p key={paraKey} className="my-1.5 leading-relaxed">
        {withHardBreaks(paragraph, paraKey, ctx)}
      </p>
    );
  }

  return blocks;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Pulls the definitions out before rendering.
 *
 * Link and footnote definitions can appear anywhere in a document but belong to
 * references that may come earlier, so they have to be collected in a pass of
 * their own. Their lines are blanked rather than removed, which keeps every
 * later line at its original number — `data-md-line` depends on that.
 */
function collectDefinitions(
  lines: string[],
  refs: Map<string, string>,
  footnotes: Map<string, string>
): string[] {
  const out = [...lines];
  let insideFence = false;

  for (let i = 0; i < out.length; i++) {
    if (FENCE_ANY.test(out[i])) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const footnote = out[i].match(FOOTNOTE_DEFINITION);
    if (footnote) {
      const body = [footnote[2]];
      let j = i + 1;
      // Indented lines continue the note.
      while (j < out.length && /^\s{2,}\S/.test(out[j])) {
        body.push(out[j].trim());
        out[j] = "";
        j++;
      }
      footnotes.set(footnote[1], body.join(" ").trim());
      out[i] = "";
      i = j - 1;
      continue;
    }

    const link = out[i].match(LINK_DEFINITION);
    if (link) {
      refs.set(link[1].toLowerCase(), link[2]);
      out[i] = "";
    }
  }

  return out;
}

export function Markdown({
  source,
  variant = "compact",
  onFollowLink,
}: {
  source: string;
  variant?: MarkdownVariant;
  /**
   * Follows a link that isn't `http(s)` — a sibling file or an in-page anchor.
   * Without it those render as plain text, which is what release notes want.
   */
  onFollowLink?: (href: string) => void;
}) {
  const doc = variant === "document";
  const refs = new Map<string, string>();
  const footnotes = new Map<string, string>();
  let counter = 0;

  const ctx: Context = {
    doc,
    onFollow: onFollowLink,
    refs,
    footnotes,
    cited: [],
    next: () => `b${counter++}`,
  };

  const lines = collectDefinitions(
    source.replace(/\r\n/g, "\n").split("\n"),
    refs,
    footnotes
  );

  const blocks = renderBlocks(lines, ctx);

  // Footnotes go at the end, numbered in the order they were referenced —
  // which is what GitHub does, and what the superscripts above already assume.
  const notes = ctx.cited.map((label, index) => (
    <li key={`fn-${label}`} className="ml-4 list-decimal">
      {renderInline(footnotes.get(label) ?? "", `fn-${index}`, ctx)}
    </li>
  ));

  return (
    <div
      className={
        doc
          ? "text-[13px] text-ft-text-secondary leading-relaxed"
          : "text-[11px] text-ft-text-secondary"
      }
    >
      {blocks}
      {notes.length > 0 && (
        <>
          <hr className="mt-5 mb-2 border-ft-border-subtle" />
          <ol className="space-y-1 text-[11px]">{notes}</ol>
        </>
      )}
    </div>
  );
}
