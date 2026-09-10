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
}

/**
 * The editor chrome's colours and metrics.
 *
 * The font comes from the terminal's own settings, so the editor and the shell
 * next to it render code in the same face. Line height does not: 1.2 is right
 * for a terminal packing rows in and too tight for reading a file, so this
 * takes 1.55 regardless.
 */
export function editorTheme({ dark, fontFamily, fontSize }: ThemeOptions): Extension {
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
          lineHeight: "1.55",
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
        // CodeMirror's search-and-replace panel. Left mostly to CodeMirror's own
        // markup, recoloured — reimplementing it as React would mean
        // reimplementing its keymap too.
        ".cm-panels": {
          backgroundColor: p.panel,
          color: p.foreground,
          borderTop: `1px solid ${p.border}`,
          fontSize: "11px",
        },
        ".cm-panel.cm-search": { padding: "6px 8px" },
        ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
          fontFamily: "inherit",
          fontSize: "11px",
        },
        ".cm-panel.cm-search input": {
          backgroundColor: dark ? "rgba(255,255,255,0.05)" : "#ffffff",
          border: `1px solid ${p.border}`,
          borderRadius: "4px",
          color: p.foreground,
          padding: "3px 6px",
          outline: "none",
        },
        ".cm-panel.cm-search input:focus": { borderColor: p.cursor },
        ".cm-panel.cm-search button": {
          backgroundColor: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
          backgroundImage: "none",
          border: `1px solid ${p.border}`,
          borderRadius: "4px",
          color: p.foreground,
          cursor: "pointer",
          padding: "3px 8px",
          margin: "0 2px",
        },
        ".cm-panel.cm-search button:hover": { borderColor: p.cursor },
        ".cm-panel.cm-search [name=close]": {
          color: p.gutterActive,
          fontSize: "16px",
          padding: "0 6px",
        },
        ".cm-tooltip": {
          backgroundColor: p.tooltip,
          border: `1px solid ${p.border}`,
          borderRadius: "6px",
          boxShadow: dark
            ? "0 8px 24px rgba(0, 0, 0, 0.5)"
            : "0 8px 24px rgba(0, 0, 0, 0.12)",
          fontSize: "11px",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul": {
          fontFamily,
          maxHeight: "180px",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          backgroundColor: p.tooltipSelected,
          color: p.foreground,
        },
        ".cm-completionIcon": { opacity: 0.6, paddingRight: "6px" },
      },
      { dark }
    ),
    syntaxHighlighting(dark ? DARK_SYNTAX : LIGHT_SYNTAX),
  ];
}
