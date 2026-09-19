/**
 * What the URL bar means by what was typed into it.
 *
 * The case that matters most is the scheme: getting it wrong sends a dev
 * request to a TLS port that is not listening, or — much worse — sends a bearer
 * token to a public host in the clear. Both failures are silent at the moment
 * they happen, so they are pinned down here.
 */

import assert from "node:assert/strict";
import { isLocalHost, isSendableUrl, normalizeUrl, shortUrl } from "./url";
import { resolveText } from "./template";

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

console.log("api/url");

test("a URL with a scheme is left alone", () => {
  assert.equal(normalizeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(normalizeUrl("  https://example.com  "), "https://example.com");
});

test("an unqualified public host gets https", () => {
  assert.equal(normalizeUrl("api.example.com/v1/users"), "https://api.example.com/v1/users");
  assert.equal(normalizeUrl("example.com"), "https://example.com");
});

test("a local host gets http", () => {
  assert.equal(normalizeUrl("localhost:3000/health"), "http://localhost:3000/health");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeUrl("api.localhost/v1"), "http://api.localhost/v1");
  assert.equal(normalizeUrl("myapp.test/login"), "http://myapp.test/login");
});

test("a bare port is this machine", () => {
  assert.equal(normalizeUrl(":3000/health"), "http://localhost:3000/health");
});

test("a scheme-relative URL keeps its host's verdict", () => {
  assert.equal(normalizeUrl("//example.com/a"), "https://example.com/a");
  assert.equal(normalizeUrl("//localhost:9000"), "http://localhost:9000");
});

test("credentials in the authority don't fool the host check", () => {
  // The host is `evil.com`, not `localhost` — treating this as local would
  // hand the password to a public server over plain http.
  assert.equal(
    normalizeUrl("localhost:pass@evil.com/x"),
    "https://localhost:pass@evil.com/x"
  );
});

test("an IPv6 literal keeps its brackets", () => {
  assert.equal(normalizeUrl("[::1]:8080/x"), "http://[::1]:8080/x");
  assert.equal(normalizeUrl("[2001:db8::1]/x"), "https://[2001:db8::1]/x");
});

test("a path or query doesn't leak into the host", () => {
  assert.equal(normalizeUrl("example.com/localhost"), "https://example.com/localhost");
  assert.equal(normalizeUrl("example.com?to=localhost"), "https://example.com?to=localhost");
});

test("local hosts are recognised however they are spelled", () => {
  assert.equal(isLocalHost("LOCALHOST"), true);
  assert.equal(isLocalHost("host.docker.internal"), true);
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("example.com"), false);
  assert.equal(isLocalHost("notlocalhost.com"), false);
});

test("empty is not sendable, a host is", () => {
  assert.equal(isSendableUrl(""), false);
  assert.equal(isSendableUrl("   "), false);
  assert.equal(isSendableUrl("https://"), false);
  assert.equal(isSendableUrl("example.com"), true);
  assert.equal(isSendableUrl("http://localhost:3000"), true);
});

test("the short form drops the scheme and a trailing slash", () => {
  assert.equal(shortUrl("https://api.example.com/v1/users"), "api.example.com/v1/users");
  assert.equal(shortUrl("https://example.com/"), "example.com");
  assert.equal(shortUrl(""), "");
});

// ─── Scheme guessing and templates ───────────────────────────────────────────
//
// `normalizeUrl` guesses a scheme for anything that does not carry one. A URL
// that is still full of `{{variables}}` cannot be guessed about at all — the
// scheme may be inside one — so the guess belongs after resolution, and these
// pin what goes wrong when it is not.

test("a templated URL has no scheme to see, so it is not a public host either", () => {
  // It gains `https://` because it has no scheme, which is right on its own —
  // the point is that `execute.ts` must not do this before resolving.
  assert.equal(normalizeUrl("{{base_url}}/oauth/token"), "https://{{base_url}}/oauth/token");
});

/** The bug this pair exists for: a `base_url` that carries its own scheme,
 * prefixed again, sends `https://https://host/…` — a request to a host called
 * "https", which no server ever answers. */
test("resolving first and normalising second leaves one scheme", () => {
  const scopes = [
    {
      label: "Env",
      variables: [
        { key: "base_url", value: "https://reso-auth.northstarmls.com", enabled: true },
      ],
    },
  ];
  const resolved = resolveText("{{base_url}}/oauth/token", scopes).text;
  assert.equal(
    normalizeUrl(resolved),
    "https://reso-auth.northstarmls.com/oauth/token",
    "one scheme, the one the variable brought"
  );
});

test("normalising first and resolving second is what produced the doubled scheme", () => {
  const scopes = [
    {
      label: "Env",
      variables: [
        { key: "base_url", value: "https://reso-auth.northstarmls.com", enabled: true },
      ],
    },
  ];
  // Kept as a test rather than a comment: it is the exact wrong order, and
  // seeing what it produces is what stops somebody restoring it.
  const wrong = resolveText(normalizeUrl("{{base_url}}/oauth/token"), scopes).text;
  assert.equal(wrong, "https://https://reso-auth.northstarmls.com/oauth/token");
});

test("a variable holding a local host still resolves to one scheme", () => {
  const scopes = [
    { label: "Env", variables: [{ key: "base_url", value: "localhost:3000", enabled: true }] },
  ];
  const resolved = resolveText("{{base_url}}/health", scopes).text;
  assert.equal(normalizeUrl(resolved), "http://localhost:3000/health");
});

test("a variable that is only the host, with the scheme typed, is untouched", () => {
  const scopes = [
    { label: "Env", variables: [{ key: "host", value: "api.example.com", enabled: true }] },
  ];
  const resolved = resolveText("https://{{host}}/v1", scopes).text;
  assert.equal(normalizeUrl(resolved), "https://api.example.com/v1");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
