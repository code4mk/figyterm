/**
 * Keeping the server's copy of a document in step with CodeMirror's.
 *
 * CodeMirror hands over precisely the shape LSP wants, with two rules that are
 * bugs if skipped.
 *
 * **The ranges must be in the pre-change document.** `fromA`/`toA` are exactly
 * that, and `update.startState.doc` is what to resolve them against. Resolving
 * them against the new document is the single most common way to corrupt a
 * server's view, and the corruption is silent until a completion comes back
 * describing a file that no longer exists.
 *
 * **A transaction's changes are all in one coordinate space, but LSP applies
 * them in sequence.** Sent ascending, the second edit's offsets would be wrong
 * by the length the first one added. Sent *descending*, every range still
 * refers to text the earlier edits haven't touched — which is why the list is
 * reversed before it goes out.
 */

import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { offsetsToRange } from "../../../services/lsp/position";
import type { Range } from "../../../services/lsp/protocol";
import type { LspSession } from "../../../services/lsp/manager";

/** One pending `didChange`, in the order the server must apply them. */
type Change = { range: Range; text: string };

/**
 * Batches document changes to one message per animation frame.
 *
 * Every keystroke does need to reach the server — that is what incremental sync
 * is — but three keystrokes inside one frame are one message, and a paste that
 * arrives as several transactions is one message too.
 */
export function documentSync(session: LspSession) {
  return ViewPlugin.fromClass(
    class {
      private queue: Change[] = [];
      private frame = 0;

      constructor(readonly view: EditorView) {
        // A client arriving — or coming back after a crash — sends the whole
        // buffer as it is now, so anything queued is already in that text and
        // must not be sent again on top of it.
        session.onBind(() => {
          this.queue = [];
          if (this.frame) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
          }
        });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;

        const before = update.startState.doc;
        const encoding = session.client?.encoding ?? "utf-16";
        const batch: Change[] = [];

        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          batch.push({
            range: offsetsToRange(before, fromA, toA, encoding),
            text: inserted.toString(),
          });
        });

        // Descending, so each range still describes the document the server
        // will be looking at when it reaches that edit.
        batch.reverse();
        this.queue.push(...batch);
        this.schedule();
      }

      private schedule() {
        if (this.frame || !this.queue.length) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          const changes = this.queue;
          this.queue = [];
          // Dropped rather than held: with no client the next `bind` will send
          // the whole document, which already includes these.
          if (session.client) session.didChange(changes);
        });
      }

      /** Flushes before anything that asks the server about this document. */
      flush() {
        if (!this.frame) return;
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        const changes = this.queue;
        this.queue = [];
        if (session.client) session.didChange(changes);
      }

      /**
       * Flushed, not cancelled.
       *
       * A plugin instance dies when its buffer leaves the view — which is what
       * switching tabs does — and a frame's worth of keystrokes cancelled here
       * would never reach the server. The buffer is still open, so its copy
       * would stay wrong until the file was closed and reopened.
       */
      destroy() {
        this.flush();
      }
    }
  );
}

/**
 * Sends anything still queued, right now.
 *
 * Called before every request. A hover asked for at a position the server
 * hasn't been told about yet is answered about the wrong text — and since the
 * batch is only a frame long, the window is small enough that the bug looks
 * intermittent rather than reproducible.
 */
export function flushSync(view: EditorView, plugin: ReturnType<typeof documentSync>): void {
  const instance = view.plugin(plugin) as { flush?: () => void } | null;
  instance?.flush?.();
}
