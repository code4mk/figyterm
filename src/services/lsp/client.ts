/**
 * One language server, spoken to properly.
 *
 * This owns the half of the protocol Rust deliberately knows nothing about: the
 * `initialize` handshake and what came back from it, correlating replies with
 * requests, cancelling the ones nobody is waiting for any more, and keeping the
 * server's copy of every open document in step with CodeMirror's.
 *
 * Three rules run through all of it.
 *
 * **Every request has a deadline.** Hover and completion are asked for
 * constantly and abandoned constantly, and a server that never answers must not
 * leak a pending promise per keystroke.
 *
 * **Every incoming request gets a reply.** A server that asks
 * `workspace/configuration` and is ignored will wait for the answer forever,
 * and the symptom is a server that appears to start and then do nothing.
 *
 * **Everything a server sends is untrusted.** It is another program's output on
 * its way into a tooltip.
 */

import type {
  CodeAction,
  Command,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DocumentSymbol,
  Hover,
  IncomingMessage,
  InitializeResult,
  Location,
  LocationLink,
  Position,
  PositionEncoding,
  Range,
  ServerCapabilities,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "./protocol";
import { CONTENT_MODIFIED, METHOD_NOT_FOUND, REQUEST_CANCELLED } from "./protocol";
import type { LspServerDef } from "./servers";
import { pathToUri } from "./uri";
import * as transport from "./transport";
import type { LspExitInfo } from "./transport";

/**
 * How long a request waits before it is abandoned and cancelled.
 *
 * Generous, because the first request against a cold `rust-analyzer` queues
 * behind indexing a whole workspace — and a timeout during that is reported to
 * the user as a broken feature when it is really a busy one.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Formatting rewrites a whole file and is allowed to take longer. */
const SLOW_TIMEOUT_MS = 30_000;

/** What the status bar shows. */
export type LspPhase = "starting" | "indexing" | "ready" | "failed" | "stopped";

export interface LspStatus {
  phase: LspPhase;
  /** What the server is doing, when it has said — "indexing", "loading crates". */
  detail: string | null;
  error: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * What a server gets when it asks `workspace/configuration`.
 *
 * Keyed by the section it asked for — `python`, `python.analysis`. A section we
 * have nothing to say about answers `{}`, which means "your defaults".
 */
export type LspSettings = Record<string, unknown>;

export interface LspClientHooks {
  onDiagnostics: (uri: string, diagnostics: Diagnostic[], version?: number) => void;
  onStatus: (status: LspStatus) => void;
  /** A server asking to edit files. Returns whether the edit was applied. */
  onApplyEdit: (edit: WorkspaceEdit) => Promise<boolean>;
  /** An unexpected death, for the manager's restart policy. */
  onExit: (info: LspExitInfo) => void;
  /**
   * The settings for a section the server asked about.
   *
   * A function rather than a value because a server may ask at any time, and
   * the answer — which Python interpreter, say — can change while it is
   * running.
   */
  settingsFor: (section: string) => unknown;
}

/** The capabilities we claim — only the ones actually implemented. */
function clientCapabilities() {
  return {
    general: {
      // The negotiation `LSP.md` calls the encoding trap. UTF-16 first because
      // a CodeMirror offset already is one; the others are honoured if a server
      // insists, which rust-analyzer does.
      positionEncodings: ["utf-16", "utf-8", "utf-32"],
    },
    workspace: {
      applyEdit: true,
      workspaceFolders: true,
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: false },
      workspaceEdit: { documentChanges: true },
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        willSave: false,
        willSaveWaitUntil: false,
        didSave: true,
      },
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
        tagSupport: { valueSet: [1, 2] },
      },
      hover: { contentFormat: ["markdown", "plaintext"] },
      completion: {
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          documentationFormat: ["markdown", "plaintext"],
          deprecatedSupport: true,
          preselectSupport: true,
          insertReplaceSupport: false,
          resolveSupport: {
            properties: ["documentation", "detail", "additionalTextEdits"],
          },
        },
        completionItemKind: {
          valueSet: Array.from({ length: 25 }, (_, index) => index + 1),
        },
      },
      signatureHelp: {
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
        },
      },
      // `linkSupport` is what gets `targetSelectionRange` back, which is the
      // difference between landing on a declaration's doc comment and landing
      // on its name.
      definition: { linkSupport: true },
      references: { dynamicRegistration: false },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      formatting: { dynamicRegistration: false },
      rangeFormatting: { dynamicRegistration: false },
      rename: { prepareSupport: true },
      codeAction: {
        dataSupport: true,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ["quickfix", "refactor", "source", "source.organizeImports"],
          },
        },
        resolveSupport: { properties: ["edit"] },
      },
    },
    window: { workDoneProgress: true },
  };
}

export class LspClient {
  readonly id: string;
  readonly def: LspServerDef;
  readonly root: string;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private disposed = false;
  private initialized = false;

  private caps: ServerCapabilities = {};
  /**
   * The negotiated encoding.
   *
   * UTF-16 until the server says otherwise, because that is what was asked for
   * and what the specification says to assume when nothing comes back.
   */
  private encodingValue: PositionEncoding = "utf-16";

  private statusValue: LspStatus = { phase: "starting", detail: null, error: null };
  private hooks: LspClientHooks;

  /** Open documents, so a restart can reopen them and a close can be checked. */
  private documents = new Map<string, { languageId: string; version: number }>();

  private constructor(id: string, def: LspServerDef, root: string, hooks: LspClientHooks) {
    this.id = id;
    this.def = def;
    this.root = root;
    this.hooks = hooks;
  }

  get capabilities(): ServerCapabilities {
    return this.caps;
  }

  get encoding(): PositionEncoding {
    return this.encodingValue;
  }

  get status(): LspStatus {
    return this.statusValue;
  }

  get isReady(): boolean {
    return this.initialized && !this.disposed;
  }

  /**
   * Spawns the server and completes the handshake.
   *
   * Rejects if the program isn't installed or the handshake fails, which the
   * manager turns into a status the settings panel can render — "not on PATH"
   * and "crashed on startup" need different words and different offers.
   */
  static async start(
    id: string,
    def: LspServerDef,
    root: string,
    hooks: LspClientHooks
  ): Promise<LspClient> {
    const client = new LspClient(id, def, root, hooks);

    await transport.register(id, {
      message: (message) => client.receive(message),
      exit: (info) => client.handleExit(info),
    });

    try {
      await transport.startServer({
        id,
        language: def.id,
        program: def.program,
        args: def.args,
        root,
      });
    } catch (error) {
      transport.unregister(id);
      throw error instanceof Error ? error : new Error(String(error));
    }

    try {
      await client.handshake();
    } catch (error) {
      await client.dispose();
      throw error instanceof Error ? error : new Error(String(error));
    }

    return client;
  }

  private async handshake(): Promise<void> {
    const result = await this.request<InitializeResult>(
      "initialize",
      {
        processId: null,
        clientInfo: { name: "FigyTerm" },
        locale: typeof navigator === "undefined" ? "en" : navigator.language,
        rootUri: pathToUri(this.root),
        workspaceFolders: [
          { uri: pathToUri(this.root), name: this.root.split(/[/\\]/).pop() || this.root },
        ],
        capabilities: clientCapabilities(),
        initializationOptions: this.def.initializationOptions,
      },
      // The handshake itself gets the long deadline: a cold server on a large
      // repository can take a while to answer even this.
      { timeout: SLOW_TIMEOUT_MS, beforeInitialize: true }
    );

    this.caps = result?.capabilities ?? {};
    // Honoured rather than assumed. A server that insists on UTF-8 — and
    // rust-analyzer does — means every conversion is a byte walk instead of
    // line arithmetic, and getting this wrong is off-by-one on any line with an
    // accent in it.
    if (
      result?.capabilities?.positionEncoding === "utf-8" ||
      result?.capabilities?.positionEncoding === "utf-32"
    ) {
      this.encodingValue = result.capabilities.positionEncoding;
    }

    this.initialized = true;
    this.notify("initialized", {});
    // Some servers — pyright among them — wait for this before doing anything.
    // The payload carries the settings rather than `{}`, for servers that read
    // it directly instead of asking.
    this.didChangeConfiguration(this.hooks.settingsFor(""));
    this.setStatus({ phase: "ready", detail: null, error: null });
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  private setStatus(status: LspStatus) {
    this.statusValue = status;
    this.hooks.onStatus(status);
  }

  /**
   * Tells the server its settings changed.
   *
   * Servers that pull configuration re-request it when they get this; ones that
   * don't ignore it. Either way it is the only push the protocol has, and a
   * server that caches the interpreter still needs restarting — see
   * `LspManager.setPythonPath`.
   */
  didChangeConfiguration(settings: unknown = {}): void {
    this.notify("workspace/didChangeConfiguration", { settings });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    void transport
      .sendMessage(this.id, { jsonrpc: "2.0", method, params })
      .catch((error) => console.warn(`lsp[${this.id}]: ${method} failed`, error));
  }

  /**
   * One request, correlated with its reply.
   *
   * `signal` is how the editor abandons a request the user has moved on from:
   * the promise rejects at once and `$/cancelRequest` goes to the server, which
   * is the difference between a server that keeps up and one drowning in
   * completions for a cursor position three keystrokes ago.
   */
  async request<T>(
    method: string,
    params: unknown,
    options: { timeout?: number; signal?: AbortSignal; beforeInitialize?: boolean } = {}
  ): Promise<T> {
    if (this.disposed) throw new Error(`${this.def.program} has stopped`);
    if (!this.initialized && !options.beforeInitialize) {
      throw new Error(`${this.def.program} is still starting`);
    }
    if (options.signal?.aborted) throw new DOMException("cancelled", "AbortError");

    const id = this.nextId++;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const settle = (run: () => void) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
        run();
      };

      const onAbort = () => {
        this.cancel(id);
        settle(() => reject(new DOMException("cancelled", "AbortError")));
      };

      const timer = setTimeout(() => {
        this.cancel(id);
        settle(() =>
          reject(new Error(`${this.def.program} did not answer ${method} in ${timeout}ms`))
        );
      }, timeout);

      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
        timer,
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });

      transport
        .sendMessage(this.id, { jsonrpc: "2.0", id, method, params })
        .catch((error) => this.pending.get(id)?.reject(new Error(String(error))));
    });
  }

  private cancel(id: number): void {
    if (this.disposed) return;
    this.notify("$/cancelRequest", { id });
  }

  private receive(message: IncomingMessage): void {
    // A reply: has an id and either a result or an error.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      if (message.error) {
        const { code, message: text } = message.error;
        // Both of these mean "you moved on", which is the normal case rather
        // than a failure, and reporting them as errors makes a healthy session
        // look broken.
        const quiet = code === REQUEST_CANCELLED || code === CONTENT_MODIFIED;
        pending.reject(
          Object.assign(new Error(text || `error ${code}`), { code, quiet })
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // A request from the server: must be answered, always.
    if (message.id !== undefined && message.method) {
      void this.answer(message);
      return;
    }

    if (message.method) this.handleNotification(message.method, message.params);
  }

  private async answer(message: IncomingMessage): Promise<void> {
    const id = message.id!;
    const reply = (result: unknown) =>
      transport
        .sendMessage(this.id, { jsonrpc: "2.0", id, result })
        .catch(() => {});

    switch (message.method) {
      // Dynamic registration is accepted and ignored: we don't vary behaviour
      // on it, but a server that isn't answered here blocks on it forever.
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return void reply(null);

      /*
        "What are this server's settings?"

        This used to answer `{}` for every section, which is legal and useless:
        it is the request pyright uses to ask which interpreter to resolve
        imports against, and an empty answer means "your default" — the system
        Python, in a project with a `.venv`, which reports every third-party
        import as missing.
      */
      case "workspace/configuration": {
        const items =
          (message.params as { items?: { section?: string }[] })?.items ?? [];
        return void reply(
          items.map((item) => this.hooks.settingsFor(item?.section ?? ""))
        );
      }

      // A message with buttons. Declining is a legitimate answer and far better
      // than a dialog the editor has no place showing.
      case "window/showMessageRequest":
        return void reply(null);

      case "workspace/applyEdit": {
        const edit = (message.params as { edit?: WorkspaceEdit })?.edit;
        let applied = false;
        try {
          applied = edit ? await this.hooks.onApplyEdit(edit) : false;
        } catch (error) {
          console.error(`lsp[${this.id}]: applyEdit failed`, error);
        }
        return void reply({ applied });
      }

      default:
        // Refused rather than ignored, so the server knows not to wait.
        return void transport
          .sendMessage(this.id, {
            jsonrpc: "2.0",
            id,
            error: { code: METHOD_NOT_FOUND, message: `${message.method} is not supported` },
          })
          .catch(() => {});
    }
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case "textDocument/publishDiagnostics": {
        const payload = params as { uri?: string; diagnostics?: Diagnostic[]; version?: number };
        if (typeof payload?.uri !== "string") return;
        this.hooks.onDiagnostics(payload.uri, payload.diagnostics ?? [], payload.version);
        return;
      }

      // "rust-analyzer: indexing" is the difference between a slow editor and
      // one that looks broken, so progress is surfaced rather than dropped.
      case "$/progress": {
        const payload = params as {
          value?: { kind?: string; title?: string; message?: string; percentage?: number };
        };
        const value = payload?.value;
        if (!value) return;
        if (value.kind === "end") {
          if (this.statusValue.phase === "indexing") {
            this.setStatus({ phase: "ready", detail: null, error: null });
          }
          return;
        }
        const detail = [value.title, value.message].filter(Boolean).join(" — ") || null;
        this.setStatus({ phase: "indexing", detail, error: null });
        return;
      }

      case "window/logMessage":
        return;

      case "window/showMessage": {
        const payload = params as { type?: number; message?: string };
        // Type 1 is an error; anything else is chatter the status bar doesn't
        // need to carry.
        if (payload?.type === 1 && payload.message) {
          console.warn(`lsp[${this.id}]: ${payload.message}`);
        }
        return;
      }

      default:
        return;
    }
  }

  private handleExit(info: LspExitInfo): void {
    if (this.disposed) return;
    this.initialized = false;

    // Everything still waiting will never be answered.
    const reason = info.stderr.length
      ? info.stderr[info.stderr.length - 1]
      : `exited with code ${info.code ?? "unknown"}`;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`${this.def.program} stopped: ${reason}`));
    }
    this.pending.clear();
    this.documents.clear();

    if (!info.expected) {
      this.setStatus({ phase: "failed", detail: null, error: reason });
    }
    this.hooks.onExit(info);
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  /** Whether this document has been opened on the server. */
  isOpen(uri: string): boolean {
    return this.documents.has(uri);
  }

  didOpen(uri: string, languageId: string, text: string): void {
    if (!this.isReady || this.documents.has(uri)) return;
    this.documents.set(uri, { languageId, version: 1 });
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  /**
   * An incremental change.
   *
   * The ranges must be in the **pre-change** document. Resolving them against
   * the new one is the single most common way to corrupt a server's view, and
   * the corruption is silent until a completion comes back describing a file
   * that no longer exists.
   */
  didChange(uri: string, changes: { range: Range; text: string }[]): void {
    const document = this.documents.get(uri);
    if (!this.isReady || !document || !changes.length) return;
    // Monotonic, always. A server that sees versions go backwards is entitled
    // to do anything at all.
    document.version++;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: changes.map((change) => ({
        range: change.range,
        text: change.text,
      })),
    });
  }

  /** The whole document, for a reload from disk or a formatter's rewrite. */
  didChangeFull(uri: string, text: string): void {
    const document = this.documents.get(uri);
    if (!this.isReady || !document) return;
    document.version++;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text }],
    });
  }

  didSave(uri: string, text?: string): void {
    if (!this.isReady || !this.documents.has(uri)) return;
    this.notify("textDocument/didSave", {
      textDocument: { uri },
      ...(text === undefined ? {} : { text }),
    });
  }

  didClose(uri: string): void {
    if (!this.documents.delete(uri) || !this.isReady) return;
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  version(uri: string): number {
    return this.documents.get(uri)?.version ?? 0;
  }

  // ─── Requests ─────────────────────────────────────────────────────────────

  hover(uri: string, position: Position, signal?: AbortSignal) {
    return this.request<Hover | null>(
      "textDocument/hover",
      { textDocument: { uri }, position },
      { signal }
    );
  }

  completion(
    uri: string,
    position: Position,
    context: { triggerKind: number; triggerCharacter?: string },
    signal?: AbortSignal
  ) {
    return this.request<CompletionList | CompletionItem[] | null>(
      "textDocument/completion",
      { textDocument: { uri }, position, context },
      { signal }
    );
  }

  resolveCompletion(item: CompletionItem, signal?: AbortSignal) {
    return this.request<CompletionItem>("completionItem/resolve", item, {
      signal,
      timeout: 5_000,
    });
  }

  signatureHelp(uri: string, position: Position, signal?: AbortSignal) {
    return this.request<SignatureHelp | null>(
      "textDocument/signatureHelp",
      { textDocument: { uri }, position },
      { signal }
    );
  }

  definition(uri: string, position: Position, signal?: AbortSignal) {
    return this.request<Location | Location[] | LocationLink[] | null>(
      "textDocument/definition",
      { textDocument: { uri }, position },
      { signal }
    );
  }

  references(uri: string, position: Position, signal?: AbortSignal) {
    return this.request<Location[] | null>(
      "textDocument/references",
      { textDocument: { uri }, position, context: { includeDeclaration: true } },
      { signal, timeout: SLOW_TIMEOUT_MS }
    );
  }

  documentSymbols(uri: string, signal?: AbortSignal) {
    return this.request<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
      { signal }
    );
  }

  formatting(uri: string, options: { tabSize: number; insertSpaces: boolean }) {
    return this.request<TextEdit[] | null>(
      "textDocument/formatting",
      { textDocument: { uri }, options },
      { timeout: SLOW_TIMEOUT_MS }
    );
  }

  rangeFormatting(uri: string, range: Range, options: { tabSize: number; insertSpaces: boolean }) {
    return this.request<TextEdit[] | null>(
      "textDocument/rangeFormatting",
      { textDocument: { uri }, range, options },
      { timeout: SLOW_TIMEOUT_MS }
    );
  }

  prepareRename(uri: string, position: Position, signal?: AbortSignal) {
    return this.request<Range | { range: Range; placeholder: string } | null>(
      "textDocument/prepareRename",
      { textDocument: { uri }, position },
      { signal }
    );
  }

  rename(uri: string, position: Position, newName: string) {
    return this.request<WorkspaceEdit | null>(
      "textDocument/rename",
      { textDocument: { uri }, position, newName },
      { timeout: SLOW_TIMEOUT_MS }
    );
  }

  codeAction(uri: string, range: Range, diagnostics: Diagnostic[], signal?: AbortSignal) {
    return this.request<(CodeAction | Command)[] | null>(
      "textDocument/codeAction",
      { textDocument: { uri }, range, context: { diagnostics } },
      { signal }
    );
  }

  resolveCodeAction(action: CodeAction, signal?: AbortSignal) {
    return this.request<CodeAction>("codeAction/resolve", action, { signal });
  }

  executeCommand(command: Command) {
    return this.request<unknown>(
      "workspace/executeCommand",
      { command: command.command, arguments: command.arguments },
      { timeout: SLOW_TIMEOUT_MS }
    );
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  /**
   * The polite exit, then the process.
   *
   * `shutdown` and `exit` are this side's job — `lsp_stop` closes the pipe and
   * kills on a deadline, which is what makes "it should exit" not load-bearing.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const [, pending] of this.pending) {
      pending.reject(new Error(`${this.def.program} is shutting down`));
    }
    this.pending.clear();
    this.documents.clear();

    if (this.initialized) {
      try {
        // Deliberately short: this is a courtesy, and the kill behind it is
        // what guarantees the process actually goes.
        await this.request("shutdown", null, { timeout: 1_000 });
      } catch {
        // A server too broken to answer `shutdown` is exactly the one that
        // needs the kill below.
      }
      void transport.sendMessage(this.id, { jsonrpc: "2.0", method: "exit" }).catch(() => {});
    }

    this.initialized = false;
    this.setStatus({ phase: "stopped", detail: null, error: null });
    await transport.stopServer(this.id).catch(() => {});
    transport.unregister(this.id);
  }
}

/** Whether an error is one of the "you moved on" ones worth staying quiet about. */
export function isQuietError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return Boolean((error as { quiet?: boolean })?.quiet);
}
