/**
 * OAuth 2: the exchange, and the arithmetic of expiry.
 *
 * Every failure this covers is silent at the point it happens and loud much
 * later. A lifetime stored as a relative number is a token that looks fresh
 * forever; a missing `state` is a redirect nobody can tie to a request; a
 * refresh that fires a second late is an intermittent 401 that reads like the
 * server's fault. None of it shows up in a screenshot.
 */

import assert from "node:assert/strict";
import {
  authorizationHeader,
  authorizeUrl,
  canRefresh,
  EMPTY_TOKEN,
  EXPIRY_SKEW_MS,
  isUsable,
  parseExtra,
  parseTokenResponse,
  readConfig,
  readRedirect,
  readToken,
  tokenRequest,
  writeToken,
  type OAuthConfig,
} from "./oauth";

let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

console.log("api/oauth");

const CONFIG: OAuthConfig = {
  grant: "authorization_code",
  authorizeUrl: "https://id.example.com/authorize",
  tokenUrl: "https://id.example.com/token",
  clientId: "abc",
  clientSecret: "shh",
  scope: "read write",
  redirectUri: "figyterm://oauth/callback",
  usePkce: true,
  clientAuth: "header",
  extraParams: "",
};

/* ─── reading the stored block ─────────────────────────────────────────── */

test("an unknown grant falls back to authorization code", () => {
  assert.equal(readConfig({ grantType: "wat" }).grant, "authorization_code");
  assert.equal(readConfig({}).grant, "authorization_code");
});

test("PKCE is on unless it was explicitly turned off", () => {
  // A block written by a tool that never heard of PKCE still gets it.
  assert.equal(readConfig({}).usePkce, true);
  assert.equal(readConfig({ usePkce: "true" }).usePkce, true);
  assert.equal(readConfig({ usePkce: "false" }).usePkce, false);
});

test("the redirect URI is read under either spelling", () => {
  // The interchange format writes `redirect_uri`; our own editor writes the
  // camel-cased one. A block that round-tripped through either must work.
  assert.equal(readConfig({ redirect_uri: "a://b" }).redirectUri, "a://b");
  assert.equal(readConfig({ redirectUri: "a://b" }).redirectUri, "a://b");
});

test("a missing expiry is null, not zero", () => {
  // Zero would be "expired in 1970", which throws away a perfectly good token.
  assert.equal(readToken({ accessToken: "t" }).expiresAt, null);
  assert.equal(readToken({ accessToken: "t", expiresAt: "" }).expiresAt, null);
  assert.equal(readToken({ accessToken: "t", expiresAt: "nonsense" }).expiresAt, null);
});

test("a token round-trips through the flat parameter bag", () => {
  const token = { ...EMPTY_TOKEN, accessToken: "a", refreshToken: "r", expiresAt: 1234 };
  assert.deepEqual(readToken(writeToken(token)), token);
});

/* ─── expiry ───────────────────────────────────────────────────────────── */

test("a token with no expiry is taken at face value", () => {
  // Plenty of servers issue these; guessing a lifetime would invent a failure.
  assert.equal(isUsable({ ...EMPTY_TOKEN, accessToken: "t" }), true);
});

test("an empty token is never usable", () => {
  assert.equal(isUsable(EMPTY_TOKEN), false);
  assert.equal(isUsable({ ...EMPTY_TOKEN, expiresAt: Date.now() + 1e6 }), false);
});

test("a token is retired before it actually expires", () => {
  // The skew is the whole point: a token that dies mid-flight is a 401 nobody
  // can reproduce.
  const now = 1_000_000;
  const almost = { ...EMPTY_TOKEN, accessToken: "t", expiresAt: now + EXPIRY_SKEW_MS - 1 };
  const safe = { ...EMPTY_TOKEN, accessToken: "t", expiresAt: now + EXPIRY_SKEW_MS + 1000 };
  assert.equal(isUsable(almost, now), false);
  assert.equal(isUsable(safe, now), true);
});

test("refreshing needs a refresh token and somewhere to send it", () => {
  assert.equal(canRefresh(CONFIG, { ...EMPTY_TOKEN, refreshToken: "r" }), true);
  assert.equal(canRefresh(CONFIG, EMPTY_TOKEN), false);
  assert.equal(
    canRefresh({ ...CONFIG, tokenUrl: "" }, { ...EMPTY_TOKEN, refreshToken: "r" }),
    false
  );
});

/* ─── the authorization request ────────────────────────────────────────── */

test("the authorize URL carries what the server needs", () => {
  const url = new URL(authorizeUrl(CONFIG, "st4te", "ch4llenge"));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get("redirect_uri"), "figyterm://oauth/callback");
  assert.equal(url.searchParams.get("scope"), "read write");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("code_challenge"), "ch4llenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("without PKCE the challenge parameters are absent, not empty", () => {
  // An empty `code_challenge` is rejected by servers that support PKCE.
  const url = new URL(authorizeUrl(CONFIG, "s", null));
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert.equal(url.searchParams.has("code_challenge_method"), false);
});

test("an authorize URL that already has a query keeps it", () => {
  const url = new URL(
    authorizeUrl({ ...CONFIG, authorizeUrl: "https://id.example.com/a?tenant=acme" }, "s", null)
  );
  assert.equal(url.searchParams.get("tenant"), "acme");
  assert.equal(url.searchParams.get("client_id"), "abc");
});

/* ─── the redirect coming back ─────────────────────────────────────────── */

test("a redirect yields its code and state", () => {
  const out = readRedirect("figyterm://oauth/callback?code=xyz&state=st4te");
  assert.deepEqual(out, { code: "xyz", state: "st4te" });
});

test("a redirect is read from the fragment as well as the query", () => {
  // A server really doing the implicit grant answers after a `#`; reporting
  // "no code" for a redirect that plainly has one is a bad way to find out.
  const out = readRedirect("figyterm://cb#code=xyz&state=s");
  assert.deepEqual(out, { code: "xyz", state: "s" });
});

test("the server's error is passed through, with its description", () => {
  const out = readRedirect(
    "figyterm://cb?error=access_denied&error_description=User%20said%20no"
  );
  assert.deepEqual(out, { error: "access_denied: User said no" });
});

test("a redirect with neither code nor error is an error, not a crash", () => {
  assert.ok("error" in readRedirect("figyterm://cb"));
  assert.ok("error" in readRedirect("not a url"));
});

/* ─── the token request ────────────────────────────────────────────────── */

test("client credentials go in the header by default", () => {
  const req = tokenRequest(CONFIG, "client_credentials", {});
  const auth = req.headers.find((h) => h.name === "Authorization");
  if (!auth) throw new Error("no Authorization header");
  // RFC 6749 says servers MUST support this form.
  assert.equal(auth.value, `Basic ${btoa("abc:shh")}`);
  assert.ok(!req.body.includes("client_secret"));
});

test("client credentials go in the body when the server wants them there", () => {
  // Plenty of real servers only read them from the body.
  const req = tokenRequest({ ...CONFIG, clientAuth: "body" }, "client_credentials", {});
  assert.ok(!req.headers.some((h) => h.name === "Authorization"));
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("client_id"), "abc");
  assert.equal(form.get("client_secret"), "shh");
});

test("the code exchange carries the code, redirect and verifier", () => {
  const req = tokenRequest(CONFIG, "authorization_code", {
    code: "c0de",
    redirect_uri: CONFIG.redirectUri,
    code_verifier: "v3rifier",
  });
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "c0de");
  assert.equal(form.get("redirect_uri"), "figyterm://oauth/callback");
  assert.equal(form.get("code_verifier"), "v3rifier");
});

test("a refresh does not re-request the scope", () => {
  // Sending it can narrow the token: RFC 6749 says the scope must not exceed
  // the original grant, and some servers treat a repeat as a downgrade.
  const req = tokenRequest(CONFIG, "refresh_token", { refresh_token: "r" });
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("refresh_token"), "r");
  assert.equal(form.has("scope"), false);
});

test("extra parameters reach the form", () => {
  const req = tokenRequest(
    { ...CONFIG, extraParams: "audience=https://api.example.com&tenant=acme" },
    "client_credentials",
    {}
  );
  const form = new URLSearchParams(req.body);
  assert.equal(form.get("audience"), "https://api.example.com");
  assert.equal(form.get("tenant"), "acme");
});

test("extra parameters survive values containing an equals sign", () => {
  assert.deepEqual(parseExtra("a=b=c&d=e"), [["a", "b=c"], ["d", "e"]]);
  assert.deepEqual(parseExtra(""), []);
  assert.deepEqual(parseExtra("&&"), []);
});

/* ─── the token response ───────────────────────────────────────────────── */

test("a lifetime becomes an instant, not a duration", () => {
  // Stored relative, a token looks fresh forever.
  const now = 1_000_000;
  const out = parseTokenResponse(
    JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 3600 }),
    now
  );
  if (!("token" in out)) throw new Error(out.error);
  assert.equal(out.token.expiresAt, now + 3_600_000);
});

test("a response without a lifetime has no expiry", () => {
  const out = parseTokenResponse(JSON.stringify({ access_token: "t" }));
  if (!("token" in out)) throw new Error(out.error);
  assert.equal(out.token.expiresAt, null);
});

test("the server's error is reported, not swallowed", () => {
  const out = parseTokenResponse(
    JSON.stringify({ error: "invalid_client", error_description: "Bad secret" })
  );
  assert.deepEqual(out, { error: "invalid_client: Bad secret" });
});

test("a form-encoded response is read too", () => {
  // Out of spec, and it happens.
  const out = parseTokenResponse("access_token=t&token_type=bearer&expires_in=60", 0);
  if (!("token" in out)) throw new Error(out.error);
  assert.equal(out.token.accessToken, "t");
  assert.equal(out.token.expiresAt, 60_000);
});

test("a response with no token is an error with a readable message", () => {
  assert.ok("error" in parseTokenResponse("not json at all"));
  assert.ok("error" in parseTokenResponse(JSON.stringify({ hello: "world" })));
  assert.ok("error" in parseTokenResponse(JSON.stringify(null)));
});

/* ─── what it becomes on the wire ──────────────────────────────────────── */

test("the header echoes the server's token type", () => {
  // A server that says MAC and is sent Bearer rejects its own token.
  assert.equal(
    authorizationHeader({ ...EMPTY_TOKEN, accessToken: "t", tokenType: "MAC" }),
    "MAC t"
  );
});

test("a lower-case bearer is normalised", () => {
  // Some servers send it lower case; some compare case-sensitively.
  assert.equal(
    authorizationHeader({ ...EMPTY_TOKEN, accessToken: "t", tokenType: "bearer" }),
    "Bearer t"
  );
});

process.exit(failures === 0 ? 0 : 1);
