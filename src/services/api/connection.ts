/**
 * A pasted Postgres connection string, turned into fields.
 *
 * Every hosting provider hands you one of these and nothing else. Retyping it
 * into six boxes is six chances to get the port, the database or the username
 * subtly wrong — and the two that go wrong most often fail as *authentication*
 * errors, which sends people to check the password they typed correctly.
 *
 * Pure, and tested, because the two parts that matter are both silent when
 * wrong: percent-decoding the password, and noticing a host that cannot be
 * reached before anybody waits for a timeout to say so.
 */

import { DEFAULT_DIRECT_CONFIG, DirectConfig, SslMode } from "../../types/api";

const SSL_MODES: SslMode[] = ["disable", "prefer", "require", "verify-ca", "verify-full"];

export interface ParsedConnection {
  config: DirectConfig;
  /** Empty when the string carried a placeholder instead of a real one. */
  password: string;
  /** Things worth saying before Test is pressed, not after it times out. */
  notes: string[];
}

export interface ConnectionParseResult {
  parsed: ParsedConnection | null;
  /** Set when the text is not a connection string at all. */
  error: string | null;
}

/**
 * What a provider writes where the password goes.
 *
 * Pasting the example from a dashboard is the normal first move, and treating
 * `[YOUR-PASSWORD]` as a password produces an authentication failure that
 * looks exactly like a wrong one.
 */
function isPlaceholder(password: string): boolean {
  const trimmed = password.trim();
  if (trimmed === "") return true;
  // `[YOUR-PASSWORD]`, `<password>`, `{{password}}`, `your-password`.
  return (
    /^[[<{(].*[\]>})]$/.test(trimmed) ||
    /^your[-_ ]?password$/i.test(trimmed) ||
    /^password$/i.test(trimmed)
  );
}

/**
 * Decodes one percent-encoded piece, leaving it alone if it will not decode.
 *
 * Providers tell people to percent-encode special characters, so a password
 * arrives as `p%40ss`. Handing that to the driver verbatim sends the wrong
 * password. A string that is not valid encoding — a literal `%` in a password
 * somebody never encoded — is kept as it is rather than thrown away.
 */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * What is worth saying about a host before Test is pressed.
 *
 * Written for Postgres in general, not for one provider. This app connects to
 * any server it can reach — a container on this machine, one on the office
 * network, a managed endpoint out on the internet — and advice that only fires
 * for one vendor's hostnames is advice that is silent exactly when somebody is
 * on another.
 *
 * Two shapes are worth naming because both fail as something they are not:
 *
 * - A **pooled** endpoint, which most providers spell with a `-pooler` suffix
 *   or a `pooler` label. Pooling in transaction mode does not do prepared
 *   statements, and this client uses them for every read and write — so it
 *   connects and then fails on the first operation, which is far more
 *   confusing than being told now.
 * - A **direct** endpoint that the provider resolves only inside its own
 *   network, or publishes with no IPv4 address at all. On a machine without
 *   IPv6 that is a name lookup failure, and the resolver's words — "nodename
 *   nor servname provided" — read like a typo in a hostname that is correct.
 */
export function hostAdvice(host: string): string | null {
  const lower = host.trim().toLowerCase();
  if (lower === "" || isLocal(lower)) return null;

  if (isPooled(lower)) {
    return (
      `That looks like a pooled endpoint. Use session pooling, not transaction ` +
      `pooling: transaction mode has no prepared statements and this app uses them, ` +
      `so syncing would fail after connecting successfully.`
    );
  }
  return null;
}

/** The spellings providers use for a pooled endpoint. */
function isPooled(host: string): boolean {
  return /(^|[.-])pooler([.-]|$)/.test(host) || host.includes("-pooler.");
}

/**
 * The username trap that reports itself as a wrong password.
 *
 * Several providers put the project or endpoint into the username —
 * `user.endpoint` — and given the bare name the server refuses the login as an
 * *authentication* failure. The obvious next move is to go and check the
 * password, which was right all along.
 */
function poolerAdvice(host: string, user: string): string | null {
  if (!isPooled(host.trim().toLowerCase())) return null;
  if (user.includes(".")) return null;
  return (
    `A pooled endpoint often wants the endpoint in the username — ` +
    `"${user}.<endpoint>" rather than "${user}". Copy the username out of the ` +
    `provider's connection string rather than typing it.`
  );
}

/**
 * Transaction pooling ports.
 *
 * 6543 is the one several providers use for transaction mode. It does not do
 * prepared statements, which this client uses for every read and write: it
 * connects and then fails on the first operation.
 */
function portAdvice(host: string, port: number): string | null {
  if (port !== 6543) return null;
  // Only where the host also looks pooled: 6543 on a server somebody runs
  // themselves is just the port they chose, and nagging about it would be
  // wrong far more often than right.
  if (!isPooled(host.trim().toLowerCase())) return null;
  return (
    `Port 6543 is usually transaction pooling, which does not support prepared ` +
    `statements — this app uses them, so syncing would fail after connecting. ` +
    `The session-pooling port is normally 5432.`
  );
}

/**
 * Reads `postgresql://user:password@host:port/database?sslmode=require`.
 *
 * Also accepts `postgres://`, and a string with no scheme at all, because a
 * dashboard that shows `host:port/db` is a dashboard somebody will paste from.
 */
export function parseConnectionString(text: string): ConnectionParseResult {
  const trimmed = text.trim().replace(/^["'`]|["'`]$/g, "");
  if (trimmed === "") return { parsed: null, error: null };

  // `psql 'postgres://…'` pastes with the command in front of it.
  const withoutCommand = trimmed.replace(/^psql\s+/i, "").replace(/^["']|["']$/g, "");

  const scheme = /^(postgres(?:ql)?):\/\//i.exec(withoutCommand);
  if (!scheme && withoutCommand.includes("://")) {
    return {
      parsed: null,
      error: "That is not a Postgres connection string — it should start with postgresql://",
    };
  }

  const body = scheme ? withoutCommand.slice(scheme[0].length) : withoutCommand;

  // Split off the query and the path before touching the authority, so a `/`
  // or `?` inside a password cannot be mistaken for a separator. Neither is
  // legal unencoded in userinfo, and an unencoded one is already broken.
  const [beforeQuery, query = ""] = splitOnce(body, "?");
  const [authority, path = ""] = splitOnce(beforeQuery, "/");

  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  const [rawUser, rawPassword = ""] = splitOnce(userinfo, ":");
  const user = decode(rawUser);
  const password = isPlaceholder(rawPassword) ? "" : decode(rawPassword);

  const { host, port, error } = readHostPort(hostPort);
  if (error) return { parsed: null, error };

  const database = decode(path.split("/")[0] ?? "");
  const params = new URLSearchParams(query);
  const sslParam = params.get("sslmode")?.toLowerCase() ?? "";
  const sslMode = SSL_MODES.includes(sslParam as SslMode) ? (sslParam as SslMode) : null;

  const notes: string[] = [];
  if (rawPassword !== "" && isPlaceholder(rawPassword)) {
    notes.push("The password is still the provider's placeholder — type the real one below.");
  } else if (rawPassword === "") {
    notes.push("No password in that string — type it below if the database wants one.");
  }
  // Both, where both apply: a pooled host and a bare username are two
  // separate things to fix, and naming one would send somebody back for the
  // other after the next failed test.
  for (const note of [hostAdvice(host), poolerAdvice(host, user), portAdvice(host, port)]) {
    if (note) notes.push(note);
  }

  return {
    parsed: {
      config: {
        ...DEFAULT_DIRECT_CONFIG,
        host,
        port,
        database: database === "" ? "postgres" : database,
        user,
        // Not from the string: this is the schema the app's own tables live
        // in, which no provider's connection string has an opinion about.
        schema: DEFAULT_DIRECT_CONFIG.schema,
        // Anything reached over the internet is encrypted unless the string
        // said otherwise. `prefer` would silently fall back to plaintext.
        sslMode: sslMode ?? (isLocal(host) ? "prefer" : "require"),
      },
      password,
      notes,
    },
    error: null,
  };
}

/** Splits on the first occurrence only, keeping the rest intact. */
function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + separator.length)];
}

function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** `host`, `host:port`, or `[::1]:5432` — the bracket form is how a literal
 * IPv6 address is written, and its colons are not a port separator. */
function readHostPort(text: string): { host: string; port: number; error: string | null } {
  const fallback = { host: "", port: 5432, error: null as string | null };

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2] ?? 5432), error: null };
  }

  const at = text.lastIndexOf(":");
  const host = at === -1 ? text : text.slice(0, at);
  const portText = at === -1 ? "" : text.slice(at + 1);

  if (host.trim() === "") {
    return { ...fallback, error: "That connection string has no host in it." };
  }
  if (portText !== "" && !/^\d+$/.test(portText)) {
    return { ...fallback, error: `"${portText}" is not a port number.` };
  }

  const port = portText === "" ? 5432 : Number(portText);
  if (port < 1 || port > 65535) {
    return { ...fallback, error: `${port} is not a port a server can listen on.` };
  }
  return { host: host.trim(), port, error: null };
}
