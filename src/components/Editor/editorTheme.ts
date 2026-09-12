import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/**
 * The editor's look, in both themes.
 *
 * Two things this deliberately does not do:
 *
 * - **It doesn't read the CSS custom properties.** CodeMirror wants colours as
 *   values, and `var(--ft-text)` inside a generated stylesheet resolves against
 *   the editor's own DOM — which works for plain declarations but not for the
 *   places CodeMirror composes colours (selection blending, the cursor's
 *   `caret-color`). The palette below mirrors the tokens in `styles.css`; the
 *   two are kept in step by hand, as `Terminal.tsx` already does for xterm.
 * - **It doesn't port a stock dark palette.** One Dark and friends assume a dark
 *   ground, and this app has a genuinely light theme — most ported palettes are
 *   unreadable on it. Each side is picked against its own background, in the
 *   same families as the terminal's ANSI colours so a file and the shell that
 *   printed it don't look like two different applications.
 */

interface Palette {
  background: string;
  foreground: string;
  gutter: string;
  gutterText: string;
  gutterActive: string;
  activeLine: string;
  selection: string;
  selectionMatch: string;
  cursor: string;
  border: string;
  panel: string;
  searchMatch: string;
  searchMatchActive: string;
  tooltip: string;
  tooltipSelected: string;
  fold: string;
  gitAdded: string;
  gitModified: string;
  gitDeleted: string;
  indentGuide: string;
  indentGuideActive: string;
}

const DARK: Palette = {
  background: "#12151a",
  foreground: "#e6edf3",
  gutter: "#12151a",
  gutterText: "#4a5361",
  gutterActive: "#8b949e",
  activeLine: "rgba(255, 255, 255, 0.035)",
  selection: "rgba(99, 102, 241, 0.32)",
  selectionMatch: "rgba(99, 102, 241, 0.16)",
  cursor: "#6366f1",
  border: "#2a2f37",
  panel: "#1e2228",
  searchMatch: "rgba(251, 191, 36, 0.28)",
  searchMatchActive: "rgba(249, 115, 22, 0.55)",
  tooltip: "#1e2228",
  tooltipSelected: "rgba(99, 102, 241, 0.22)",
  fold: "#8b949e",
  // The same three the file tree and the source-control panel use, so a
  // changed line and a changed row agree about what colour "modified" is.
  gitAdded: "#3fb950",
  gitModified: "#d29922",
  gitDeleted: "#f85149",
  // Faint on purpose: a guide is a hint about structure, and one strong enough
  // to read is one competing with the code for attention.
  indentGuide: "rgba(255, 255, 255, 0.09)",
  // The active one is the exception, and it has to be several times the faint
  // one to read as "this block" at a glance rather than as an artefact. Not the
  // cursor's indigo, though: the caret and the selection already own that, and
  // a third indigo thing on screen stops any of them meaning anything.
  indentGuideActive: "rgba(255, 255, 255, 0.34)",
};

const LIGHT: Palette = {
  background: "#ffffff",
  foreground: "#1a1d27",
  gutter: "#ffffff",
  gutterText: "#b3bac6",
  gutterActive: "#4b5163",
  activeLine: "rgba(0, 0, 0, 0.028)",
  selection: "rgba(79, 70, 229, 0.18)",
  selectionMatch: "rgba(79, 70, 229, 0.1)",
  cursor: "#4f46e5",
  border: "#e2e5eb",
  panel: "#f7f8fa",
  searchMatch: "rgba(217, 119, 6, 0.22)",
  searchMatchActive: "rgba(234, 88, 12, 0.4)",
  tooltip: "#ffffff",
  tooltipSelected: "rgba(79, 70, 229, 0.12)",
  fold: "#6b7280",
  gitAdded: "#1a7f37",
  gitModified: "#9a6700",
  gitDeleted: "#cf222e",
  indentGuide: "rgba(0, 0, 0, 0.09)",
  indentGuideActive: "rgba(0, 0, 0, 0.32)",
};

const DARK_SYNTAX = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#7d8590", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#ff7b72" },
  { tag: [t.definitionKeyword, t.self], color: "#ff7b72" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6ff" },
  { tag: [t.escape], color: "#79c0ff" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#d2a8ff" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "#ffa657" },
  { tag: [t.propertyName, t.attributeName], color: "#79c0ff" },
  { tag: [t.tagName], color: "#7ee787" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#e6edf3" },
  { tag: [t.operator, t.derefOperator, t.punctuation, t.bracket], color: "#8b949e" },
  { tag: [t.meta], color: "#8b949e" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#a5d6ff", textDecoration: "underline" },
  { tag: t.quote, color: "#7ee787" },
  { tag: t.inserted, color: "#3fb950" },
  { tag: t.deleted, color: "#f85149" },
  { tag: t.changed, color: "#d29922" },
  { tag: t.invalid, color: "#f85149", textDecoration: "underline wavy" },
]);

const LIGHT_SYNTAX = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#cf222e" },
  { tag: [t.definitionKeyword, t.self], color: "#cf222e" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  { tag: [t.escape], color: "#0550ae" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0550ae" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "#953800" },
  { tag: [t.propertyName, t.attributeName], color: "#0550ae" },
  { tag: [t.tagName], color: "#116329" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#1a1d27" },
  { tag: [t.operator, t.derefOperator, t.punctuation, t.bracket], color: "#57606a" },
  { tag: [t.meta], color: "#57606a" },
  { tag: t.heading, color: "#0550ae", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#0a3069", textDecoration: "underline" },
  { tag: t.quote, color: "#116329" },
  { tag: t.inserted, color: "#059669" },
  { tag: t.deleted, color: "#dc2626" },
  { tag: t.changed, color: "#d97706" },
  { tag: t.invalid, color: "#dc2626", textDecoration: "underline wavy" },
]);

export interface ThemeOptions {
  dark: boolean;
  fontFamily: string;
  fontSize: number;
  /** Unitless, so it scales with the font size rather than fighting it. */
  lineHeight: number;
}

/**
 * The editor chrome's colours and metrics.
 *
 * The font comes from the terminal's own settings, so the editor and the shell
 * next to it render code in the same face. Line height does not: 1.2 is right
 * for a terminal packing rows in and too tight for reading a file, so this
 * takes 1.55 regardless.
 */
export function editorTheme({
  dark,
  fontFamily,
  fontSize,
  lineHeight,
}: ThemeOptions): Extension {
  const p = dark ? DARK : LIGHT;

  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          color: p.foreground,
          backgroundColor: p.background,
          fontSize: `${fontSize}px`,
        },
        ".cm-scroller": {
          fontFamily,
          lineHeight: String(lineHeight),
          overflow: "auto",
        },
        ".cm-content": {
          caretColor: p.cursor,
          padding: "6px 0",
        },
        ".cm-gutters": {
          backgroundColor: p.gutter,
          color: p.gutterText,
          border: "none",
          // Without this the gutter's right edge sits flush against the first
          // character of every line.
          paddingRight: "4px",
          userSelect: "none",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          padding: "0 6px 0 12px",
          minWidth: "36px",
        },
        /*
          A line's padding, set here rather than left to CodeMirror's default,
          because the indent guides are positioned against it and a number
          nobody owns is a number that moves.
        */
        ".cm-content .cm-line": { padding: "0 2px 0 6px" },

        /*
          The indent guides. One pseudo-element per line, not a node per level:
          a repeating gradient draws a hairline every `--cm-indent-width`
          columns, and the element's own width — `--cm-indent-depth` of them —
          is what stops it at the last level instead of ruling the whole line.
          A line twelve levels deep therefore costs one style attribute.

          `ch` is the unit that matters: the editor is monospaced, so one
          character is one column, and the guides line up with the text at any
          font size without being told what it is.
        */
        ".cm-indent-guides": { position: "relative" },
        ".cm-indent-guides::before": {
          backgroundImage: `linear-gradient(to right, ${p.indentGuide} 0 1px, transparent 1px 100%)`,
          backgroundSize: "var(--cm-indent-width) 100%",
          bottom: "0",
          content: '""',
          // The line's own padding-left, so the first guide sits at column
          // zero of the text rather than at the edge of the element.
          left: "6px",
          pointerEvents: "none",
          position: "absolute",
          top: "0",
          width: "calc(var(--cm-indent-depth) * var(--cm-indent-width))",
        },

        /*
          The active guide: one more hairline, painted over the faint one at the
          same column. A second element rather than a gap in the gradient
          because a repeating gradient cannot colour one of its stripes
          differently — and it only exists on the lines of the block the cursor
          is in, so an idle file draws none of them.
        */
        ".cm-indent-active::after": {
          backgroundColor: p.indentGuideActive,
          bottom: "0",
          content: '""',
          left: "calc(6px + var(--cm-indent-active) * var(--cm-indent-width))",
          pointerEvents: "none",
          position: "absolute",
          top: "0",
          width: "1px",
        },
        ".cm-activeLine": { backgroundColor: p.activeLine },
        ".cm-activeLineGutter": {
          backgroundColor: "transparent",
          color: p.gutterActive,
        },
        ".cm-foldGutter .cm-gutterElement": {
          color: p.gutterText,
          cursor: "pointer",
        },
        ".cm-foldGutter .cm-gutterElement:hover": { color: p.gutterActive },
        ".cm-foldPlaceholder": {
          backgroundColor: "transparent",
          border: `1px solid ${p.border}`,
          borderRadius: "3px",
          color: p.fold,
          margin: "0 3px",
          padding: "0 4px",
        },
        "&.cm-focused .cm-cursor": { borderLeftColor: p.cursor, borderLeftWidth: "2px" },
        ".cm-selectionBackground, ::selection": { backgroundColor: p.selection },
        "&.cm-focused .cm-selectionBackground, &.cm-focused ::selection": {
          backgroundColor: p.selection,
        },
        ".cm-selectionMatch": { backgroundColor: p.selectionMatch },
        ".cm-searchMatch": {
          backgroundColor: p.searchMatch,
          outline: "none",
          borderRadius: "2px",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: p.searchMatchActive,
        },
        ".cm-matchingBracket, .cm-nonmatchingBracket": {
          backgroundColor: "transparent",
          outline: `1px solid ${p.border}`,
          borderRadius: "2px",
        },
        /*
          The change gutter, beside the line numbers. A `border-left` rather
          than a filled cell, because a full-width block of colour next to
          every changed line competes with the text for attention — which is
          the whole difference between a diff view and a hint that something
          changed.
        */
        ".cm-git-gutter": {
          backgroundColor: p.gutter,
          minWidth: "3px",
          padding: "0",
        },
        ".cm-git-gutter .cm-gutterElement": { padding: "0" },
        ".cm-git-change": { borderLeft: "3px solid transparent" },
        ".cm-git-added": { borderLeftColor: p.gitAdded },
        ".cm-git-modified": { borderLeftColor: p.gitModified },
        /*
          A deletion has no line of its own, so it can't be a full-height bar
          without claiming a line that didn't change. A wedge at the top of the
          line the gap is above is how every editor draws it.
        */
        ".cm-git-deleted": {
          borderLeftColor: "transparent",
          position: "relative",
        },
        ".cm-git-deleted::before": {
          backgroundColor: p.gitDeleted,
          content: '""',
          height: "3px",
          left: "0",
          position: "absolute",
          top: "0",
          width: "3px",
        },
        /*
          CodeMirror's panel container, stripped back to nothing. The find
          panel's markup is React (see `FindPanel`) and its look lives in
          `styles.css` with the rest of the editor chrome; what's left here is
          only the row CodeMirror reserves for it.
        */
        ".cm-panels": {
          backgroundColor: "transparent",
          border: "none",
          color: p.foreground,
          fontSize: "11px",
        },
        ".cm-panels-top": { borderBottom: `1px solid ${p.border}` },
        ".cm-panels-bottom": { borderTop: `1px solid ${p.border}` },
        ".cm-tooltip": {
          backgroundColor: p.tooltip,
          border: `1px solid ${p.border}`,
          borderRadius: "6px",
          boxShadow: dark
            ? "0 8px 24px rgba(0, 0, 0, 0.5)"
            : "0 8px 24px rgba(0, 0, 0, 0.12)",
          fontSize: "11px",
        },
        /*
          The hover and signature tooltips.

          They inherit the box from `.cm-tooltip` above; what they need on top
          is room to breathe and a ceiling. A language server's hover can be an
          entire doc comment, and without a bound it grows until it covers the
          code it is describing.
        */
        ".cm-tooltip.cm-tooltip-hover": {
          padding: "0",
          maxWidth: "min(560px, 90vw)",
        },
        /*
          CodeMirror draws the arrow with two stacked triangles — a border
          colour behind a background colour. Both are hardcoded in its base
          theme, so without this the arrow keeps the library's grey and points
          at the tooltip with a visible seam.
        */
        ".cm-tooltip.cm-tooltip-hover .cm-tooltip-arrow:before": {
          borderTopColor: p.border,
          borderBottomColor: p.border,
        },
        ".cm-tooltip.cm-tooltip-hover .cm-tooltip-arrow:after": {
          borderTopColor: p.tooltip,
          borderBottomColor: p.tooltip,
        },
        // Two hovers at one position — a type and a diagnostic, say — arrive as
        // separate sections and need a rule between them.
        ".cm-tooltip-section + .cm-tooltip-section": {
          borderTop: `1px solid ${p.border}`,
        },
        /*
          The completion list's *font* only. Its row layout, icons and selected
          state live in `styles.css` alongside the rest of the LSP presentation
          — two owners for one list is how the icons ended up at 0.6 opacity in
          one file and 1 in the other.
        */
        ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          backgroundColor: p.tooltipSelected,
          color: p.foreground,
        },
      },
      { dark }
    ),
    syntaxHighlighting(dark ? DARK_SYNTAX : LIGHT_SYNTAX),
  ];
}
