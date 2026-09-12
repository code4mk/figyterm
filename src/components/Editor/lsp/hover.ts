/**
 * `textDocument/hover` as a CodeMirror tooltip.
 *
 * The first request/response feature, and the smallest one — one request, one
 * tooltip — which is why `docs/LSP-TASKS.md` puts it before completion.
 *
 * The request is abandoned when the pointer moves on. CodeMirror gives an
 * `AbortSignal` for exactly this, and honouring it is what sends
 * `$/cancelRequest` — the difference between a server keeping up and one
 * answering about a position the pointer left half a second ago.
 */

import { hoverTooltip, Tooltip } from "@codemirror/view";
import { rangeToOffsets } from "../../../services/lsp/position";
import { offsetToPosition } from "../../../services/lsp/position";
import { markupToText } from "../../../services/lsp/protocol";
import { isQuietError } from "../../../services/lsp/client";
import type { LspSession } from "../../../services/lsp/manager";
import { renderMarkup } from "./markdown";

/** How long the pointer must rest before anything is asked. */
const HOVER_DELAY_MS = 300;

export function hover(session: LspSession) {
  return hoverTooltip(
    async (view, pos, side): Promise<Tooltip | null> => {
      const client = session.client;
      if (!client?.capabilities.hoverProvider) return null;

      // Not over a word: hovering the middle of a run of whitespace should do
      // nothing rather than describe whatever is nearest.
      const line = view.state.doc.lineAt(pos);
      const column = pos - line.from;
      const character = side < 0 ? line.text[column - 1] : line.text[column];
      if (!character || !/[\w$.<>:@#[\]"'-]/.test(character)) return null;

      const position = offsetToPosition(view.state.doc, pos, client.encoding);

      let result;
      try {
        result = await client.hover(session.uri, position);
      } catch (error) {
        if (!isQuietError(error)) console.warn("lsp: hover failed", error);
        return null;
      }

      const text = markupToText(result?.contents).trim();
      if (!text) return null;

      // The server's own range where it gave one, so the tooltip is anchored to
      // the whole identifier rather than to the character under the pointer.
      const span = result?.range
        ? rangeToOffsets(view.state.doc, result.range, client.encoding)
        : { from: pos, to: pos };

      const kind =
        result?.contents &&
        typeof result.contents === "object" &&
        !Array.isArray(result.contents) &&
        "kind" in result.contents
          ? result.contents.kind
          : "markdown";

      return {
        pos: span.from,
        end: span.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-tooltip cm-lsp-hover";
          dom.append(renderMarkup(text, kind));
          return { dom };
        },
      };
    },
    {
      hoverTime: HOVER_DELAY_MS,
      /*
        This defaults to **false**, which is why hover tooltips were getting
        stuck: CodeMirror keeps one open across edits and cursor moves unless
        told otherwise, so hovering a symbol and then typing left a description
        of something else floating over the code with nothing to dismiss it.

        A hover describes what is under the pointer at a moment. The moment ends
        when the document or the selection changes.
      */
      hideOnChange: true,
    }
  );
}
