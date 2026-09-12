/**
 * `textDocument/completion`, which is deceptively large.
 *
 * Hover is one request and one tooltip. Completion is trigger characters,
 * `isIncomplete` re-querying, a second request per item for its documentation,
 * and — the part that decides whether it feels right — **the server's ordering
 * winning over CodeMirror's**. A language server sorts its own list with
 * information the editor does not have: what is in scope, what is imported,
 * what you just used. `sortText` is how it says so, and a client that lets its
 * own fuzzy matcher re-rank the list throws that away and offers `AbstractMap`
 * before `a`.
 *
 * This **replaces** the word-completion source rather than sitting beside it.
 * Two sources in one list is a worse experience than either alone: the words
 * already in the file are mostly the identifiers the server is offering, so
 * the list doubles up and the good entries sink.
 */

import {
  Completion,
  CompletionContext,
  CompletionResult,
  insertCompletionText,
  snippet,
} from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { offsetToPosition, rangeToOffsets } from "../../../services/lsp/position";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  CompletionTriggerKind,
  InsertTextFormat,
  markupToText,
} from "../../../services/lsp/protocol";
import { isQuietError } from "../../../services/lsp/client";
import type { LspSession } from "../../../services/lsp/manager";
import { renderMarkup } from "./markdown";
import { applyTextEdits } from "./actions";

/**
 * LSP's kinds as the words CodeMirror's own styling knows.
 *
 * Every kind is mapped, including the ones that used to fall through to
 * `text` — a Tailwind class list is almost entirely `Constant` and `Color`, and
 * an entire completion list rendered as "plain text" is a list you cannot scan.
 */
const KINDS = new Map<number, string>([
  [CompletionItemKind.Text, "text"],
  [CompletionItemKind.Method, "method"],
  [CompletionItemKind.Function, "function"],
  [CompletionItemKind.Constructor, "constructor"],
  [CompletionItemKind.Field, "property"],
  [CompletionItemKind.Variable, "variable"],
  [CompletionItemKind.Class, "class"],
  [CompletionItemKind.Interface, "interface"],
  [CompletionItemKind.Module, "namespace"],
  [CompletionItemKind.Property, "property"],
  [CompletionItemKind.Unit, "unit"],
  [CompletionItemKind.Value, "value"],
  [CompletionItemKind.Enum, "enum"],
  [CompletionItemKind.Keyword, "keyword"],
  [CompletionItemKind.Snippet, "snippet"],
  [CompletionItemKind.Color, "color"],
  [CompletionItemKind.File, "file"],
  [CompletionItemKind.Reference, "reference"],
  [CompletionItemKind.Folder, "folder"],
  [CompletionItemKind.EnumMember, "enum"],
  [CompletionItemKind.Constant, "constant"],
  [CompletionItemKind.Struct, "class"],
  [CompletionItemKind.Event, "event"],
  [CompletionItemKind.Operator, "operator"],
  [CompletionItemKind.TypeParameter, "type"],
]);

/**
 * Rewrites an LSP snippet into CodeMirror's syntax.
 *
 * LSP uses TextMate's — `${1:name}`, `$0` — and CodeMirror wants `#{name}`.
 * Choice syntax (`${1|a,b|}`) has no equivalent and is flattened to its first
 * option, which is what the user would most likely have picked anyway.
 */
function toCodeMirrorSnippet(template: string): string {
  return template
    .replace(/\$\{(\d+)\|([^|]*)\|\}/g, (_, _index, choices: string) => choices.split(",")[0] ?? "")
    .replace(/\$\{(\d+):([^}]*)\}/g, (_, _index, placeholder: string) => `#{${placeholder}}`)
    .replace(/\$\{(\d+)\}/g, "#{}")
    .replace(/\$(\d+)/g, "#{}")
    .replace(/\\\$/g, "$");
}

/** The range an item replaces, as the server described it. */
function editRange(item: CompletionItem): { range: import("../../../services/lsp/protocol").Range; text: string } | null {
  if (!item.textEdit) return null;
  const text = item.textEdit.newText ?? "";
  if ("range" in item.textEdit) return { range: item.textEdit.range, text };
  // An `InsertReplaceEdit`. We did not claim `insertReplaceSupport`, but a
  // server may send one anyway; the insert range is the conservative half.
  return { range: item.textEdit.insert, text };
}

export function completion(session: LspSession) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const client = session.client;
    if (!client?.capabilities.completionProvider) return null;

    const triggers = client.capabilities.completionProvider.triggerCharacters ?? [];
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    const isTrigger = triggers.includes(before);

    // Explicit invocation always asks. Otherwise: a trigger character, or at
    // least one word character so that typing an identifier offers something.
    const word = context.matchBefore(/[\w$]+/);
    if (!context.explicit && !isTrigger && !word) return null;

    const position = offsetToPosition(context.state.doc, context.pos, client.encoding);

    /*
      CodeMirror signals abandonment through a listener rather than an
      `AbortSignal`, so one is bridged here — that is what sends
      `$/cancelRequest` and keeps a server from working through completions for
      a cursor position three keystrokes ago.

      `onDocChange` because an LSP completion list is position-specific: unlike
      a word list, it cannot be re-filtered locally once the document has moved
      under it.
    */
    const abort = new AbortController();
    context.addEventListener("abort", () => abort.abort(), { onDocChange: true });

    let result;
    try {
      result = await client.completion(
        session.uri,
        position,
        {
          triggerKind: isTrigger
            ? CompletionTriggerKind.TriggerCharacter
            : CompletionTriggerKind.Invoked,
          ...(isTrigger ? { triggerCharacter: before } : {}),
        },
        abort.signal
      );
    } catch (error) {
      if (!isQuietError(error)) console.warn("lsp: completion failed", error);
      return null;
    }

    const list: CompletionList =
      Array.isArray(result) ? { isIncomplete: false, items: result } : result ?? { isIncomplete: false, items: [] };
    if (!list.items.length) return null;

    // Where the completion starts. The server's own edit range is the truth
    // where it gave one — it knows that `@scope/name` is one token and that
    // `.` starts a member access — and the typed word is the fallback.
    let from = word?.from ?? context.pos;
    const firstEdit = list.items.map(editRange).find(Boolean);
    if (firstEdit) {
      from = rangeToOffsets(context.state.doc, firstEdit.range, client.encoding).from;
    }

    const options: Completion[] = list.items.map((item, index) => {
      const label = item.label ?? "";
      const insert = item.insertText ?? label;
      const isSnippet = item.insertTextFormat === InsertTextFormat.Snippet;
      // `1` is the Deprecated tag; the boolean is the older spelling of it.
      const deprecated = item.deprecated === true || item.tags?.includes(1) === true;

      return {
        label,
        detail: item.detail,
        /*
          Space-separated types are how CodeMirror lets one item carry more
          than one icon class, and `deprecated` rides along as a second so the
          stylesheet can strike the label through — there is no per-item class
          on the row itself to hang it from.
        */
        type: `${KINDS.get(item.kind ?? 0) ?? "text"}${deprecated ? " deprecated" : ""}`,
        // The server's ordering, preserved. `boost` is CodeMirror's own knob
        // and it only spans -99..99, so the list's position is mapped onto it
        // rather than the raw `sortText`, which is an opaque string.
        boost: Math.max(-99, 99 - index),
        info: () => infoFor(client, item),
        apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
          const edit = editRange(item);
          const span = edit
            ? rangeToOffsets(view.state.doc, edit.range, client.encoding)
            : { from: applyFrom, to: applyTo };
          const text = edit ? edit.text : insert;

          if (isSnippet) {
            snippet(toCodeMirrorSnippet(text))(view, _completion, span.from, span.to);
          } else {
            view.dispatch(insertCompletionText(view.state, text, span.from, span.to));
          }

          // Imports the server wants adding at the top of the file. Applied
          // after the completion so its offsets — which are in the pre-insert
          // document — are still resolved against text that hasn't moved,
          // which holds because they are always above the cursor.
          if (item.additionalTextEdits?.length) {
            applyTextEdits(view, session, item.additionalTextEdits);
          }
        },
      } satisfies Completion;
    });

    return {
      from,
      options,
      // An incomplete list must be re-fetched as the user types on, so no
      // `validFor` — that is precisely the flag saying "do not filter this
      // locally, ask me again".
      ...(list.isIncomplete ? {} : { validFor: /^[\w$]*$/ }),
    };
  };
}

/**
 * An item's documentation, fetched when the user lands on it.
 *
 * `completionItem/resolve` exists because a server that computed documentation
 * for two hundred items up front would be unusable, so the list arrives with
 * labels and the details are asked for one at a time.
 */
function infoFor(
  client: NonNullable<LspSession["client"]>,
  item: CompletionItem
): Promise<HTMLElement | null> | HTMLElement | null {
  const immediate = markupToText(item.documentation).trim();

  const render = (text: string, detail?: string) => {
    if (!text && !detail) return null;
    const dom = document.createElement("div");
    dom.className = "cm-lsp-info";
    if (detail) {
      const line = document.createElement("div");
      line.className = "cm-lsp-info-detail";
      line.textContent = detail;
      dom.append(line);
    }
    if (text) dom.append(renderMarkup(text));
    return dom;
  };

  if (immediate || !client.capabilities.completionProvider?.resolveProvider) {
    return render(immediate, item.detail);
  }

  return client
    .resolveCompletion(item)
    .then((resolved) => render(markupToText(resolved?.documentation).trim(), resolved?.detail ?? item.detail))
    .catch(() => render("", item.detail));
}
