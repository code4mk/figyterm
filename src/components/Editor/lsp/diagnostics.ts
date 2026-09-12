/**
 * `publishDiagnostics` into the gutter.
 *
 * This is Phase 1 in `docs/LSP-TASKS.md`, and it is first for a reason: it is a
 * **push**. No request correlation, no cancellation, no outbound position
 * mapping — so it proves the transport, the framing, the lifecycle and the
 * encoding end to end while being the smallest thing that could.
 *
 * `@codemirror/lint` already owns the squiggle, the gutter marker and the
 * tooltip, so what happens here is only the conversion: LSP ranges into
 * document offsets, LSP severities into its four, and the server's own `source`
 * and `code` into something a reader can act on.
 */

import { Diagnostic as CmDiagnostic, setDiagnostics } from "@codemirror/lint";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { rangeToOffsets } from "../../../services/lsp/position";
import type { Diagnostic } from "../../../services/lsp/protocol";
import { DiagnosticSeverity } from "../../../services/lsp/protocol";
import { lsp, LspSession } from "../../../services/lsp/manager";
import { codeActionsFor } from "./actions";

function severityOf(severity: number | undefined): CmDiagnostic["severity"] {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Hint:
      return "hint";
    // The specification says a missing severity is the client's choice. An
    // error is the safe choice: under-reporting a real problem is worse than
    // over-reporting a note.
    default:
      return "info";
  }
}

/**
 * Where the diagnostic came from, as a short label.
 *
 * `ts(2322)` rather than `2322`, because on a project running both a
 * type-checker and a linter through one server, which tool is complaining is
 * usually the first thing you want to know.
 */
function labelOf(diagnostic: Diagnostic): string | undefined {
  const code = diagnostic.code === undefined ? "" : String(diagnostic.code);
  if (diagnostic.source && code) return `${diagnostic.source}(${code})`;
  return diagnostic.source || code || undefined;
}

/** Converts one server's diagnostics for the document currently in `view`. */
export function toCodeMirror(
  view: EditorView,
  session: LspSession,
  items: Diagnostic[]
): CmDiagnostic[] {
  const encoding = session.client?.encoding ?? "utf-16";
  const doc = view.state.doc;

  return items.map((item) => {
    const { from, to } = rangeToOffsets(doc, item.range, encoding);
    const related = item.relatedInformation
      ?.map((entry) => entry.message)
      .filter(Boolean)
      .join("\n");

    return {
      from,
      // A zero-width diagnostic is invisible. Widening it by one character is
      // what every editor does, and it is the difference between a squiggle
      // and nothing at all on "expected `;`".
      to: to > from ? to : Math.min(doc.length, from + 1),
      severity: severityOf(item.severity),
      source: labelOf(item),
      message: related ? `${item.message}\n\n${related}` : item.message,
      // The quick fixes for this diagnostic, fetched when the tooltip opens.
      actions: codeActionsFor(session, item),
    } satisfies CmDiagnostic;
  });
}

/**
 * Subscribes a buffer to its server's diagnostics.
 *
 * Push, not pull, so this doesn't go through `linter()` — there is no source
 * function to run and nothing to re-run it on. The plugin listens, converts and
 * dispatches, which is also what makes clearing work: a server that goes away
 * publishes an empty list through the manager and the squiggles disappear.
 */
export function diagnostics(sessions: LspSession[]) {
  return ViewPlugin.fromClass(
    class {
      private unsubscribe: (() => void)[] = [];
      /**
       * Set the moment this buffer leaves the view.
       *
       * `EditorView` is shared by every tab — the surface swaps states rather
       * than mounting a view per buffer — so a dispatch that arrives after the
       * swap lands on **whichever file is in front now**. That is not a stale
       * squiggle, it is one file's diagnostics drawn onto another, at offsets
       * resolved against the wrong text.
       */
      private gone = false;

      /**
       * The latest list from each server, kept apart until they are drawn.
       *
       * `setDiagnostics` replaces everything in the document, so two servers
       * publishing independently would each wipe the other's: with Tailwind and
       * the CSS server both attached, whichever spoke last would be the only
       * one you ever saw. They are merged here instead.
       */
      private bySession = new Map<LspSession, Diagnostic[]>();

      constructor(readonly view: EditorView) {
        for (const session of sessions) {
          this.unsubscribe.push(
            lsp.onDiagnostics(session.uri, (items) => {
              this.bySession.set(session, items);
              this.draw();
            })
          );
          // Whatever the server already said about this file, for a buffer
          // reopened while its server was still running.
          const existing = lsp.diagnosticsFor(session.uri);
          if (existing.length) this.bySession.set(session, existing);
        }
        // Deferred, because a plugin may not dispatch during its own
        // construction — which is also why `gone` is checked when it runs.
        if (this.bySession.size) queueMicrotask(() => this.draw());
      }

      private draw() {
        if (this.gone) return;
        const merged: CmDiagnostic[] = [];
        for (const [session, items] of this.bySession) {
          merged.push(...toCodeMirror(this.view, session, items));
        }
        // `setDiagnostics` wants them in document order.
        merged.sort((a, b) => a.from - b.from || a.to - b.to);

        // The view can also be destroyed between a server answering and this
        // running, and dispatching into a dead view throws.
        try {
          this.view.dispatch(setDiagnostics(this.view.state, merged));
        } catch {
          // A buffer that closed underneath us; nothing to report.
        }
      }

      destroy() {
        this.gone = true;
        for (const off of this.unsubscribe) off();
      }
    }
  );
}
