/**
 * Every language server the editor is using, and when each one is allowed to
 * exist.
 *
 * The protocol is the easy half. Keeping a heavyweight child process honest is
 * the half that decides whether this is worth shipping, so the rules are
 * explicit and all in one place:
 *
 * - **Lazy start.** On the first buffer of that language in that root — never on
 *   the editor opening, and never on a file opened from a terminal link, because
 *   that path exists to be fast.
 * - **Idle stop.** No buffer of that language open for [`IDLE_MS`] and the
 *   server is shut down. The debounce is on the *stop*, not the start: closing
 *   the editor modal must not kill a `rust-analyzer` that is about to be needed
 *   again, and must not keep one alive forever if it isn't.
 * - **Restart with a ceiling.** A server that crashes on a particular file will
 *   crash again immediately, so three failures inside a minute stop the cycle
 *   and say so rather than fork-bombing quietly.
 * - **A cap**, enforced in `lsp/registry.rs`, surfaced here.
 *
 * Nothing in here starts anything unless the user turned the master switch on.
 */

import type { Diagnostic, WorkspaceEdit } from "./protocol";
import { LspClient, LspPhase, LspStatus } from "./client";
import {
  isEnabled,
  LspOverrides,
  LspServerDef,
  primaryServerForPath,
  resolveServer,
  serversForPath,
  SERVERS,
  detectServers,
} from "./servers";
import { pathToUri } from "./uri";

/**
 * The directory holding an environment, given its interpreter.
 *
 * `…/project/.venv/bin/python` → `…/project`. Pyright's `venvPath` is the
 * folder environments live *in*, not the environment itself, which is a subtle
 * enough distinction to be worth naming.
 */
function parentOfEnvironment(interpreter: string): string {
  const parts = interpreter.split(/[/\\]/);
  // Drop `python`, then `bin`, then the environment directory itself.
  parts.splice(-3, 3);
  return parts.join("/") || "/";
}

/**
 * What Tailwind's server asks for, and will not work without.
 *
 * Mirrors what the official extension sends. `classAttributes` is the one that
 * matters in practice — without `className` in the list, nothing completes in
 * React.
 */
const TAILWIND_SETTINGS = {
  validate: true,
  classAttributes: ["class", "className", "ngClass", "class:list"],
  includeLanguages: {},
  lint: {
    cssConflict: "warning",
    invalidApply: "error",
    invalidConfigPath: "error",
    invalidScreen: "error",
    invalidTailwindDirective: "error",
    invalidVariant: "error",
    recommendedVariantOrder: "warning",
  },
};

/** How long a server with nothing open survives. */
const IDLE_MS = 5 * 60 * 1000;

/** How long after an unexpected exit to try again, per consecutive failure. */
const BACKOFF_MS = [1_000, 5_000, 15_000];

/** Failures inside this window count as consecutive. */
const FAILURE_WINDOW_MS = 60_000;

/** Past this many consecutive failures the server is left alone. */
const MAX_FAILURES = 3;

/** What the settings panel and the status bar render, per server in the table. */
export interface LspServerState {
  def: LspServerDef;
  /**
   * `off` — the user disabled it (or the master switch is off).
   * `missing` — not on `PATH`; the install line is the useful thing to show.
   * Otherwise the running server's own phase.
   */
  phase: LspPhase | "off" | "missing" | "idle";
  detail: string | null;
  error: string | null;
  /** Where it was found, when it was. */
  path: string | null;
}

export interface LspConfig {
  enabled: boolean;
  overrides: LspOverrides;
  root: string | null;
  /**
   * The Python interpreter this workspace should be analysed against.
   *
   * Null means "whatever the server picks", which for pyright is the system
   * Python — correct for a project with no environment and wrong for every
   * project with a `.venv`.
   */
  pythonPath?: string | null;
}

type Unsubscribe = () => void;

/**
 * How a running server is keyed: one per `(workspace root, server)`.
 *
 * A function rather than a template literal repeated at each call site, which
 * is what it was — four copies of the same string interpolation, one of which
 * had picked up a stray NUL byte and made the whole file read as binary to
 * `grep`. The separator is `@` because a server id comes from our own table and
 * cannot contain one, while a root path very much can contain a space.
 */
function serverKey(root: string, serverId: string): string {
  return `${serverId}@${root}`;
}

/** How long a server's complaint may be before the settings row swallows it. */
const MAX_REASON = 220;

/**
 * Makes a server's error fit on a settings row without losing its point.
 *
 * These are worth showing verbatim where possible — "Could not find a valid
 * TypeScript installation" is the entire answer to "why is nothing happening" —
 * but they arrive wrapped in `Error:` prefixes and sometimes a stack, and the
 * useful sentence is at the front.
 */
function tidy(reason: string): string {
  const text = reason
    .replace(/^Error:\s*/i, "")
    .split("\n")[0]
    .trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/**
 * One open document's connection to its server.
 *
 * Handed out by [`LspManager.open`] and held by the CodeMirror extension for
 * the life of the buffer. It exists because a buffer opens *before* its server
 * is ready — starting one takes anywhere from milliseconds to a cold
 * `rust-analyzer`'s minutes — so something has to hold the buffer's identity in
 * the meantime and send `didOpen` at the moment a client appears.
 */
export class LspSession {
  readonly uri: string;
  readonly path: string;
  readonly languageId: string;

  private manager: LspManager;
  private key: string;
  private getText: () => string;
  private clientRef: LspClient | null = null;
  private closed = false;
  private onBindListener: ((client: LspClient | null) => void) | null = null;

  constructor(
    manager: LspManager,
    key: string,
    path: string,
    languageId: string,
    getText: () => string
  ) {
    this.manager = manager;
    this.key = key;
    this.path = path;
    this.uri = pathToUri(path);
    this.languageId = languageId;
    this.getText = getText;
  }

  /** The client, or null while it is starting, missing, or dead. */
  get client(): LspClient | null {
    return this.clientRef?.isReady ? this.clientRef : null;
  }

  /**
   * Told when the attached client changes — including to null, on a crash.
   *
   * The document-sync extension uses this to throw away edits it had queued:
   * `bind` sends the buffer's text *as it is now*, so anything still waiting to
   * be sent is already included in it and would otherwise be applied twice.
   */
  onBind(listener: (client: LspClient | null) => void): void {
    this.onBindListener = listener;
  }

  /** @internal — called by the manager when a client becomes available. */
  bind(client: LspClient | null): void {
    if (this.closed) return;
    this.clientRef = client;
    // The document may have been edited while the server was starting, so what
    // goes over is the text *now*, not the text at open.
    if (client?.isReady) client.didOpen(this.uri, this.languageId, this.getText());
    this.onBindListener?.(client);
  }

  didChange(changes: { range: import("./protocol").Range; text: string }[]): void {
    this.client?.didChange(this.uri, changes);
  }

  didChangeFull(text: string): void {
    this.client?.didChangeFull(this.uri, text);
  }

  didSave(): void {
    this.client?.didSave(this.uri);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client?.didClose(this.uri);
    this.manager.release(this.key, this);
  }
}

export class LspManager {
  private config: LspConfig = { enabled: false, overrides: {}, root: null };

  private clients = new Map<string, LspClient>();
  /** In-flight starts, so twelve buffers opening at once start one server. */
  private starting = new Map<string, Promise<LspClient | null>>();
  private sessions = new Map<string, Set<LspSession>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Consecutive failures per server, and why the last one happened.
   *
   * The reason is kept because without it a server that starts and then rejects
   * the handshake is invisible: `typescript-language-server` refuses a project
   * with no `typescript` installed, `gopls` refuses a directory with no module,
   * and in both cases the process starts fine and the editor would simply show
   * no diagnostics with nothing to explain it. The server's own words are the
   * only useful thing to say.
   */
  private failures = new Map<string, { count: number; at: number; reason: string }>();

  /** Server id → resolved path, or null for "not on PATH". */
  private detected = new Map<string, string | null>();
  private detecting: Promise<void> | null = null;

  /** uri → what the server last published. */
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticListeners = new Map<string, Set<(items: Diagnostic[]) => void>>();
  private statusListeners = new Set<() => void>();

  /** Set by the editor, which owns the atomic-write path a `WorkspaceEdit` needs. */
  private applyEdit: (edit: WorkspaceEdit) => Promise<boolean> = async () => false;

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Applies the user's settings.
   *
   * Turning the master switch off, or changing workspace, stops everything —
   * the alternative is a server left running against a folder nobody has open.
   */
  configure(config: LspConfig): void {
    const was = this.config;
    this.config = config;

    const rootChanged = was.root !== config.root;
    const turnedOff = was.enabled && !config.enabled;

    /*
      A changed interpreter restarts the Python server rather than notifying it.

      Pyright resolves the environment once, at startup — it builds its import
      map from the interpreter's `site-packages` — so a `didChangeConfiguration`
      leaves it analysing against the old one. Everything else about the server
      is unchanged, which is why this is a restart of one server and not of all
      of them.
    */
    if (!rootChanged && !turnedOff && was.pythonPath !== config.pythonPath) {
      void this.restart("python");
    }

    if (rootChanged || turnedOff) {
      void this.stopAll();
    } else if (config.enabled) {
      // A server the user just disabled, or repointed at another program, stops
      // now rather than at the next idle sweep.
      for (const [key, client] of this.clients) {
        const def = SERVERS.find((server) => server.id === client.def.id);
        const stale =
          !def ||
          !isEnabled(def.id, config.overrides) ||
          resolveServer(def, config.overrides).program !== client.def.program;
        if (stale) void this.stop(key);
      }
    }

    if (!was.enabled && config.enabled) this.detected.clear();
    this.notifyStatus();
  }

  setEditApplier(applier: (edit: WorkspaceEdit) => Promise<boolean>): void {
    this.applyEdit = applier;
  }

  /**
   * What a server gets when it asks `workspace/configuration`.
   *
   * Only Python has anything to say so far. Every other section answers `{}` —
   * "your defaults" — which is both true and what was being answered before,
   * except that Python was getting it too.
   *
   * Both spellings of the interpreter setting are sent: `pythonPath` is what
   * pyright has always read, `defaultInterpreterPath` is what the VS Code
   * Python extension moved to, and different versions look for different ones.
   * `venvPath` points at the *parent* of the environment, which is how pyright
   * finds it when it is resolving by name.
   */
  private settingsFor(section: string): unknown {
    const fixed = this.staticSettingsFor(section);
    if (fixed !== undefined) return fixed;

    const python = this.config.pythonPath;
    if (!python) return {};

    const pythonSettings = {
      pythonPath: python,
      defaultInterpreterPath: python,
      venvPath: parentOfEnvironment(python),
      analysis: {
        // Only the open files, which is what a terminal's editor wants: the
        // workspace-wide mode indexes everything and is where pyright's memory
        // and start-up cost come from.
        diagnosticMode: "openFilesOnly",
        useLibraryCodeForTypes: true,
      },
    };

    switch (section) {
      case "python":
        return pythonSettings;
      case "python.analysis":
        return pythonSettings.analysis;
      // The unprefixed ask, which is what `didChangeConfiguration` carries.
      case "":
        return { python: pythonSettings };
      default:
        return {};
    }
  }

  /**
   * Settings a server asks for that aren't about the workspace.
   *
   * Tailwind is the one that needs this: it asks for `tailwindCSS` and `editor`
   * through `workspace/configuration` and offers **nothing at all** without
   * them — no completions, no colour swatches, no lint. An empty answer is a
   * server that starts cleanly and then appears to do nothing, which is the
   * worst failure mode there is because it looks like our bug.
   */
  private staticSettingsFor(section: string): unknown | undefined {
    switch (section) {
      case "editor":
        return { tabSize: 2 };
      case "tailwindCSS":
        return TAILWIND_SETTINGS;
      default:
        return undefined;
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get root(): string | null {
    return this.config.root;
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  /**
   * Which servers are installed, cached until the settings change.
   *
   * The first call can take a moment — it may have to run a login shell to find
   * the user's real `PATH`, since a GUI launch doesn't inherit one.
   */
  async detect(force = false): Promise<Map<string, string | null>> {
    if (force) {
      this.detected.clear();
      this.detecting = null;
    }
    if (this.detected.size) return this.detected;
    if (!this.detecting) {
      this.detecting = detectServers(this.config.overrides)
        .then((found) => {
          this.detected = found;
          this.notifyStatus();
        })
        .catch((error) => {
          console.warn("lsp: could not check which servers are installed", error);
        })
        .finally(() => {
          this.detecting = null;
        });
    }
    await this.detecting;
    return this.detected;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Connects one buffer to its server, starting the server if need be.
   *
   * Null when there is nothing to connect to — the master switch is off, the
   * language has no server in the table, the user disabled it, or it isn't
   * installed. All four are ordinary and none is an error: most files the
   * editor opens have no language server and never will.
   */
  open(path: string, getText: () => string): LspSession[] {
    const root = this.config.root;
    if (!this.config.enabled || !root) return [];

    /*
      A list, because a file can have more than one server: Tailwind completes
      class names *inside* HTML, CSS and JSX, all of which already have one. It
      is a companion rather than a replacement, so both run and their answers
      are merged — see `lsp/index.ts`.
    */
    const sessions: LspSession[] = [];

    for (const match of serversForPath(path)) {
      const { def, languageId } = match;
      if (!isEnabled(def.id, this.config.overrides)) continue;

      const key = serverKey(root, def.id);
      const session = new LspSession(this, key, path, languageId, getText);

      let group = this.sessions.get(key);
      if (!group) this.sessions.set(key, (group = new Set()));
      group.add(session);

      // A server about to be shut down for idleness is wanted again.
      const idle = this.idleTimers.get(key);
      if (idle) {
        clearTimeout(idle);
        this.idleTimers.delete(key);
      }

      const existing = this.clients.get(key);
      if (existing?.isReady) {
        session.bind(existing);
      } else {
        void this.ensure(key, def, root).then((client) => session.bind(client));
      }

      sessions.push(session);
    }

    return sessions;
  }

  /** @internal — a session closing. */
  release(key: string, session: LspSession): void {
    const group = this.sessions.get(key);
    if (!group) return;
    group.delete(session);
    if (group.size) return;

    this.sessions.delete(key);
    // Not stopped at once: switching between two files is a close and an open a
    // few milliseconds apart, and a server restarted every time the user
    // changed tab would be unusable.
    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      if (!this.sessions.get(key)?.size) void this.stop(key);
    }, IDLE_MS);
    this.idleTimers.set(key, timer);
  }

  /** The primary client for a file, if one is already running and ready. */
  clientFor(path: string): LspClient | null {
    const root = this.config.root;
    const match = primaryServerForPath(path);
    if (!root || !match) return null;
    const client = this.clients.get(serverKey(root, match.def.id));
    return client?.isReady ? client : null;
  }

  // ─── Starting and stopping ────────────────────────────────────────────────

  private async ensure(
    key: string,
    def: LspServerDef,
    root: string
  ): Promise<LspClient | null> {
    const ready = this.clients.get(key);
    if (ready?.isReady) return ready;

    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const attempt = this.start(key, def, root).finally(() => {
      this.starting.delete(key);
    });
    this.starting.set(key, attempt);
    return attempt;
  }

  private async start(
    key: string,
    def: LspServerDef,
    root: string
  ): Promise<LspClient | null> {
    const resolved = resolveServer(def, this.config.overrides);

    // Asked before spawning, so "not installed" is reported as itself rather
    // than as a failed start.
    const detected = await this.detect();
    if (detected.get(def.id) === null) {
      this.notifyStatus();
      return null;
    }

    try {
      const client = await LspClient.start(key, resolved, root, {
        onDiagnostics: (uri, items) => this.publish(uri, items),
        onStatus: () => this.notifyStatus(),
        onApplyEdit: (edit) => this.applyEdit(edit),
        settingsFor: (section) => this.settingsFor(section),
        onExit: (info) => {
          if (info.expected) return;
          /*
            The server's own last words, not "it exited".

            This is the only thing that distinguishes a crash from a program
            that was never really installed — `~/.cargo/bin/rust-analyzer` is a
            *rustup shim* that exists whether or not the component does, so no
            amount of looking at `PATH` can tell them apart. Running it is what
            tells you, and what it says is
            "Unknown binary 'rust-analyzer' in official toolchain".
          */
          const reason =
            info.stderr[info.stderr.length - 1] ??
            `exited with code ${info.code ?? "unknown"}`;
          this.scheduleRestart(key, def, root, reason);
        },
      });
      this.clients.set(key, client);
      this.failures.delete(key);
      this.notifyStatus();
      return client;
    } catch (error) {
      console.warn(`lsp: ${resolved.program} did not start`, error);
      this.clients.delete(key);
      this.recordFailure(key, String(error));
      this.notifyStatus();
      return null;
    }
  }

  private recordFailure(key: string, reason: string): void {
    const now = Date.now();
    const previous = this.failures.get(key);
    const consecutive = previous && now - previous.at < FAILURE_WINDOW_MS ? previous.count : 0;
    this.failures.set(key, { count: consecutive + 1, at: now, reason: tidy(reason) });
  }

  /**
   * Tries again after an unexpected exit — up to a point.
   *
   * A server that crashes on a particular file crashes again on the same file
   * immediately, so the ceiling is what stops this becoming a restart loop
   * nobody can see.
   */
  private scheduleRestart(
    key: string,
    def: LspServerDef,
    root: string,
    reason: string
  ): void {
    this.clients.delete(key);
    if (!this.sessions.get(key)?.size) return;

    this.recordFailure(key, reason);
    const failures = this.failures.get(key)?.count ?? 1;
    if (failures > MAX_FAILURES) {
      console.warn(`lsp: ${def.program} keeps stopping; leaving it alone`);
      this.notifyStatus();
      return;
    }

    const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    clearTimeout(this.restartTimers.get(key));
    this.restartTimers.set(
      key,
      setTimeout(() => {
        this.restartTimers.delete(key);
        const group = this.sessions.get(key);
        if (!group?.size) return;
        void this.ensure(key, def, root).then((client) => {
          for (const session of group) session.bind(client);
        });
      }, delay)
    );
  }

  private async stop(key: string): Promise<void> {
    clearTimeout(this.restartTimers.get(key));
    this.restartTimers.delete(key);
    clearTimeout(this.idleTimers.get(key));
    this.idleTimers.delete(key);

    const client = this.clients.get(key);
    this.clients.delete(key);
    if (!client) return;

    // Diagnostics from a server that is no longer running are not diagnostics.
    for (const session of this.sessions.get(key) ?? []) {
      this.publish(session.uri, []);
      session.bind(null);
    }

    await client.dispose();
    this.notifyStatus();
  }

  /** Restarts one server by id, for the button in settings. */
  async restart(serverId: string): Promise<void> {
    const root = this.config.root;
    if (!root) return;
    const key = serverKey(root, serverId);
    const def = SERVERS.find((server) => server.id === serverId);
    await this.stop(key);
    this.failures.delete(key);
    if (!def || !this.config.enabled) return;

    const group = this.sessions.get(key);
    if (!group?.size) return;
    const client = await this.ensure(key, def, root);
    for (const session of group) session.bind(client);
  }

  async stopAll(): Promise<void> {
    const keys = [...this.clients.keys()];
    await Promise.all(keys.map((key) => this.stop(key)));
    for (const uri of [...this.diagnostics.keys()]) this.publish(uri, []);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  private publish(uri: string, items: Diagnostic[]): void {
    if (items.length) this.diagnostics.set(uri, items);
    else this.diagnostics.delete(uri);
    for (const listener of this.diagnosticListeners.get(uri) ?? []) listener(items);
  }

  diagnosticsFor(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  onDiagnostics(uri: string, listener: (items: Diagnostic[]) => void): Unsubscribe {
    let group = this.diagnosticListeners.get(uri);
    if (!group) this.diagnosticListeners.set(uri, (group = new Set()));
    group.add(listener);
    return () => {
      group!.delete(listener);
      if (!group!.size) this.diagnosticListeners.delete(uri);
    };
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  onStatusChange(listener: () => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }

  /** Every server in the table, with what it is currently doing. */
  states(): LspServerState[] {
    const root = this.config.root;
    return SERVERS.map((def) => {
      const path = this.detected.get(def.id) ?? null;
      const client = root ? this.clients.get(serverKey(root, def.id)) : undefined;

      let phase: LspServerState["phase"];
      let status: LspStatus | null = client?.status ?? null;

      if (!this.config.enabled || !isEnabled(def.id, this.config.overrides)) {
        phase = "off";
        status = null;
      } else if (!this.detected.size) {
        // Detection hasn't run yet; claiming "missing" here would flash an
        // install line at everyone on first open.
        phase = "idle";
      } else if (path === null) {
        phase = "missing";
      } else if (client) {
        phase = client.status.phase;
      } else {
        // Any recorded failure shows, not only one past the restart ceiling.
        // A server that refuses the handshake fails on its first try and never
        // gets a second, so waiting for a third would mean never reporting the
        // most common failure there is — and the user would be left with an
        // editor showing no diagnostics and nothing to explain why.
        const failure = root ? this.failures.get(serverKey(root, def.id)) : undefined;
        phase = failure ? "failed" : "idle";
        if (failure) status = { phase: "failed", detail: null, error: failure.reason };
      }

      return {
        def,
        phase,
        detail: status?.detail ?? null,
        error: status?.error ?? null,
        path,
      };
    });
  }

  /** The state of whichever server owns a file, for the status bar. */
  stateFor(path: string): LspServerState | null {
    const match = primaryServerForPath(path);
    if (!match) return null;
    return this.states().find((state) => state.def.id === match.def.id) ?? null;
  }
}

/**
 * One manager for the app.
 *
 * A singleton because the servers are: two editor modals would otherwise each
 * start their own `rust-analyzer` against the same folder, which is the exact
 * failure the cap in `lsp/registry.rs` exists to catch.
 */
export const lsp = new LspManager();
