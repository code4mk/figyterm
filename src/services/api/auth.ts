/**
 * Authentication: what a request inherits, and what that turns into on the wire.
 *
 * The block is stored in the interchange format's own shape — a type and a list
 * of `{key, value}` parameters — so an imported auth block round-trips without
 * a translation layer, and a block this app writes is one any other tool reads.
 *
 * **Missing is not the same as none.** An absent `auth` inherits from the
 * folder, then the collection; an explicit `noauth` block stops the search and
 * sends nothing. Conflating the two breaks every request in a folder at once,
 * which is why it has its own test.
 */

export type AuthType = "inherit" | "noauth" | "basic" | "bearer" | "apikey";

/** The types this can apply. Others are preserved and reported, not applied. */
export const SUPPORTED_AUTH: AuthType[] = ["inherit", "noauth", "basic", "bearer", "apikey"];

export interface ParsedAuth {
  type: string;
  /** Flattened from the format's parameter list. */
  params: Record<string, string>;
}

export const NO_AUTH: ParsedAuth = { type: "noauth", params: {} };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a stored block.
 *
 * Returns `null` for "there is no block here", which is what inheritance turns
 * on. A block whose parameters are an object rather than a list is read too —
 * that is the older shape, and a file that slipped past the upgrade should not
 * lose its credentials over it.
 */
export function readAuth(block: unknown): ParsedAuth | null {
  if (!isObject(block)) return null;
  const type = typeof block.type === "string" ? block.type : null;
  if (!type) return null;

  const params: Record<string, string> = {};
  const raw = block[type];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry)) continue;
      const key = typeof entry.key === "string" ? entry.key : null;
      if (key) params[key] = entry.value === undefined ? "" : String(entry.value);
    }
  } else if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      params[key] = value === undefined ? "" : String(value);
    }
  }

  return { type, params };
}

/**
 * The block to store, or `null` to store nothing — which is what makes a
 * request inherit again.
 */
export function writeAuth(auth: ParsedAuth): Record<string, unknown> | null {
  if (auth.type === "inherit") return null;
  if (auth.type === "noauth") return { type: "noauth" };

  return {
    type: auth.type,
    [auth.type]: Object.entries(auth.params).map(([key, value]) => ({
      key,
      value,
      type: "string",
    })),
  };
}

/**
 * The auth a request actually uses, given its own block and its ancestors'.
 *
 * `chain` runs innermost first: the request, then each folder up to the
 * collection. The first block present decides, and `noauth` deciding means no
 * credentials — it is an answer, not a gap.
 */
export function effectiveAuth(chain: (unknown | null)[]): ParsedAuth {
  for (const block of chain) {
    const parsed = readAuth(block);
    if (parsed) return parsed;
  }
  return NO_AUTH;
}

export interface AuthTarget {
  url: string;
  headers: { name: string; value: string; enabled: boolean }[];
}

export interface AuthOutcome extends AuthTarget {
  /** Set when the block is a type this cannot apply yet. */
  note?: string;
}

/** Base64 that survives a password outside Latin-1, which `btoa` alone does not. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function withHeader(target: AuthTarget, name: string, value: string): AuthTarget {
  // Replaces rather than appends: sending two `Authorization` headers is a
  // request most servers reject, and the auth block is the one that should win
  // over a header left behind from an earlier attempt.
  const headers = target.headers.filter(
    (header) => header.name.toLowerCase() !== name.toLowerCase()
  );
  return { ...target, headers: [...headers, { name, value, enabled: true }] };
}

/**
 * Applies the auth to a request that has already had its variables resolved.
 *
 * After resolution, deliberately: a token is nearly always `{{token}}`, and
 * applying auth first would put the literal braces into the header.
 */
export function applyAuth(auth: ParsedAuth, target: AuthTarget): AuthOutcome {
  switch (auth.type) {
    case "noauth":
    case "inherit":
      return target;

    case "basic": {
      const username = auth.params.username ?? "";
      const password = auth.params.password ?? "";
      return withHeader(target, "Authorization", `Basic ${base64(`${username}:${password}`)}`);
    }

    case "bearer": {
      const token = auth.params.token ?? "";
      return withHeader(target, "Authorization", `Bearer ${token}`);
    }

    case "apikey": {
      const key = auth.params.key ?? "";
      const value = auth.params.value ?? "";
      if (key === "") return target;

      if ((auth.params.in ?? "header") === "query") {
        const separator = target.url.includes("?") ? "&" : "?";
        return {
          ...target,
          url: `${target.url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
        };
      }
      return withHeader(target, key, value);
    }

    default:
      // Digest, OAuth, AWS SigV4 and the rest are stored, exported and shown —
      // just not applied. Saying so beats sending an unauthenticated request
      // that looks like it should have worked.
      return {
        ...target,
        note: `${auth.type} authentication is kept with this request but cannot be applied yet.`,
      };
  }
}

/** Every parameter an auth type has, in the order the editor shows them. */
export const AUTH_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  basic: [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
  ],
  bearer: [{ key: "token", label: "Token", secret: true }],
  apikey: [
    { key: "key", label: "Key" },
    { key: "value", label: "Value", secret: true },
    { key: "in", label: "Add to" },
  ],
};

/** What the Auth tab calls each type. */
export const AUTH_LABELS: Record<AuthType, string> = {
  inherit: "Inherit from parent",
  noauth: "No auth",
  basic: "Basic",
  bearer: "Bearer token",
  apikey: "API key",
};
