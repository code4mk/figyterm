/**
 * The things a language server can *do*, as editor commands.
 *
 * Navigation (Phase 3) and edits (Phase 4) in `docs/LSP-TASKS.md`. The split
 * between them matters: go-to-definition only moves the cursor, while rename,
 * formatting and code actions write files — including files that are not open.
 * Everything in the second group goes through
 * `services/lsp/edits.ts`, which pre-flights every file before it writes any of
 * them and reports exactly what changed when it can't finish.
 */

import { Action as LintAction } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { basename, readTextFile } from "../../../services/editor-fs";
import { applyWorkspaceEdit, summarize } from "../../../services/lsp/edits";
import { offsetToPosition, rangeToOffsets } from "../../../services/lsp/position";
import type {
  CodeAction,
  Command,
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  Range,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "../../../services/lsp/protocol";
import { isQuietError } from "../../../services/lsp/client";
import type { LspSession } from "../../../services/lsp/manager";
import { uriToPath } from "../../../services/lsp/uri";
import { showInput, showMenu } from "./popup";

/**
 * What the editor around CodeMirror has to provide.
 *
 * Deliberately small, and deliberately all *outcomes* rather than mechanisms:
 * this file decides what should happen, and `EditorModal` — which owns the tab
 * strip, the search panel and the error banner — decides how to show it.
 */
export interface LspHost {
  /** Opens a file and puts the cursor on it. Both are 1-based. */
  openPath: (path: string, line: number, column: number) => void;
  /** The workspace root, for showing paths relative to it. */
  root: () => string | null;
  /** A message for the editor's error banner. */
  report: (message: string) => void;
  /** Applies edits to a buffer the user has open, as one undoable step. */
  applyToOpenBuffer: (
    path: string,
    edits: { from: number; to: number; insert: string }[]
  ) => boolean;
  /** The live text of an open buffer, or null when it isn't open. */
  openText: (path: string) => string | null;
}

/** Set once by the extension; every command reads it. */
let host: LspHost | null = null;

export function setLspHost(next: LspHost): void {
  host = next;
}

function report(message: string): void {
  if (host) host.report(message);
  else console.warn(`lsp: ${message}`);
}

/** Turns a request failure into a message, staying quiet about cancellations. */
function complain(what: string, error: unknown): void {
  if (isQuietError(error)) return;
  report(`${what}: ${error instanceof Error ? error.message : String(error)}`);
}

// ─── Applying edits ─────────────────────────────────────────────────────────

/** Applies a server's edits to the document in `view`, as one undoable step. */
export function applyTextEdits(view: EditorView, session: LspSession, edits: TextEdit[]): boolean {
  if (!edits.length) return false;
  const encoding = session.client?.encoding ?? "utf-16";

  const changes = edits
    .map((edit) => {
      const { from, to } = rangeToOffsets(view.state.doc, edit.range, encoding);
      return { from, to, insert: edit.newText ?? "" };
    })
    .sort((a, b) => b.from - a.from);

  for (let i = 1; i < changes.length; i++) {
    if (changes[i].to > changes[i - 1].from) {
      report("the server sent overlapping edits");
      return false;
    }
  }

  view.dispatch({ changes, userEvent: "input.lsp" });
  return true;
}

async function applyEdit(session: LspSession, edit: WorkspaceEdit): Promise<boolean> {
  if (!host) return false;
  const outcome = await applyWorkspaceEdit(edit, session.client?.encoding ?? "utf-16", {
    applyToOpenBuffer: host.applyToOpenBuffer,
    openText: host.openText,
  });
  if (outcome.error) report(outcome.error);
  return outcome.applied;
}

// ─── Navigation ─────────────────────────────────────────────────────────────

/** Flattens every shape a definition response is allowed to take. */
function toLocations(
  result: Location | Location[] | LocationLink[] | null
): { uri: string; range: Range }[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list
    .map((entry) => {
      if ("targetUri" in entry) {
        // The selection range is the identifier; the target range includes the
        // doc comment above it. Landing on the name is what a reader wants.
        return { uri: entry.targetUri, range: entry.targetSelectionRange ?? entry.targetRange };
      }
      return { uri: entry.uri, range: entry.range };
    })
    .filter((entry) => entry.uri && entry.range);
}

/** How many places are worth listing before the list stops being a list. */
const MAX_LOCATIONS = 300;

/** How many distinct files to read for previews. Beyond this, lines only. */
const MAX_PREVIEW_FILES = 40;

/** A preview longer than this is a minified file, not a line of code. */
const MAX_PREVIEW_CHARS = 160;

/**
 * The source line each location sits on, for the preview under its row.
 *
 * This is what makes a reference list readable rather than a list of line
 * numbers: `getAuthenticatedHeaders(session)` tells you which of the twelve
 * results you want, and `axios-server.ts:13` does not.
 *
 * Open buffers answer from memory. Closed ones are read from disk, in parallel
 * and capped — a rename across a large repository can touch hundreds of files
 * and reading all of them to draw a list nobody scrolls to the bottom of would
 * be slower than the request that produced it.
 */
async function previewsFor(
  places: { path: string; line: number }[]
): Promise<Map<string, string[]>> {
  const byPath = new Map<string, string[]>();
  const needed = [...new Set(places.map((place) => place.path))];

  await Promise.all(
    needed.slice(0, MAX_PREVIEW_FILES).map(async (path) => {
      const open = host?.openText(path);
      if (open !== null && open !== undefined) {
        byPath.set(path, open.split("\n"));
        return;
      }
      try {
        const file = await readTextFile(path);
        if (file.kind === "text") byPath.set(path, file.content.split("\n"));
      } catch {
        // A file that can't be read simply has no preview; the row still works.
      }
    })
  );

  return byPath;
}

/** `{ line, character }` as the editor's 1-based line and column. */
function toCursor(range: Range): { line: number; column: number } {
  return { line: range.start.line + 1, column: range.start.character + 1 };
}

/** The last two path segments, which is enough to tell two files apart. */
function shortDirectory(path: string, root: string | null): string {
  const relative =
    root && path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const parts = relative.split(/[/\\]/);
  parts.pop();
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Offers several places one symbol appears, and opens the chosen one.
 *
 * A picker at the cursor rather than a results panel, for the same reason the
 * code-action menu is one: it is reached from the keyboard, answered from the
 * keyboard, and gone. A panel would mean a fourth thing competing for the side
 * of a modal that already holds the explorer, search and git.
 */
async function pickLocation(
  view: EditorView,
  title: string,
  found: { uri: string; range: Range }[]
): Promise<void> {
  const root = host?.root() ?? null;
  const places = found
    .flatMap((entry) => {
      const path = uriToPath(entry.uri);
      return path ? [{ path, ...toCursor(entry.range) }] : [];
    })
    .slice(0, MAX_LOCATIONS);

  if (!places.length) return;
  if (places.length === 1) {
    host?.openPath(places[0].path, places[0].line, places[0].column);
    return;
  }

  const previews = await previewsFor(places);
  const files = new Set(places.map((place) => place.path)).size;

  const chosen = await showMenu(
    view,
    view.state.selection.main.head,
    places.map((place) => {
      const line = previews.get(place.path)?.[place.line - 1] ?? "";
      return {
        label: basename(place.path),
        detail: shortDirectory(place.path, root),
        // Indentation stripped, or a deeply nested match renders as a blank
        // row with its code off the right-hand edge.
        preview: line.trim().slice(0, MAX_PREVIEW_CHARS) || undefined,
        badge: String(place.line),
      };
    }),
    {
      title,
      subtitle: `${places.length} in ${files} file${files === 1 ? "" : "s"}`,
    }
  );

  if (chosen === null) return;
  const place = places[chosen];
  host?.openPath(place.path, place.line, place.column);
}

export async function goToDefinition(view: EditorView, session: LspSession): Promise<boolean> {
  const client = session.client;
  if (!client?.capabilities.definitionProvider) return false;

  const position = offsetToPosition(
    view.state.doc,
    view.state.selection.main.head,
    client.encoding
  );

  try {
    const found = toLocations(await client.definition(session.uri, position));
    if (!found.length) {
      report("No definition found");
      return true;
    }
    // One candidate jumps; several — an overload set, or a name declared in two
    // places — are offered, which beats picking one arbitrarily.
    await pickLocation(view, "Definitions", found);
    return true;
  } catch (error) {
    complain("Go to definition", error);
    return true;
  }
}

export async function findReferences(view: EditorView, session: LspSession): Promise<boolean> {
  const client = session.client;
  if (!client?.capabilities.referencesProvider) return false;

  const position = offsetToPosition(
    view.state.doc,
    view.state.selection.main.head,
    client.encoding
  );

  try {
    const found = (await client.references(session.uri, position)) ?? [];
    if (!found.length) {
      report("No references found");
      return true;
    }
    await pickLocation(view, "References", found);
    return true;
  } catch (error) {
    complain("Find references", error);
    return true;
  }
}

/** The document's symbols, flattened for a picker. */
export interface OutlineEntry {
  name: string;
  detail: string | null;
  kind: number;
  line: number;
  depth: number;
}

export async function documentOutline(session: LspSession): Promise<OutlineEntry[]> {
  const client = session.client;
  if (!client?.capabilities.documentSymbolProvider) return [];

  try {
    const found = await client.documentSymbols(session.uri);
    if (!found?.length) return [];

    // The two shapes again: nested `DocumentSymbol`s, or the older flat list.
    if ("location" in found[0]) {
      return (found as SymbolInformation[]).map((symbol) => ({
        name: symbol.name,
        detail: symbol.containerName ?? null,
        kind: symbol.kind,
        line: symbol.location.range.start.line + 1,
        depth: 0,
      }));
    }

    const flat: OutlineEntry[] = [];
    const walk = (symbols: DocumentSymbol[], depth: number) => {
      for (const symbol of symbols) {
        flat.push({
          name: symbol.name,
          detail: symbol.detail ?? null,
          kind: symbol.kind,
          line: (symbol.selectionRange ?? symbol.range).start.line + 1,
          depth,
        });
        if (symbol.children?.length) walk(symbol.children, depth + 1);
      }
    };
    walk(found as DocumentSymbol[], 0);
    return flat;
  } catch (error) {
    if (!isQuietError(error)) console.warn("lsp: document symbols failed", error);
    return [];
  }
}

/** The symbol kinds worth naming in the picker; the rest show their shape. */
const SYMBOL_LABELS: Record<number, string> = {
  5: "class",
  6: "method",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  22: "enum member",
  23: "struct",
  26: "type parameter",
};

/**
 * Jumps to a symbol declared in this file.
 *
 * What `documentSymbol` is actually *for*, as opposed to an outline panel: the
 * editor is a modal with three things already competing for its side, and a
 * picker answers the same question — "where is `parseHunk` in this file" —
 * from the keyboard, in one keystroke, without taking any space when closed.
 * Nesting is shown by indentation, so a method reads as belonging to its class.
 */
export async function goToSymbol(view: EditorView, session: LspSession): Promise<boolean> {
  const client = session.client;
  if (!client?.capabilities.documentSymbolProvider) return false;

  const symbols = await documentOutline(session);
  if (!symbols.length) {
    report("No symbols in this file");
    return true;
  }

  const chosen = await showMenu(
    view,
    view.state.selection.main.head,
    symbols.map((symbol) => ({
      label: `${"\u00a0\u00a0".repeat(Math.min(symbol.depth, 4))}${symbol.name}`,
      detail: SYMBOL_LABELS[symbol.kind],
      preview: symbol.detail ?? undefined,
      badge: String(symbol.line),
    })),
    { title: "Go to symbol", subtitle: `${symbols.length} in this file` }
  );
  if (chosen === null) return true;

  const line = Math.max(1, Math.min(symbols[chosen].line, view.state.doc.lines));
  const at = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: at },
    effects: EditorView.scrollIntoView(at, { y: "center" }),
  });
  view.focus();
  return true;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Formats the whole document, or the selection when there is one.
 *
 * The result replaces the buffer as one undoable edit, and the buffer saves
 * afterwards through the editor's normal path — so the atomic write, the mtime
 * check and the line endings are all still whoever's they were. Formatting is
 * the one place a tool rewrites a whole file, which makes it the one place a
 * mistake costs the lot.
 */
export async function formatDocument(
  view: EditorView,
  session: LspSession,
  options: { tabSize: number; insertSpaces: boolean }
): Promise<boolean> {
  const client = session.client;
  if (!client) return false;

  const selection = view.state.selection.main;
  const wantsRange = !selection.empty && Boolean(client.capabilities.documentRangeFormattingProvider);
  if (!wantsRange && !client.capabilities.documentFormattingProvider) return false;

  try {
    const edits = wantsRange
      ? await client.rangeFormatting(
          session.uri,
          {
            start: offsetToPosition(view.state.doc, selection.from, client.encoding),
            end: offsetToPosition(view.state.doc, selection.to, client.encoding),
          },
          options
        )
      : await client.formatting(session.uri, options);

    if (!edits?.length) return true;
    applyTextEdits(view, session, edits);
    return true;
  } catch (error) {
    complain("Format", error);
    return true;
  }
}

// ─── Rename ─────────────────────────────────────────────────────────────────

/**
 * Renames the symbol under the cursor, across every file it appears in.
 *
 * Confirmed before it is applied when it reaches beyond the open file: "rename
 * in 12 files" is a thing to agree to, not to discover afterwards.
 */
export async function renameSymbol(view: EditorView, session: LspSession): Promise<boolean> {
  const client = session.client;
  if (!client?.capabilities.renameProvider) return false;

  const head = view.state.selection.main.head;
  const position = offsetToPosition(view.state.doc, head, client.encoding);

  // `prepareRename` is what says whether this position can be renamed at all,
  // and what the current name is — a keyword or a literal comes back null,
  // which is a better answer than a rename that fails after being typed.
  let current = "";
  const supportsPrepare =
    typeof client.capabilities.renameProvider === "object" &&
    client.capabilities.renameProvider.prepareProvider;

  if (supportsPrepare) {
    try {
      const prepared = await client.prepareRename(session.uri, position);
      if (!prepared) {
        report("This can't be renamed");
        return true;
      }
      if ("placeholder" in prepared) {
        current = prepared.placeholder;
      } else {
        const { from, to } = rangeToOffsets(view.state.doc, prepared, client.encoding);
        current = view.state.sliceDoc(from, to);
      }
    } catch (error) {
      if (isQuietError(error)) return true;
      // A server that announced `prepareProvider` and then refused the request
      // is common enough to be worth carrying on past.
      current = wordAt(view, head);
    }
  } else {
    current = wordAt(view, head);
  }

  const next = await showInput(view, head, "Rename symbol", current);
  if (!next) return true;

  try {
    const edit = await client.rename(session.uri, position, next);
    if (!edit) {
      report("The server had no changes to make");
      return true;
    }

    const { files, edits } = summarize(edit);
    if (files > 1) {
      const chosen = await showMenu(
        view,
        head,
        [
          { label: `Rename in ${files} files`, detail: `${edits} occurrences` },
          { label: "Cancel" },
        ],
        `Rename “${current}” to “${next}”`
      );
      if (chosen !== 0) return true;
    }

    const applied = await applyEdit(session, edit);
    if (applied) report(`Renamed in ${files} file${files === 1 ? "" : "s"}`);
    return true;
  } catch (error) {
    complain("Rename", error);
    return true;
  }
}

/** The identifier around an offset, as a fallback name for the rename box. */
function wordAt(view: EditorView, at: number): string {
  const line = view.state.doc.lineAt(at);
  const column = at - line.from;
  const before = /[\w$]*$/.exec(line.text.slice(0, column))?.[0] ?? "";
  const after = /^[\w$]*/.exec(line.text.slice(column))?.[0] ?? "";
  return before + after;
}

// ─── Code actions ───────────────────────────────────────────────────────────

function isCodeAction(entry: CodeAction | Command): entry is CodeAction {
  // A `Command` has a `command` string and no `edit`; a `CodeAction` has a
  // `title` and may carry either.
  return !("command" in entry && typeof entry.command === "string" && !("kind" in entry));
}

/** Runs whichever of an action's two halves it has, edit first. */
async function runAction(session: LspSession, entry: CodeAction | Command): Promise<void> {
  const client = session.client;
  if (!client) return;

  try {
    if (!isCodeAction(entry)) {
      await client.executeCommand(entry as Command);
      return;
    }

    let action = entry as CodeAction;
    // An action with neither an edit nor a command needs resolving first —
    // servers send the title cheaply and compute the edit only if asked.
    if (!action.edit && !action.command) {
      action = await client.resolveCodeAction(action);
    }
    if (action.disabled) {
      report(action.disabled.reason);
      return;
    }
    if (action.edit) await applyEdit(session, action.edit);
    if (action.command) await client.executeCommand(action.command);
  } catch (error) {
    complain("Code action", error);
  }
}

/**
 * Offers the code actions available at the cursor, or over the selection.
 */
export async function codeActions(view: EditorView, session: LspSession): Promise<boolean> {
  const client = session.client;
  if (!client?.capabilities.codeActionProvider) return false;

  const selection = view.state.selection.main;
  const range: Range = {
    start: offsetToPosition(view.state.doc, selection.from, client.encoding),
    end: offsetToPosition(view.state.doc, selection.to, client.encoding),
  };

  // Only the diagnostics the cursor is actually on: handing a server every
  // diagnostic in the file gets back every quick fix in the file.
  const here = diagnosticsIn(session, view, selection.from, selection.to);

  try {
    const found = (await client.codeAction(session.uri, range, here)) ?? [];
    if (!found.length) {
      report("No code actions here");
      return true;
    }

    const chosen = await showMenu(
      view,
      selection.head,
      found.map((entry) => ({
        label: entry.title,
        detail: isCodeAction(entry) ? (entry as CodeAction).kind : undefined,
        disabled: isCodeAction(entry) && Boolean((entry as CodeAction).disabled),
      })),
      "Code actions"
    );
    if (chosen === null) return true;
    await runAction(session, found[chosen]);
    return true;
  } catch (error) {
    complain("Code actions", error);
    return true;
  }
}

/** The server's diagnostics overlapping a span, in their original form. */
function diagnosticsIn(
  session: LspSession,
  view: EditorView,
  from: number,
  to: number
): Diagnostic[] {
  const client = session.client;
  if (!client) return [];
  // Imported lazily through the manager rather than kept in a second store:
  // there is one copy of a server's diagnostics and it lives there.
  const items = lspDiagnostics(session);
  return items.filter((item) => {
    const span = rangeToOffsets(view.state.doc, item.range, client.encoding);
    return span.to >= from && span.from <= to;
  });
}

/** Indirection so `diagnostics.ts` and this file don't import each other. */
let lspDiagnostics: (session: LspSession) => Diagnostic[] = () => [];

export function setDiagnosticSource(source: (session: LspSession) => Diagnostic[]): void {
  lspDiagnostics = source;
}

/**
 * The "Quick fix" offered from a diagnostic's own tooltip.
 *
 * One entry rather than the actual fixes, because `@codemirror/lint` wants an
 * action's name up front and synchronously, while the fixes for a diagnostic
 * are a request. Asking for every diagnostic's fixes eagerly — on every
 * republish, for every squiggle in the file — is a great deal of traffic for a
 * menu nobody may open.
 */
export function codeActionsFor(session: LspSession, diagnostic: Diagnostic): LintAction[] {
  if (!session.client?.capabilities.codeActionProvider) return [];

  return [
    {
      name: "Quick fix",
      apply(view: EditorView) {
        const client = session.client;
        if (!client) return;
        const span = rangeToOffsets(view.state.doc, diagnostic.range, client.encoding);
        void (async () => {
          try {
            const found =
              (await client.codeAction(session.uri, diagnostic.range, [diagnostic])) ?? [];
            if (!found.length) {
              report("No fixes for this");
              return;
            }
            const chosen = await showMenu(
              view,
              span.from,
              found.map((entry) => ({
                label: entry.title,
                detail: isCodeAction(entry) ? (entry as CodeAction).kind : undefined,
              })),
              "Quick fix"
            );
            if (chosen !== null) await runAction(session, found[chosen]);
          } catch (error) {
            complain("Quick fix", error);
          }
        })();
      },
    },
  ];
}
