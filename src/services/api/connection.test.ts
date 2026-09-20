/**
 * Reading a pasted connection string.
 *
 * The cases that matter are the silent ones. A password that is not
 * percent-decoded connects with the wrong password and reports an
 * authentication failure; a placeholder taken literally does the same; and a
 * host that cannot resolve reports as a typo when it is a network fact. All
 * three send people to check the thing that was already right.
 */

import assert from "node:assert/strict";
import { hostAdvice, parseConnectionString } from "./connection";

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

const ok = (text: string) => {
  const result = parseConnectionString(text);
  assert.equal(result.error, null, result.error ?? "");
  assert.ok(result.parsed, "it parsed");
  return result.parsed!;
};

console.log("api/connection");

test("a whole connection string becomes fields", () => {
  const { config, password } = ok(
    "postgresql://postgres.abc123:s3cret@ep-cool-darkness-123.eu-central-1.aws.neon.tech:5432/postgres"
  );
  assert.equal(config.host, "ep-cool-darkness-123.eu-central-1.aws.neon.tech");
  assert.equal(config.port, 5432);
  assert.equal(config.database, "postgres");
  assert.equal(config.user, "postgres.abc123");
  assert.equal(password, "s3cret");
});

test("postgres:// and postgresql:// are both accepted", () => {
  assert.equal(ok("postgres://u:p@h:5432/d").config.host, "h");
  assert.equal(ok("postgresql://u:p@h:5432/d").config.host, "h");
});

test("a missing port is the default one", () => {
  assert.equal(ok("postgresql://u:p@example.com/db").config.port, 5432);
});

test("a missing database is postgres, which is what a server always has", () => {
  assert.equal(ok("postgresql://u:p@example.com:5432").config.database, "postgres");
});

/** Providers tell people to percent-encode the password. Handing that to the
 * driver verbatim sends the wrong password. */
test("a percent-encoded password is decoded", () => {
  assert.equal(ok("postgresql://u:p%40ss%3Aword@h:5432/d").password, "p@ss:word");
  assert.equal(ok("postgresql://po%2Bstgres:x@h/d").config.user, "po+stgres");
});

test("a password that is not valid encoding is kept as it was typed", () => {
  assert.equal(ok("postgresql://u:100%off@h/d").password, "100%off");
});

test("a colon in the password does not split the userinfo twice", () => {
  assert.equal(ok("postgresql://user:a:b:c@h/d").password, "a:b:c");
});

test("an @ in the password is handled, because the host is after the last one", () => {
  const parsed = ok("postgresql://user:pa@ss@example.com:5432/db");
  assert.equal(parsed.config.host, "example.com");
  assert.equal(parsed.password, "pa@ss");
});

// ─── The placeholder ─────────────────────────────────────────────────────────

/** Pasting the provider's example is the normal first move. Treating
 * `[YOUR-PASSWORD]` as a password fails as a *wrong password*. */
test("the provider's placeholder is not taken as a password", () => {
  const parsed = ok("postgresql://postgres:[YOUR-PASSWORD]@db.example.com:5432/postgres");
  assert.equal(parsed.password, "");
  assert.ok(parsed.notes.some((note) => note.includes("placeholder")));
});

test("other placeholder shapes are caught too", () => {
  for (const placeholder of ["<password>", "{{password}}", "your-password", "PASSWORD"]) {
    assert.equal(
      ok(`postgresql://u:${placeholder}@h/d`).password,
      "",
      `${placeholder} is a placeholder`
    );
  }
});

test("a password that merely contains the word is still a password", () => {
  assert.equal(ok("postgresql://u:password123@h/d").password, "password123");
});

// ─── Advice ──────────────────────────────────────────────────────────────────

/*
  Vendor-neutral on purpose.

  This app connects to any Postgres it can reach — a container on this machine,
  one on the office network, a managed endpoint on the internet — and advice
  that only fires for one provider's hostnames is advice that is silent exactly
  when somebody is on another. So the rules are about the *shape* a pooled
  endpoint has, which every provider spells much the same way.
*/
test("a pooled endpoint is recognised whoever is hosting it", () => {
  for (const host of [
    "ep-cool-darkness-123-pooler.eu-central-1.aws.neon.tech",
    "aws-0-eu-west-2.pooler.example.com",
    "pooler.internal",
    "db-pooler.acme.dev",
  ]) {
    const advice = hostAdvice(host);
    assert.ok(advice, `${host} was not recognised as pooled`);
    assert.ok(advice!.includes("prepared statements"), "it says what actually goes wrong");
  }
});

test("an ordinary host gets no advice", () => {
  assert.equal(hostAdvice("example.com"), null);
  assert.equal(hostAdvice("ep-cool-darkness-123.eu-central-1.aws.neon.tech"), null);
  assert.equal(hostAdvice("10.0.0.4"), null);
});

/** A database on this machine is not being reached over anybody's pooler. */
test("a local database is left alone", () => {
  assert.equal(hostAdvice("localhost"), null);
  assert.equal(hostAdvice("127.0.0.1"), null);
});

test("the advice comes back from a paste, not only from the helper", () => {
  const parsed = ok("postgresql://u:x@db-pooler.acme.dev:5432/app");
  assert.ok(parsed.notes.some((note) => note.includes("prepared statements")));
});

/** Several providers put the endpoint in the username. Getting it wrong is
 * refused as a login failure, so people go and check the password. */
test("a pooled username without its endpoint is flagged", () => {
  const parsed = ok("postgresql://postgres:x@db-pooler.acme.dev:5432/app");
  assert.ok(parsed.notes.some((note) => note.includes("endpoint in the username")));
});

test("a pooled username that already carries one is not flagged", () => {
  const parsed = ok("postgresql://postgres.abc123:x@db-pooler.acme.dev:5432/app");
  assert.ok(!parsed.notes.some((note) => note.includes("endpoint in the username")));
});

/** Two separate things to fix. Naming one would send somebody back for the
 * other after the next failed test. */
test("a pooled host and a bare username are both reported", () => {
  const parsed = ok("postgresql://postgres:x@db-pooler.acme.dev:6543/app");
  assert.ok(parsed.notes.some((note) => note.includes("endpoint in the username")));
  assert.ok(parsed.notes.some((note) => note.includes("6543")));
});

/** Transaction pooling has no prepared statements, and this client uses them
 * for everything. It connects, then fails on the first operation. */
test("the transaction-pooling port is flagged before it is used", () => {
  const parsed = ok("postgresql://postgres.abc123:x@db-pooler.acme.dev:6543/app");
  assert.ok(parsed.notes.some((note) => note.includes("prepared statements")));
});

test("6543 on a database that is not a pooler is somebody's own port", () => {
  const parsed = ok("postgresql://u:p@db.internal:6543/app");
  assert.ok(!parsed.notes.some((note) => note.includes("prepared statements")));
});

// ─── TLS ─────────────────────────────────────────────────────────────────────

test("sslmode is taken from the string when it says", () => {
  assert.equal(ok("postgresql://u:p@h/d?sslmode=verify-full").config.sslMode, "verify-full");
  assert.equal(ok("postgresql://u:p@h/d?sslmode=disable").config.sslMode, "disable");
});

/** `prefer` falls back to plaintext without saying so, which is the wrong
 * default for anything reached over the internet. */
test("a remote host with no sslmode is required, not preferred", () => {
  assert.equal(ok("postgresql://u:p@example.com/d").config.sslMode, "require");
});

test("localhost with no sslmode is not forced to encrypt", () => {
  assert.equal(ok("postgresql://u:p@localhost/d").config.sslMode, "prefer");
});

test("an sslmode nobody has heard of does not become the setting", () => {
  assert.equal(ok("postgresql://u:p@example.com/d?sslmode=maybe").config.sslMode, "require");
});

// ─── What people actually paste ──────────────────────────────────────────────

test("surrounding quotes and a psql in front are stripped", () => {
  assert.equal(ok(`psql "postgresql://u:p@h:5432/d"`).config.host, "h");
  assert.equal(ok(`'postgresql://u:p@h:5432/d'`).config.host, "h");
});

test("a literal IPv6 address keeps its colons", () => {
  const parsed = ok("postgresql://u:p@[2406:da12:557::1]:5432/d");
  assert.equal(parsed.config.host, "2406:da12:557::1");
  assert.equal(parsed.config.port, 5432);
});

test("a host and port with no scheme is still read", () => {
  const parsed = ok("example.com:5432/mydb");
  assert.equal(parsed.config.host, "example.com");
  assert.equal(parsed.config.database, "mydb");
});

test("nothing pasted is not an error, it is nothing", () => {
  assert.equal(parseConnectionString("").parsed, null);
  assert.equal(parseConnectionString("   ").error, null);
});

test("a string for something else says so rather than half-parsing", () => {
  const result = parseConnectionString("mysql://u:p@h/d");
  assert.equal(result.parsed, null);
  assert.ok(result.error!.includes("postgresql://"));
});

test("a port that is not a number is refused rather than silently defaulted", () => {
  assert.ok(parseConnectionString("postgresql://u:p@h:abcd/d").error!.includes("port"));
  assert.ok(parseConnectionString("postgresql://u:p@h:99999/d").error!.includes("port"));
});

/** The app's own tables live in a schema of its choosing; no provider's
 * connection string has an opinion about that. */
test("the schema is left at this app's own, not taken from the string", () => {
  assert.equal(ok("postgresql://u:p@h/d").config.schema, "figyman");
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
