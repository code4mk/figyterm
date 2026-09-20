/**
 * Connecting the collections to a Postgres database, and watching it work.
 *
 * One panel, because the questions belong together: where is it, can this
 * machine reach it, is the schema there, how often should it run, and what did
 * the last pass do. A settings page that answered the first and left the rest
 * to a status bar would be a panel somebody has to visit twice.
 *
 * One kind of remote: Postgres, wherever it is. A server on this machine, one
 * on the office network, or a managed endpoint out on the internet — if this
 * machine can reach it and the credentials work, it syncs. There was a second
 * mode, a hosted project reached over its REST layer, and it went when the plan
 * settled on plain Postgres: a REST layer is something one vendor puts in front
 * of a database, and building against it meant building against that vendor.
 *
 * The connection is to the database itself, so this app is trusted with all of
 * it. The panel says so rather than leaving it to be worked out.
 *
 * The password is typed here and goes straight to the OS keychain. It is never
 * read back into the window — the panel is told only whether one is stored,
 * which is why the field is empty when you reopen it.
 *
 * **Test before Save.** A database that answers, with a schema that is missing
 * three tables, is the failure people actually hit. The test names them and
 * changes nothing; Save creates them.
 */

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Loader, RefreshCw, TriangleAlert, X } from "lucide-react";
import {
  DEFAULT_DIRECT_CONFIG,
  DirectConfig,
  SslMode,
  SyncProbe,
  SyncStatus,
} from "../../types/api";
import * as sync from "../../services/api/sync";
import { hostAdvice, parseConnectionString } from "../../services/api/connection";
import { formatDuration, timeAgo } from "../../services/api/format";
import { Select } from "./Select";

/** The five `sslmode` settings, with what each one actually protects against.
 *
 * Spelled exactly as a connection string spells them: whoever is filling this
 * in has one in front of them, and kinder words would mean translating twice. */
const SSL_MODES: { id: SslMode; hint: string }[] = [
  { id: "disable", hint: "No encryption. For a database on this machine, and nothing else." },
  { id: "prefer", hint: "Encrypt if the server offers it, otherwise carry on in the clear." },
  { id: "require", hint: "Encrypted, but the certificate is not checked." },
  { id: "verify-ca", hint: "The chain is checked; the hostname is not." },
  { id: "verify-full", hint: "Both are checked. The only one proof against an impostor." },
];

interface ConnectionPanelProps {
  status: SyncStatus | null;
  busy: boolean;
  onClose: () => void;
  onChanged: () => void;
  onSyncNow: () => void;
  onRestore: () => void;
}

export function ConnectionPanel({
  status,
  busy,
  onClose,
  onChanged,
  onSyncNow,
  onRestore,
}: ConnectionPanelProps) {
  const config = status?.config;

  /**
   * Whether the keychain already holds a key for this project.
   *
   * Asked here, once, when the panel opens — `api_sync_status` deliberately
   * does not answer it, because that runs on every window open and reading the
   * keychain can put up an OS password prompt.
   */
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => {
    let dropped = false;
    void sync
      .hasStoredKey()
      .then((found) => {
        if (!dropped) setHasKey(found);
      })
      // A keychain that will not answer means "you will have to type it
      // again", which is what `false` already says.
      .catch(() => undefined);
    return () => {
      dropped = true;
    };
  }, []);

  // A direct connection may legitimately have no password — a local socket, or
  // trust authentication — so a stored key is not what makes it connected.
  const connected = Boolean(config?.direct);

  const [interval, setInterval] = useState(String(config?.intervalSecs ?? 300));
  const [onFocus, setOnFocus] = useState(config?.syncOnFocus ?? true);

  const [direct, setDirect] = useState<DirectConfig>(config?.direct ?? DEFAULT_DIRECT_CONFIG);
  const [dbPassword, setDbPassword] = useState("");

  /**
   * The pasted string, and what reading it had to say.
   *
   * The fields below stay editable: a paste fills them in, it does not take
   * them over. Somebody whose provider writes the string slightly differently
   * should be able to paste it and then fix the one box that came out wrong.
   */
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteNotes, setPasteNotes] = useState<string[]>([]);

  const applyPaste = (text: string) => {
    setPasted(text);
    const { parsed, error } = parseConnectionString(text);
    setPasteError(error);
    setPasteNotes(parsed?.notes ?? []);
    if (!parsed) return;

    // The schema and the timeouts are this app's own settings, so whatever is
    // already in those boxes is kept.
    setDirect((current) => ({
      ...current,
      host: parsed.config.host,
      port: parsed.config.port,
      database: parsed.config.database,
      user: parsed.config.user,
      sslMode: parsed.config.sslMode,
    }));
    // Only when the string actually carried one: a placeholder must not
    // overwrite a password already typed below.
    if (parsed.password !== "") setDbPassword(parsed.password);
  };

  // Not shown twice: a paste already reports it in its own list.
  const typedHostAdvice =
    pasteNotes.length === 0 ? hostAdvice(direct.host) : null;

  const [probe, setProbe] = useState<SyncProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [migrating, setMigrating] = useState(false);
  /** The SQL that would create the tables, for running by hand instead. */
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reseeded when the panel is reopened on a different project.
  useEffect(() => {
    setDirect(config?.direct ?? DEFAULT_DIRECT_CONFIG);
  }, [config?.direct]);

  useEffect(() => {
    setInterval(String(config?.intervalSecs ?? 300));
    setOnFocus(config?.syncOnFocus ?? true);
  }, [config?.schema, config?.intervalSecs, config?.syncOnFocus]);

  // Follows the schema box, so what is on offer to copy is what pressing the
  // button would run.
  useEffect(() => {
    void sync
      .setupSql(direct.schema)
      .then(setSql)
      .catch(() => setSql(""));
  }, [direct.schema]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const test = async () => {
    setTesting(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await sync.testDirect(direct, dbPassword));
    } catch (thrown) {
      setError(String(thrown));
    } finally {
      setTesting(false);
    }
  };

  /**
   * Creates the tables, on purpose and on its own.
   *
   * This used to happen inside Connect, which meant a migration the database
   * refused looked exactly like a database nobody had set up: the same
   * "N missing" either way. Pressed here, whatever the server says is what
   * ends up on screen.
   */
  const createTables = async () => {
    setMigrating(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await sync.migrate(direct, dbPassword));
    } catch (thrown) {
      setError(String(thrown));
    } finally {
      setMigrating(false);
    }
  };

  /** A certificate somewhere on disk, chosen rather than typed. */
  const pickFile = async (what: keyof DirectConfig, title: string) => {
    const picked = await openDialog({ multiple: false, title });
    if (!picked || Array.isArray(picked)) return;
    setDirect({ ...direct, [what]: picked });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    /*
      The last test's result goes before this one starts.

      Connect creates the schema and then probes it, so its result replaces
      this — unless it throws, and then the old "7 missing" would still be on
      screen with the failure printed underneath it. Two lines that contradict
      each other, and the stale one is the reassuring one.
    */
    setProbe(null);
    try {
      const result = await sync.connectDirect({
        // `direct.schema` is the box on this form. The separate `schema`
        // state belonged to the hosted mode and is not what anybody edits
        // here — merging it in would create the tables in one schema while
        // the panel said another.
        config: direct,
        password: dbPassword,
        intervalSecs: Number(interval) || 300,
        syncOnFocus: onFocus,
      });
      setProbe(result);
      setDbPassword("");
      onChanged();
    } catch (thrown) {
      setError(String(thrown));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await sync.disconnect();
      setProbe(null);
      onChanged();
    } catch (thrown) {
      setError(String(thrown));
    } finally {
      setSaving(false);
    }
  };

  const toggleAuto = async (auto: boolean) => {
    try {
      await sync.settings({
        auto,
        intervalSecs: Number(interval) || 300,
        syncOnFocus: onFocus,
      });
      onChanged();
    } catch (thrown) {
      setError(String(thrown));
    }
  };

  const last = status?.last ?? null;
  const now = Date.now();

  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center pt-[6%]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />

      <div className="relative w-[min(680px,94%)] max-h-[84%] flex flex-col rounded-xl border border-ft-border bg-ft-elevated shadow-2xl">
        <div className="flex items-center gap-2 px-4 h-9 shrink-0 border-b border-ft-border">
          <span className="text-[12px] font-semibold text-ft-text">
            {connected ? "Connected" : "Connect to Postgres"}
          </span>
          {connected && config && (
            <span className="text-[10px] text-ft-text-muted truncate">
              {config.direct
                ? `${config.direct.host}:${config.direct.port}/${config.direct.database}`
                : ""}
            </span>
          )}
          <div className="flex-1" />
          <button
            className="p-1 rounded text-ft-text-muted hover:bg-ft-surface hover:text-ft-text"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-4 text-[11px]">
          {/* One kind of remote: Postgres, wherever it is.

              There was a second — a hosted project reached over its REST layer
              — and it went when the plan settled on plain Postgres. A REST
              layer is something one vendor puts in front of a database, and
              building against it meant building against that vendor. Any
              server this machine can reach works here: a container on this
              laptop, one on the office network, or a managed endpoint out on
              the internet. */}
          <div className="text-[10px] text-ft-text-muted">
            Any Postgres this machine can reach — managed or your own. This app
            connects to the database itself and is trusted with all of it, so point
            it at one you own.
          </div>

          <div className="flex flex-col gap-2">
              {/* Paste first, correct after.
                  Every provider hands out a connection string and nothing
                  else, and retyping it into six boxes is six chances to get
                  the port, the database or the username subtly wrong — two of
                  which fail as *authentication* errors and send people back to
                  a password that was right all along. */}
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">Paste</span>
                <input
                  className="api-url flex-1 min-w-0"
                  value={pasted}
                  spellCheck={false}
                  placeholder="postgresql://user:password@host:5432/database"
                  onChange={(e) => applyPaste(e.target.value)}
                  aria-label="Paste a connection string"
                />
                {pasted !== "" && (
                  <button
                    className="api-button-quiet"
                    onClick={() => {
                      setPasted("");
                      setPasteError(null);
                      setPasteNotes([]);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {pasteError && (
                <div className="flex items-start gap-2 pl-[104px] text-ft-error">
                  <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                  <span>{pasteError}</span>
                </div>
              )}
              {pasteNotes.map((note, index) => (
                <div key={index} className="flex items-start gap-2 pl-[104px] text-ft-warning">
                  <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                  <span className="leading-relaxed">{note}</span>
                </div>
              ))}

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">Host</span>
                <input
                  className="api-url flex-1 min-w-0"
                  value={direct.host}
                  spellCheck={false}
                  onChange={(e) => setDirect({ ...direct, host: e.target.value })}
                />
                <span className="text-ft-text-muted">Port</span>
                <input
                  className="api-url w-20"
                  inputMode="numeric"
                  value={direct.port}
                  onChange={(e) =>
                    setDirect({ ...direct, port: Number(e.target.value) || 5432 })
                  }
                />
              </div>

              {/* Said about whatever is in the box, typed or pasted. A host
                  with no IPv4 address fails as a name lookup, which reads like
                  a typo and is not one — and waiting for Test to say so is
                  waiting for the wrong answer. */}
              {typedHostAdvice && (
                <div className="flex items-start gap-2 pl-[104px] text-ft-warning">
                  <TriangleAlert size={12} className="mt-[2px] shrink-0" />
                  <span className="leading-relaxed">{typedHostAdvice}</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">Database</span>
                <input
                  className="api-url flex-1 min-w-0"
                  value={direct.database}
                  spellCheck={false}
                  onChange={(e) => setDirect({ ...direct, database: e.target.value })}
                />
                <span className="text-ft-text-muted">Schema</span>
                {/* Trimmed as it is typed. A schema name cannot contain a
                    space, and a trailing one — from a paste, or a stray key —
                    is invisible in the box and in every message about it. */}
                <input
                  className="api-url w-32"
                  value={direct.schema}
                  spellCheck={false}
                  onChange={(e) => setDirect({ ...direct, schema: e.target.value.trim() })}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">User</span>
                <input
                  className="api-url flex-1 min-w-0"
                  value={direct.user}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setDirect({ ...direct, user: e.target.value })}
                />
                <input
                  className="api-url flex-1 min-w-0"
                  type="password"
                  value={dbPassword}
                  autoComplete="off"
                  placeholder={hasKey ? "Stored in the keychain" : "Password"}
                  onChange={(e) => setDbPassword(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">Encryption</span>
                <Select
                  className="w-[140px]"
                  value={direct.sslMode}
                  options={SSL_MODES.map((entry) => ({
                    value: entry.id,
                    label: entry.id,
                    hint: entry.hint,
                  }))}
                  onChange={(sslMode) => setDirect({ ...direct, sslMode })}
                  ariaLabel="SSL mode"
                />
                <span className="text-ft-text-muted truncate">
                  {SSL_MODES.find((entry) => entry.id === direct.sslMode)?.hint}
                </span>
              </div>

              {direct.sslMode !== "disable" && (
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-ft-text-muted">Certificates</span>
                  <button
                    className="api-button-quiet"
                    onClick={() => void pickFile("caPath", "Choose a certificate authority")}
                    title={direct.caPath ?? "None"}
                  >
                    {direct.caPath ? "CA chosen" : "Add a CA"}
                  </button>
                  <button
                    className="api-button-quiet"
                    onClick={() =>
                      void pickFile("clientCertPath", "Choose a client certificate")
                    }
                    title={direct.clientCertPath ?? "None"}
                  >
                    {direct.clientCertPath ? "Client cert chosen" : "Client cert"}
                  </button>
                  <button
                    className="api-button-quiet"
                    onClick={() => void pickFile("clientKeyPath", "Choose its key")}
                    title={direct.clientKeyPath ?? "A PKCS#12 bundle needs no separate key"}
                  >
                    {direct.clientKeyPath ? "Key chosen" : "Key (PEM only)"}
                  </button>
                  {(direct.caPath || direct.clientCertPath || direct.clientKeyPath) && (
                    <button
                      className="api-button-quiet"
                      onClick={() =>
                        setDirect({
                          ...direct,
                          caPath: null,
                          clientCertPath: null,
                          clientKeyPath: null,
                        })
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-ft-text-muted">Timeouts</span>
                <input
                  className="api-url w-24"
                  inputMode="numeric"
                  value={direct.connectTimeoutSecs}
                  onChange={(e) =>
                    setDirect({
                      ...direct,
                      connectTimeoutSecs: Number(e.target.value) || 15,
                    })
                  }
                />
                <span className="text-ft-text-muted">seconds to connect,</span>
                <input
                  className="api-url w-28"
                  inputMode="numeric"
                  value={direct.statementTimeoutMs}
                  onChange={(e) =>
                    setDirect({
                      ...direct,
                      statementTimeoutMs: Number(e.target.value) || 0,
                    })
                  }
                />
                <span className="text-ft-text-muted">ms per statement</span>
              </div>

              <div className="text-ft-text-muted pl-[104px]">
                The password goes to the OS keychain. Connecting creates the schema if it
                is not there — no SQL to copy anywhere.
              </div>
            </div>

          {/* ─── Test ──────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 pt-2 border-t border-ft-border-subtle">
            <button className="api-button-quiet" onClick={() => void test()} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              className="api-button"
              onClick={() => void save()}
              disabled={saving || direct.host.trim() === "" || direct.user.trim() === ""}
            >
              {saving ? "Saving…" : connected ? "Save" : "Connect"}
            </button>
            {connected && (
              <button className="api-button-quiet" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>

          {/* Reaching the database is the success. Whether its tables are
              there yet is a separate question with its own answer below —
              folding the two into one line made a working connection report
              itself as a warning. */}
          {probe && (
            <div
              className={`flex items-start gap-2 ${
                probe.reachable ? "text-ft-success" : "text-ft-error"
              }`}
            >
              {probe.reachable ? (
                <Check size={12} className="mt-[2px] shrink-0" />
              ) : (
                <TriangleAlert size={12} className="mt-[2px] shrink-0" />
              )}
              <span>
                {probe.message}
                {probe.reachable && ` (${formatDuration(probe.latencyMs)})`}
              </span>
            </div>
          )}

          {error && <div className="text-ft-error break-all">{error}</div>}

          {/* ─── The tables ────────────────────────────────────────────── */}
          {probe?.reachable && !probe.schemaReady && (
            <div className="flex flex-col gap-2 pt-2 border-t border-ft-border-subtle">
              <div className="flex items-center gap-2">
                <span className="text-ft-text">Set up the database</span>
                <span className="text-ft-text-muted truncate">
                  {probe.missing.length} table
                  {probe.missing.length === 1 ? "" : "s"} still to create in {direct.schema}
                </span>
                <div className="flex-1" />
                {/* Two ways, because the second is the one that works when the
                    first is refused: a role that may connect but not create is
                    ordinary, and somebody with the right credentials can run
                    this by hand in a console. */}
                <button
                  className="api-button-quiet flex items-center gap-1.5"
                  onClick={() => {
                    void navigator.clipboard.writeText(sql).then(() => setCopied(true));
                  }}
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? "Copied" : "Copy SQL"}
                </button>
                <button
                  className="api-button"
                  onClick={() => void createTables()}
                  disabled={migrating}
                >
                  {migrating ? "Creating…" : "Create them"}
                </button>
              </div>

              {/* Two routes, and the second is the one that works when the
                  first is refused: a role that may connect but not create is
                  an ordinary arrangement, and somebody with the owner's
                  credentials can run this in the provider's SQL editor. */}
              <div className="text-ft-text-muted">
                Press <b>Create them</b>, or copy this and run it in your database's
                SQL editor. It is one transaction and every statement is{" "}
                <code>IF NOT EXISTS</code>, so it is safe to run again.
              </div>

              <pre className="max-h-[160px] overflow-auto rounded border border-ft-border-subtle bg-ft-surface px-2 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre text-ft-text-secondary">
                {sql}
              </pre>
            </div>
          )}

          {/* ─── When ──────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2 pt-2 border-t border-ft-border-subtle">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
                checked={config?.auto ?? false}
                disabled={!connected}
                onChange={(e) => void toggleAuto(e.target.checked)}
              />
              <span className="text-ft-text">Sync on its own</span>
            </label>
            {/*
              Said plainly, because the old label — "Keep this machine in step"
              — read as the master switch and was one: turning it off stopped
              the Sync button working too, so there was no way to say "only
              when I ask". This is only the timer.
            */}
            <div className="pl-5 -mt-1 text-[10px] text-ft-text-muted">
              {config?.auto
                ? "Off leaves the connection alone — Sync still works when you press it."
                : "Off. Nothing syncs until you press Sync."}
            </div>

            <label className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-ft-text-muted">Every</span>
              <input
                className="api-url w-24"
                inputMode="numeric"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                onBlur={() => void toggleAuto(config?.auto ?? false)}
              />
              <span className="text-ft-text-muted">seconds, and whenever this window opens</span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
                checked={onFocus}
                onChange={(e) => {
                  setOnFocus(e.target.checked);
                  void sync.settings({
                    auto: config?.auto ?? false,
                    intervalSecs: Number(interval) || 300,
                    syncOnFocus: e.target.checked,
                  });
                }}
              />
              <span className="text-ft-text">Also when the window regains focus</span>
            </label>

            <div className="text-ft-text-muted">
              History never travels: it is large, and it holds response bodies that were
              never meant to be shared. A variable marked secret travels as a name with an
              empty value.
            </div>
          </div>

          {/* ─── How it is going ───────────────────────────────────────── */}
          <div className="flex flex-col gap-2 pt-2 border-t border-ft-border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-ft-text">Status</span>
              <div className="flex-1" />
              <button
                className="api-button-quiet flex items-center gap-1.5"
                onClick={onSyncNow}
                disabled={busy || !connected}
              >
                {busy ? <Loader size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Sync now
              </button>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-ft-text-muted">
              <span>
                {status?.pending ?? 0} waiting to be sent
              </span>
              <span>{status?.conflicts ?? 0} conflicted copies</span>
              {last && (
                <span>
                  last pass {timeAgo(last.finishedAt, now)} · {last.pushed} out, {last.pulled} in
                </span>
              )}
            </div>

            {last?.error && <div className="text-ft-error break-all">{last.error}</div>}

            <div className="flex items-center gap-2 pt-1">
              <button className="api-button-quiet" onClick={onRestore}>
                Restore the copy from before syncing
              </button>
              <span className="text-ft-text-muted">
                Replaces the local database. Reopen the window afterwards.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
