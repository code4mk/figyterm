/**
 * ⌘-hover, the way VS Code does it: the symbol under the pointer underlines and
 * takes a pointer cursor, and clicking follows it.
 *
 * The detail that makes this worth building rather than faking: **the underline
 * only appears when the server actually has a definition**. A modifier-held
 * underline drawn on every identifier is a promise the editor cannot keep — you
 * click a local variable, nothing happens, and now the underline means nothing.
 * So the affordance *is* the answer: if it is underlined, it will navigate.
 *
 * The cost of that honesty is a request per hovered symbol, which is why this
 * is debounced, cancelled the moment the pointer moves on, and asked only while
 * the modifier is held.
 *
 * Three things reset it, and missing any one leaves a stale underline the user
 * cannot get rid of: releasing the modifier, the window losing focus (⌘-tab
 * away and the keyup never arrives), and the document changing underneath.
 */

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { offsetToPosition } from "../../../services/lsp/position";
import type { Range } from "../../../services/lsp/protocol";
import { isQuietError } from "../../../services/lsp/client";
import type { LspSession } from "../../../services/lsp/manager";
import { isMac } from "../../../services/platform";

/**
 * How long the pointer must rest before a definition is asked for.
 *
 * Short, because the modifier is already held — the user has declared intent,
 * and this is the one hover where they are waiting for an answer rather than
 * merely passing through.
 */
const PROBE_DELAY_MS = 120;

const setLink = StateEffect.define<{ from: number; to: number } | null>();

const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(links, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLink)) {
        return effect.value
          ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    // Dropped rather than mapped through an edit: the range was resolved
    // against text that has now changed, and an underline that slides onto a
    // different word is worse than none.
    return transaction.docChanged ? Decoration.none : links;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Whether this event carries the go-to-definition modifier. */
function hasModifier(event: MouseEvent | KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * The word around an offset, as a span to underline.
 *
 * The server's `originSelectionRange` is better when it sends one — it knows
 * that `foo.bar` is two things and that `@scope/pkg` is one — so this is only
 * the fallback for the many servers that don't.
 */
function wordAround(view: EditorView, at: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(at);
  const column = at - line.from;
  const before = /[\w$]*$/.exec(line.text.slice(0, column))?.[0] ?? "";
  const after = /^[\w$]*/.exec(line.text.slice(column))?.[0] ?? "";
  if (!before && !after) return null;
  return { from: at - before.length, to: at + after.length };
}

export function definitionLink(session: LspSession, onFollow: (view: EditorView) => void) {
  return [
    linkField,
    ViewPlugin.fromClass(
      class {
        /** The offset currently underlined, so an unchanged hover is free. */
        private shown: { from: number; to: number } | null = null;
        /** Where the pointer last was, for a modifier pressed without moving. */
        private pointer: { x: number; y: number } | null = null;
        private timer: ReturnType<typeof setTimeout> | null = null;
        private pending: AbortController | null = null;

        constructor(readonly view: EditorView) {
          window.addEventListener("keydown", this.onKeyDown, true);
          window.addEventListener("keyup", this.onKeyUp, true);
          window.addEventListener("blur", this.onWindowBlur);
        }

        update(update: ViewUpdate) {
          // The decoration is dropped by the field on an edit; this keeps our
          // own idea of what is shown in step with it.
          if (update.docChanged) this.shown = null;
        }

        /**
         * Pressing the modifier without moving the pointer must still light up
         * whatever it is already over — which is how the gesture is actually
         * performed: point first, then press.
         */
        private onKeyDown = (event: KeyboardEvent) => {
          if (!hasModifier(event) || !this.pointer) return;
          this.probe(this.pointer.x, this.pointer.y);
        };

        private onKeyUp = (event: KeyboardEvent) => {
          if (!hasModifier(event)) this.clear();
        };

        private onWindowBlur = () => this.clear();

        /** @internal — called by the DOM handlers below. */
        onPointerMove(event: MouseEvent) {
          this.pointer = { x: event.clientX, y: event.clientY };
          if (!hasModifier(event)) {
            this.clear();
            return;
          }
          this.probe(event.clientX, event.clientY);
        }

        private probe(x: number, y: number) {
          const client = session.client;
          if (!client?.capabilities.definitionProvider) return;

          const at = this.view.posAtCoords({ x, y });
          if (at === null) return void this.clear();

          // Still inside the span already underlined: nothing to ask.
          if (this.shown && at >= this.shown.from && at <= this.shown.to) return;

          const word = wordAround(this.view, at);
          if (!word) return void this.clear();

          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.ask(at, word), PROBE_DELAY_MS);
        }

        private async ask(at: number, word: { from: number; to: number }) {
          const client = session.client;
          if (!client) return;

          this.pending?.abort();
          const controller = new AbortController();
          this.pending = controller;

          try {
            const position = offsetToPosition(this.view.state.doc, at, client.encoding);
            const result = await client.definition(session.uri, position, controller.signal);
            if (controller.signal.aborted) return;

            const found = Array.isArray(result) ? result.length > 0 : Boolean(result);
            if (!found) return void this.clear();

            // Prefer the server's own idea of what was clicked; it is the only
            // thing that knows where a token really begins and ends.
            const origin =
              Array.isArray(result) && result[0] && "originSelectionRange" in result[0]
                ? (result[0].originSelectionRange as Range | undefined)
                : undefined;

            const span = origin
              ? {
                  from: this.view.state.doc.line(origin.start.line + 1).from +
                    origin.start.character,
                  to: this.view.state.doc.line(origin.end.line + 1).from + origin.end.character,
                }
              : word;

            this.show(span);
          } catch (error) {
            if (!isQuietError(error)) {
              // A server that cannot answer this is not worth a message; the
              // underline simply doesn't appear.
              this.clear();
            }
          }
        }

        private show(span: { from: number; to: number }) {
          if (this.shown?.from === span.from && this.shown?.to === span.to) return;
          this.shown = span;
          this.view.dispatch({ effects: setLink.of(span) });
        }

        private clear() {
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          this.pending?.abort();
          this.pending = null;
          if (!this.shown) return;
          this.shown = null;
          this.view.dispatch({ effects: setLink.of(null) });
        }

        /** Whether an offset is inside the live underline. */
        isLinked(at: number): boolean {
          return Boolean(this.shown && at >= this.shown.from && at <= this.shown.to);
        }

        /** Whether anything is underlined at all. */
        hasLink(): boolean {
          return this.shown !== null;
        }

        /** The private `clear`, reachable from the DOM handlers below. */
        dismiss() {
          this.clear();
        }

        destroy() {
          window.removeEventListener("keydown", this.onKeyDown, true);
          window.removeEventListener("keyup", this.onKeyUp, true);
          window.removeEventListener("blur", this.onWindowBlur);
          if (this.timer) clearTimeout(this.timer);
          this.pending?.abort();
        }
      },
      {
        eventHandlers: {
          mousemove(event: MouseEvent) {
            this.onPointerMove(event);
          },
          mouseleave() {
            // Guarded: a bare `dispatch` here would push a transaction on every
            // pass of the pointer out of the editor, underline or not.
            if (this.hasLink()) this.dismiss();
          },
          mousedown(event: MouseEvent, view: EditorView) {
            if (!hasModifier(event) || event.button !== 0) return false;
            const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
            // Only follows what is actually underlined — the same promise the
            // affordance makes. A modifier-click on unresolvable text falls
            // through to CodeMirror's own handling.
            if (at === null || !this.isLinked(at)) return false;

            event.preventDefault();
            view.dispatch({ selection: { anchor: at }, effects: setLink.of(null) });
            onFollow(view);
            return true;
          },
        },
      }
    ),
  ];
}
