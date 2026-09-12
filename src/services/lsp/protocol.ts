/**
 * The slice of the Language Server Protocol this editor speaks.
 *
 * Hand-declared rather than pulled from `vscode-languageserver-protocol`,
 * which is the obvious alternative and the wrong one here: it is a large
 * dependency of which we would use perhaps five percent, and the clients built
 * on it all assume Node's `child_process` and a `vscode` host — neither of
 * which exists in a webview. What follows is the specification's own shape for
 * the requests in `docs/LSP-TASKS.md` and nothing else.
 *
 * Everything a server sends is **untrusted input**: it is another program's
 * output on its way into a tooltip. Fields are optional wherever the
 * specification allows it, and the rendering code treats them as such rather
 * than trusting a server to have announced its capabilities honestly.
 */

// ─── Text documents ─────────────────────────────────────────────────────────

/** `character` is in the units of the negotiated `positionEncoding`. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

/**
 * What a modern server answers `textDocument/definition` with.
 *
 * `targetSelectionRange` is the identifier itself and `targetRange` the whole
 * declaration including its doc comment — so jumping to the former puts the
 * cursor on the name, which is what a reader wants.
 */
export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
  originSelectionRange?: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

/**
 * An edit across files.
 *
 * Two shapes for the same thing, because the protocol grew one: `changes` is
 * the original map, `documentChanges` the newer list that can also create,
 * rename and delete files. A server sends whichever the client said it
 * supports, and we accept both.
 */
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: TextDocumentEdit[];
}

export interface TextDocumentEdit {
  textDocument: VersionedTextDocumentIdentifier & { version: number | null };
  edits: TextEdit[];
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: number | string;
  /** Which tool inside the server produced this — `ts`, `eslint`, `rustc`. */
  source?: string;
  message: string;
  relatedInformation?: { location: Location; message: string }[];
  /** Opaque; handed back verbatim when asking for code actions. */
  data?: unknown;
}

export interface PublishDiagnosticsParams {
  uri: string;
  /** Present only when the server supports pull diagnostics; may be stale. */
  version?: number;
  diagnostics: Diagnostic[];
}

// ─── Hover ──────────────────────────────────────────────────────────────────

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

/** The pre-3.3 shapes, which several servers in the table still send. */
export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

// ─── Completion ─────────────────────────────────────────────────────────────

export const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export const InsertTextFormat = { PlainText: 1, Snippet: 2 } as const;

export const CompletionTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  TriggerForIncompleteCompletions: 3,
} as const;

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  /**
   * The item is no longer valid — a deprecated API.
   *
   * Two spellings for one fact: `deprecated` is the original boolean and
   * `tags` is what replaced it (`1` is Deprecated). Servers send either, so
   * both are read.
   */
  deprecated?: boolean;
  tags?: number[];
  preselect?: boolean;
  /** Overrides the label for ordering. Servers rely on this heavily. */
  sortText?: string;
  /** Overrides the label for matching against what the user typed. */
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: TextEdit | { insert: Range; replace: Range; newText: string };
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  command?: Command;
  data?: unknown;
}

export interface CompletionList {
  /** The list is a prefix of the real answer; re-query as the user types on. */
  isIncomplete: boolean;
  items: CompletionItem[];
}

// ─── Signature help ─────────────────────────────────────────────────────────

export interface ParameterInformation {
  /** A string, or offsets into the signature label. */
  label: string | [number, number];
  documentation?: string | MarkupContent;
}

export interface SignatureInformation {
  label: string;
  documentation?: string | MarkupContent;
  parameters?: ParameterInformation[];
  activeParameter?: number;
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

// ─── Symbols ────────────────────────────────────────────────────────────────

export const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26,
} as const;

/** The nested shape, which is what an outline wants. */
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

/** The older flat shape, still sent by some servers. */
export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

// ─── Code actions ───────────────────────────────────────────────────────────

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

// ─── Handshake ──────────────────────────────────────────────────────────────

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

/**
 * What the server says it can do.
 *
 * Every field is optional because every field genuinely is, and a server that
 * announces a capability may still reject the request — so these are read as
 * "worth asking" rather than as promises.
 */
export interface ServerCapabilities {
  positionEncoding?: PositionEncoding;
  textDocumentSync?:
    | number
    | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  hoverProvider?: boolean | object;
  completionProvider?: {
    triggerCharacters?: string[];
    allCommitCharacters?: string[];
    resolveProvider?: boolean;
  };
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  codeActionProvider?: boolean | { codeActionKinds?: string[] };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

/** How `textDocumentSync.change` is spelled. */
export const TextDocumentSyncKind = { None: 0, Full: 1, Incremental: 2 } as const;

// ─── JSON-RPC envelopes ─────────────────────────────────────────────────────

export interface ResponseError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RequestMessage {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface NotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface ResponseMessage {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: ResponseError;
}

export type IncomingMessage = Partial<RequestMessage & ResponseMessage & NotificationMessage>;

/**
 * The error code a server returns for a request we cancelled.
 *
 * Worth naming: hover and completion are asked for constantly and abandoned
 * constantly, so this is the single most common error in a healthy session and
 * must not be reported as a failure.
 */
export const REQUEST_CANCELLED = -32800;
export const CONTENT_MODIFIED = -32801;
export const METHOD_NOT_FOUND = -32601;

// ─── Markup ─────────────────────────────────────────────────────────────────

/** Flattens every shape `Hover.contents` is allowed to take into plain text. */
export function markupToText(
  contents: MarkupContent | MarkedString | MarkedString[] | undefined
): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((part) => markupToText(part)).filter(Boolean).join("\n\n");
  }
  if ("kind" in contents) return contents.value;
  // `{ language, value }` — a fenced code block in everything but syntax.
  return contents.value;
}
