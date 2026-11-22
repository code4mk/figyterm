/**
 * OAuth 2 — getting a token, keeping it, and knowing when it has gone stale.
 *
 * The auth layer next door turns a stored block into headers; it has no idea
 * where a token came from and does not need one, because by the time a request
 * is sent an OAuth 2 block is a bearer token like any other. What is here is
 * everything *before* that: the grants, the exchange, and the arithmetic of
 * expiry.
 *
 * **Everything in this file is pure except `exchange`.** The URL building, the
 * form bodies, the response parsing and the expiry maths are functions of their
 * arguments, which is what makes them testable without a server — and this is
 * a part of an HTTP client where being wrong is silent: a token refreshed one
 * second too late is an intermittent 401 that looks like the server's fault.
 *
 * ## The three grants
 *
 * - **Client credentials** — a POST, a token, no browser. The machine-to-
 *   machine case, and the one that works end to end here today.
 * - **Refresh token** — a POST with the refresh token, which is how a session
 *   outlives its access token.
 * - **Authorization code with PKCE** — needs the user at a browser. The URL
 *   building, the verifier and the code exchange are all here and tested; what
 *   is not here is the window that shows the page and catches the redirect.
 *   See `authorizeUrl` for where that joins up.
 *
 * The implicit grant is deliberately absent. It is deprecated in OAuth 2.1 and
 * hands a token to a redirect URL where it lands in history and logs; PKCE
 * exists precisely so nobody needs it.
 */

/** The grants this understands. */
export type OAuthGrant = "authorization_code" | "client_credentials" | "refresh_token";

/** Where the client's own credentials go when asking for a token. */
export type ClientAuthPlacement = "header" | "body";

/**
 * The stored configuration, read out of the auth block's flat parameters.
 *
 * Flat strings because that is what the interchange format stores and what
 * every other tool will read back — see `auth.ts`. Booleans arrive as `"true"`.
 */
export interface OAuthConfig {
  grant: OAuthGrant;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  /** PKCE. On by default, and not offered as off for a public client. */
  usePkce: boolean;
  clientAuth: ClientAuthPlacement;
  /** Extra form fields, as `a=1&b=2`, for servers that want an audience. */
  extraParams: string;
}

/** What came back, in the shape the auth block stores it. */
export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  /** Epoch milliseconds, or `null` when the server did not say. */
  expiresAt: number | null;
  scope: string;
}

export const EMPTY_TOKEN: OAuthToken = {
  accessToken: "",
  refreshToken: "",
  tokenType: "Bearer",
  expiresAt: null,
  scope: "",
};

/**
 * How early a token counts as expired.
 *
 * A token that expires during the flight of the request it was attached to is
 * a 401 the user cannot explain and cannot reproduce. Thirty seconds is longer
 * than any request this client should be making and short enough that it never
 * throws away a usable token.
 */
export const EXPIRY_SKEW_MS = 30_000;

/** Reads the flat parameter bag into something with types. */
export function readConfig(params: Record<string, string>): OAuthConfig {
  const grant = params.grantType;
  return {
    grant:
      grant === "client_credentials" || grant === "refresh_token"
        ? grant
        : "authorization_code",
    authorizeUrl: params.authUrl ?? "",
    tokenUrl: params.accessTokenUrl ?? "",
    clientId: params.clientId ?? "",
    clientSecret: params.clientSecret ?? "",
    scope: params.scope ?? "",
    redirectUri: params.redirect_uri ?? params.redirectUri ?? "",
    // Absent means on. A stored `"false"` is the only way to turn it off, so a
    // block written by a tool that has never heard of PKCE still gets it.
    usePkce: (params.usePkce ?? "true") !== "false",
    clientAuth: params.client_authentication === "body" ? "body" : "header",
    extraParams: params.extraParams ?? "",
  };
}

/** Reads the token half of the same bag. */
export function readToken(params: Record<string, string>): OAuthToken {
  const expires = Number(params.expiresAt);
  return {
    accessToken: params.accessToken ?? "",
    refreshToken: params.refreshToken ?? "",
    tokenType: params.tokenType || "Bearer",
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
    scope: params.scope ?? "",
  };
}

/** The parameters to merge back into the auth block after a successful grant. */
export function writeToken(token: OAuthToken): Record<string, string> {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    tokenType: token.tokenType,
    expiresAt: token.expiresAt === null ? "" : String(token.expiresAt),
  };
}

/**
 * Whether a token should be used as it stands.
 *
 * A token with no expiry is taken at face value — plenty of servers issue
 * those, and guessing a lifetime for one would be inventing a failure.
 */
export function isUsable(token: OAuthToken, now = Date.now()): boolean {
  if (!token.accessToken) return false;
  if (token.expiresAt === null) return true;
  return token.expiresAt - EXPIRY_SKEW_MS > now;
}

/** Whether a stale token can be renewed without sending the user to a browser. */
export function canRefresh(config: OAuthConfig, token: OAuthToken): boolean {
  return token.refreshToken !== "" && config.tokenUrl !== "";
}

/* ─── PKCE ─────────────────────────────────────────────────────────────── */

/** The characters RFC 7636 allows in a verifier. */
const VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * A fresh code verifier.
 *
 * Built from `crypto.getRandomValues` rather than `Math.random`, which is the
 * whole point of the mechanism: a verifier an attacker can predict is a PKCE
 * exchange that protects nothing. Length 64, within the 43–128 the RFC allows.
 */
export function createVerifier(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length];
  return out;
}

/** Base64url, which is base64 without the padding or the two awkward characters. */
export function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The S256 challenge for a verifier.
 *
 * `plain` is not offered. It is allowed by the RFC and it is the mode that
 * does nothing — a challenge equal to its verifier proves only that the holder
 * of the code can copy a string.
 */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

/* ─── The authorization request ────────────────────────────────────────── */

/**
 * Where to send the browser for an authorization code.
 *
 * `state` is required rather than optional: it is the only thing that ties the
 * redirect that comes back to the request that went out, and an optional
 * parameter is one somebody leaves out.
 */
export function authorizeUrl(
  config: OAuthConfig,
  state: string,
  challenge: string | null
): string {
  const url = new URL(config.authorizeUrl);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", config.clientId);
  if (config.redirectUri) q.set("redirect_uri", config.redirectUri);
  if (config.scope) q.set("scope", config.scope);
  q.set("state", state);
  if (challenge) {
    q.set("code_challenge", challenge);
    q.set("code_challenge_method", "S256");
  }
  for (const [key, value] of parseExtra(config.extraParams)) q.set(key, value);
  return url.toString();
}

/**
 * The code and state out of a redirect, or the error the server sent instead.
 *
 * Reads the query *and* the fragment: a server that is really doing the
 * implicit grant will put its answer after a `#`, and reporting "no code" for
 * a redirect that plainly has one in it is a bad way to find that out.
 */
export function readRedirect(
  redirect: string
): { code: string; state: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return { error: "The redirect was not a URL." };
  }

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const get = (key: string) => url.searchParams.get(key) ?? fragment.get(key);

  const error = get("error");
  if (error) {
    const description = get("error_description");
    return { error: description ? `${error}: ${description}` : error };
  }

  const code = get("code");
  if (!code) return { error: "The redirect carried no authorization code." };
  return { code, state: get("state") ?? "" };
}

/* ─── The token request ────────────────────────────────────────────────── */

/** `a=1&b=2` as pairs, ignoring the empties a trailing `&` leaves. */
export function parseExtra(extra: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of extra.split("&")) {
    if (!part.trim()) continue;
    const index = part.indexOf("=");
    const key = index < 0 ? part : part.slice(0, index);
    const value = index < 0 ? "" : part.slice(index + 1);
    if (key.trim()) out.push([key.trim(), value]);
  }
  return out;
}

export interface TokenRequest {
  url: string;
  headers: { name: string; value: string }[];
  /** `application/x-www-form-urlencoded`, which is what the RFC specifies. */
  body: string;
}

/**
 * The request that asks for a token.
 *
 * The client secret goes in the `Authorization` header by default, which is
 * what RFC 6749 says servers MUST support — but plenty of real ones only read
 * it from the body, so the placement is configurable and both are built here
 * rather than guessed at by whoever is debugging a 401 at the time.
 */
export function tokenRequest(
  config: OAuthConfig,
  grant: OAuthGrant,
  extra: Record<string, string>
): TokenRequest {
  const form = new URLSearchParams();
  form.set("grant_type", grant);
  for (const [key, value] of Object.entries(extra)) {
    if (value) form.set(key, value);
  }
  if (config.scope && grant !== "refresh_token") form.set("scope", config.scope);
  for (const [key, value] of parseExtra(config.extraParams)) form.set(key, value);

  const headers = [
    { name: "Content-Type", value: "application/x-www-form-urlencoded" },
    { name: "Accept", value: "application/json" },
  ];

  if (config.clientAuth === "header" && config.clientId) {
    const pair = `${config.clientId}:${config.clientSecret}`;
    const bytes = new TextEncoder().encode(pair);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    headers.push({ name: "Authorization", value: `Basic ${btoa(binary)}` });
  } else {
    if (config.clientId) form.set("client_id", config.clientId);
    if (config.clientSecret) form.set("client_secret", config.clientSecret);
  }

  return { url: config.tokenUrl, headers, body: form.toString() };
}

/**
 * The token out of a token-endpoint response.
 *
 * Returns a message rather than throwing, because every failure here is
 * something the user has to read and act on — a wrong secret, a scope the
 * server will not grant — and an exception would arrive without the detail the
 * server took the trouble to send.
 */
export function parseTokenResponse(
  text: string,
  now = Date.now()
): { token: OAuthToken } | { error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Some servers answer form-encoded. It is out of spec and it happens.
    const form = new URLSearchParams(text);
    if (!form.get("access_token")) {
      return { error: "The token endpoint did not return JSON." };
    }
    payload = Object.fromEntries(form.entries());
  }

  if (typeof payload !== "object" || payload === null) {
    return { error: "The token endpoint returned something that is not an object." };
  }
  const body = payload as Record<string, unknown>;

  if (typeof body.error === "string") {
    const description =
      typeof body.error_description === "string" ? body.error_description : "";
    return { error: description ? `${body.error}: ${description}` : body.error };
  }

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) {
    return { error: "The token endpoint returned no access token." };
  }

  /*
    `expires_in` is seconds from now, and turning it into an absolute instant
    here is deliberate: a relative lifetime stored and read back later is a
    token that looks fresh forever.
  */
  const lifetime = Number(body.expires_in);
  const expiresAt =
    Number.isFinite(lifetime) && lifetime > 0 ? now + lifetime * 1000 : null;

  return {
    token: {
      accessToken,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : "",
      tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
      expiresAt,
      scope: typeof body.scope === "string" ? body.scope : "",
    },
  };
}

/**
 * The header a token becomes.
 *
 * `token_type` is echoed from the server rather than hardcoded to `Bearer`,
 * because a server that says `MAC` and is sent `Bearer` rejects its own token.
 */
export function authorizationHeader(token: OAuthToken): string {
  const type = token.tokenType || "Bearer";
  // Normalised to the capitalisation every server recognises; some send it
  // lower case and some compare case-sensitively.
  const normal = type.toLowerCase() === "bearer" ? "Bearer" : type;
  return `${normal} ${token.accessToken}`;
}
