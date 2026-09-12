/**
 * Everything a language server contributes to one buffer, as one extension.
 *
 * Assembled here so that `EditorSurface` deals with a single value it can put
 * in a compartment: turning the feature off is reconfiguring that compartment
 * to `[]`, which drops the sync plugin, the diagnostics subscription, the
 * tooltips and the keymap together and leaves the buffer's undo history, folds
 * and selection exactly where they were.
 */

import { autocompletion } from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";
import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isMac } from "../../../services/platform";
import { lsp, LspSession } from "../../../services/lsp/manager";
import {
  codeActions,
  findReferences,
  formatDocument,
  goToDefinition,
  goToSymbol,
  renameSymbol,
  setDiagnosticSource,
} from "./actions";
import { completion } from "./completion";
import { definitionLink } from "./definitionLink";
import { diagnostics } from "./diagnostics";
import { hover } from "./hover";
import { closePopup } from "./popup";
import { signatureHelp } from "./signature";
import { documentSync } from "./sync";

export type { LspHost } from "./actions";
export { setLspHost } from "./actions";
export { documentOutline } from "./actions";

// `actions.ts` needs a diagnostic's original LSP form to ask for its quick
// fixes, and the manager is the one store of those. Wired once, here, rather
// than by having the two modules import each other.
setDiagnosticSource((session) => lsp.diagnosticsFor(session.uri));

export interface LspExtensionOptions {
  /** What a level of indentation is, for the formatter. */
  indent: () => { useTabs: boolean; width: number };
}

/**
 * The keymap.
 *
 * `Prec.high` for the same reason the editor's own chords are: several of these
 * collide with CodeMirror's defaults, and a language server's go-to-definition
 * should win over a text-level binding when one is attached.
 *
 * Bound to the **primary** session. A companion like Tailwind answers about
 * class names and has no opinion on where a symbol is defined; asking it would
 * get a null and lose the answer the real server had.
 */
function lspKeymap(session: LspSession, options: LspExtensionOptions): Extension {
  const format = (view: EditorView) => {
    const { useTabs, width } = options.indent();
    void formatDocument(view, session, { tabSize: width, insertSpaces: !useTabs });
    return true;
  };

  return Prec.high(
    keymap.of([
      // F12 is the cross-editor convention; ⌃⌘Down is what macOS editors use
      // when F12 is taken by the system.
      { key: "F12", preventDefault: true, run: (view) => (void goToDefinition(view, session), true) },
      {
        key: isMac ? "Mod-Alt-ArrowDown" : "Ctrl-F12",
        preventDefault: true,
        run: (view) => (void goToDefinition(view, session), true),
      },
      {
        key: "Shift-F12",
        preventDefault: true,
        run: (view) => (void findReferences(view, session), true),
      },
      { key: "F2", preventDefault: true, run: (view) => (void renameSymbol(view, session), true) },
      {
        key: isMac ? "Shift-Alt-f" : "Ctrl-Shift-i",
        preventDefault: true,
        run: format,
      },
      // ⌘. is the quick-fix chord everywhere that has one.
      { key: "Mod-.", preventDefault: true, run: (view) => (void codeActions(view, session), true) },
      // ⌘⇧O, as in every editor that has a go-to-symbol.
      {
        key: "Mod-Shift-o",
        preventDefault: true,
        run: (view) => (void goToSymbol(view, session), true),
      },
    ])
  );
}

/**
 * The whole feature, for one buffer.
 *
 * `sessions` is empty for a buffer with no server — most of them — and the
 * extension is then empty rather than a set of no-ops, so a Markdown file with
 * nothing installed costs nothing at all.
 *
 * More than one session means a **companion** is attached: Tailwind alongside
 * the CSS or TypeScript server. The two kinds are treated differently on
 * purpose. Anything that produces a *list* — diagnostics, completion, hover —
 * merges across every session, because both have things to say. Anything that
 * produces *one answer* — go to definition, rename, format — goes to the
 * primary alone, because a companion would answer null and lose the real one.
 */
export function lspExtension(
  sessions: LspSession[],
  options: LspExtensionOptions
): Extension {
  if (!sessions.length) return [];
  const primary = sessions[0];

  return [
    // Every server needs its own copy of the document.
    sessions.map((session) => documentSync(session)),
    diagnostics(sessions),
    lintGutter(),
    // CodeMirror merges tooltips at one position into sections, so both a type
    // and a Tailwind class preview can show at once.
    sessions.map((session) => hover(session)),
    signatureHelp(primary),
    /*
      One `autocompletion` with a source per server — the facet takes a list.
      Two *extensions* would be a config conflict; two *sources* is exactly
      what it is for.

      These replace the word-completion source rather than joining it; see
      `completion.ts`.
    */
    autocompletion({
      override: sessions.map((session) => completion(session)),
      activateOnTyping: true,
      closeOnBlur: true,
      maxRenderedOptions: 60,
      /*
        A class on the dialog, so every completion rule in `styles.css` can be
        scoped to it. CodeMirror's own styles are plain single-class selectors
        injected into the head, and whether ours or theirs wins otherwise comes
        down to load order — which is how the matched text stayed underlined
        after being told not to be.
      */
      tooltipClass: () => "cm-lsp-completions",
      /*
        A class per row, rather than reaching the label through a sibling
        selector on the icon. `type` carries the kind and, for a deprecated
        API, the word `deprecated` — see `completion.ts` for why they travel
        together.
      */
      optionClass: (option) => {
        const kinds = (option.type ?? "text").split(" ");
        const deprecated = kinds.includes("deprecated") ? " is-deprecated" : "";
        return `cm-lsp-option cm-lsp-option-${kinds[0]}${deprecated}`;
      },
    }),
    lspKeymap(primary, options),
    // ⌘-hover underlines what can be navigated to, and ⌘-click follows it.
    definitionLink(primary, (view) => void goToDefinition(view, primary)),
  ];
}

export { closePopup };
