/**
 * `textDocument/signatureHelp` — what the call you are inside expects.
 *
 * Shown while typing arguments and dismissed when the call is closed. A tooltip
 * rather than a panel, anchored at the cursor, with the parameter you are on
 * emphasised — which is the entire value of the feature and the only reason it
 * beats hovering the function name.
 *
 * Driven by a `StateField` holding the tooltip and a plugin that decides when
 * to ask. It cannot be a `hoverTooltip`, because nothing is being hovered: the
 * trigger is typing.
 */

import {
  EditorView,
  keymap,
  showTooltip,
  Tooltip,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { offsetToPosition } from "../../../services/lsp/position";
import { markupToText, SignatureHelp } from "../../../services/lsp/protocol";
import { isQuietError } from "../../../services/lsp/client";
import type { LspSession } from "../../../services/lsp/manager";

const setSignature = StateEffect.define<Tooltip | null>();

/**
 * Exported for `signature.test.ts`, which pins the clearing rule.
 *
 * That rule is the whole of a bug that shipped — a signature tooltip that
 * survived the cursor leaving the call it described — and it is one line, so it
 * is exactly the kind of thing that gets quietly reverted.
 */
export const __signatureField = () => signatureField;
export const __setSignature = setSignature;

const signatureField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSignature)) return effect.value;
    }
    /*
      Dropped on **any** document or selection change.

      It used to survive a cursor move, on the theory that the plugin below
      would replace it — and it does, when the request succeeds. When it was
      cancelled, timed out, or the new position was not inside a call at all,
      nothing replaced it and a signature for a call the cursor had long since
      left sat over the code with no way to dismiss it. That was the second
      stuck tooltip in `docs/issues`.

      Clearing first and letting the answer re-show is the right way round: the
      worst case is a flicker, and the alternative is a tooltip that lies.
    */
    return transaction.docChanged || transaction.selection ? null : tooltip;
  },
  provide: (field) => showTooltip.from(field),
});

/** Builds the tooltip body, emphasising the active parameter. */
function render(help: SignatureHelp): HTMLElement | null {
  const index = help.activeSignature ?? 0;
  const signature = help.signatures?.[index] ?? help.signatures?.[0];
  if (!signature?.label) return null;

  const dom = document.createElement("div");
  dom.className = "cm-lsp-tooltip cm-lsp-signature";

  const line = document.createElement("div");
  line.className = "cm-lsp-signature-label";

  const active = signature.activeParameter ?? help.activeParameter ?? 0;
  const parameter = signature.parameters?.[active];

  // The protocol allows the active parameter to be named either by offsets into
  // the label or by its own text; both have to be found in the label to be
  // highlighted, and neither is guaranteed to be there.
  let span: [number, number] | null = null;
  if (parameter) {
    if (Array.isArray(parameter.label)) {
      span = parameter.label;
    } else {
      const at = signature.label.indexOf(parameter.label);
      if (at >= 0) span = [at, at + parameter.label.length];
    }
  }

  if (span && span[0] >= 0 && span[1] <= signature.label.length && span[0] < span[1]) {
    line.append(document.createTextNode(signature.label.slice(0, span[0])));
    const strong = document.createElement("span");
    strong.className = "cm-lsp-signature-active";
    strong.textContent = signature.label.slice(span[0], span[1]);
    line.append(strong);
    line.append(document.createTextNode(signature.label.slice(span[1])));
  } else {
    line.textContent = signature.label;
  }
  dom.append(line);

  const documentation = markupToText(parameter?.documentation ?? signature.documentation).trim();
  if (documentation) {
    const note = document.createElement("div");
    note.className = "cm-lsp-signature-doc";
    // First line only. A whole doc comment under every keystroke of an argument
    // list is a tooltip covering the code you are writing.
    note.textContent = documentation.split("\n")[0];
    dom.append(note);
  }

  if (help.signatures.length > 1) {
    const count = document.createElement("div");
    count.className = "cm-lsp-signature-count";
    count.textContent = `${index + 1} of ${help.signatures.length}`;
    dom.append(count);
  }

  return dom;
}

export function signatureHelp(session: LspSession) {
  return [
    signatureField,
    /*
      Escape dismisses it, and only it — the binding falls through when nothing
      is showing, so Escape still closes the find panel, the completion list and
      the editor itself in that order.
    */
    Prec.high(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(signatureField)) return false;
            view.dispatch({ effects: setSignature.of(null) });
            return true;
          },
        },
      ])
    ),
    ViewPlugin.fromClass(
      class {
        private pending: AbortController | null = null;

        constructor(readonly view: EditorView) {}

        update(update: ViewUpdate) {
          const client = session.client;
          if (!client?.capabilities.signatureHelpProvider) return;

          // Losing focus ends it — the caret is somewhere else entirely.
          if (update.focusChanged && !update.view.hasFocus) return void this.cancel();
          if (!update.docChanged && !update.selectionSet) return;

          const state = update.state;
          // Never while a selection is being dragged out.
          if (!state.selection.main.empty) return void this.cancel();

          const provider = client.capabilities.signatureHelpProvider;
          const triggers = provider.triggerCharacters ?? ["(", ","];
          const retriggers = provider.retriggerCharacters ?? [")"];

          const head = state.selection.main.head;
          const typed = state.sliceDoc(Math.max(0, head - 1), head);

          // Closing the call ends it.
          if (update.docChanged && retriggers.includes(typed)) return void this.cancel();

          /*
            Two reasons to ask: a trigger character was just typed, or one was
            already showing and the cursor moved within the call — which is what
            walks the emphasis from one parameter to the next.

            `startState` is what has to be consulted for "was one showing", not
            `state`: the field above has already cleared it by the time this
            runs.
          */
          const triggered = update.docChanged && triggers.includes(typed);
          const wasShowing = update.startState.field(signatureField) !== null;
          if (!triggered && !wasShowing) return void this.cancel();

          void this.ask(head);
        }

        /** Abandons any request in flight. The field has already hidden it. */
        private cancel() {
          this.pending?.abort();
          this.pending = null;
        }

        private async ask(at: number) {
          const client = session.client;
          if (!client) return;

          this.pending?.abort();
          const controller = new AbortController();
          this.pending = controller;

          try {
            const help = await client.signatureHelp(
              session.uri,
              offsetToPosition(this.view.state.doc, at, client.encoding),
              controller.signal
            );
            if (controller.signal.aborted) return;
            /*
              The cursor may have moved while the server was answering, and the
              field will have cleared the tooltip on that move. Re-showing here
              would put a signature for the old position back on screen — the
              same stuck tooltip by a slower route.
            */
            if (this.view.state.selection.main.head !== at) return;

            const dom = help?.signatures?.length ? render(help) : null;
            this.view.dispatch({
              effects: setSignature.of(
                dom ? { pos: at, above: true, create: () => ({ dom }) } : null
              ),
            });
          } catch (error) {
            if (!isQuietError(error)) console.warn("lsp: signature help failed", error);
          }
        }

        destroy() {
          this.cancel();
        }
      }
    ),
  ];
}
