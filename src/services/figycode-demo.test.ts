/**
 * The decisions behind the Figy Code window that are arithmetic rather than
 * markup.
 *
 * The window is a prototype over invented data, so most of it cannot be
 * meaningfully tested — a scripted transcript is right when it looks right.
 * These four are the exceptions: what the two popups offer, which script a
 * prompt plays, and the two numbers the footer prints. Each of them is the
 * kind of thing that fails silently — a popup that offers nothing looks
 * exactly like a popup with nothing to offer.
 */

import assert from "node:assert/strict";
import {
  COMMANDS,
  cycleMode,
  filterCommands,
  formatElapsed,
  formatTokens,
  mentionAt,
  pickScript,
  planFor,
  runShell,
} from "./figycode-demo";

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

console.log("figycode-demo");

/* ─── Slash commands ───────────────────────────────────────────────────────── */

test("an empty query offers everything", () => {
  assert.equal(filterCommands("").length, COMMANDS.length);
  assert.equal(filterCommands("/").length, COMMANDS.length);
});

test("a prefix match outranks a match in the middle of a word", () => {
  // `/rewind` contains "in" — inside "rewind" — and must not come before the
  // command that actually begins with it.
  const names = filterCommands("/in").map((c) => c.name);
  assert.equal(names[0], "/init");
  assert.ok(names.indexOf("/rewind") > 0);
});

test("every command that begins with the query is offered, in order", () => {
  assert.deepEqual(filterCommands("/re").map((c) => c.name), ["/review", "/rewind"]);
});

test("the leading slash is optional", () => {
  assert.deepEqual(filterCommands("model"), filterCommands("/model"));
});

test("a query nothing matches offers nothing", () => {
  assert.deepEqual(filterCommands("/zzz"), []);
});

/* ─── Where a mention starts ───────────────────────────────────────────────── */

test("an @ at the caret opens a mention", () => {
  assert.deepEqual(mentionAt("explain @claude", 15), { query: "claude", start: 8 });
});

test("a bare @ opens an empty mention rather than none", () => {
  // The popup should appear the moment the key is pressed, listing everything.
  assert.deepEqual(mentionAt("@", 1), { query: "", start: 0 });
});

test("an @ mid-word is an email address, not a mention", () => {
  assert.equal(mentionAt("mail me@example.com", 19), null);
});

test("a space closes the mention", () => {
  assert.equal(mentionAt("@file and then", 14), null);
});

test("only the mention the caret is in counts", () => {
  // Two mentions, caret inside the first: the second must not be picked up.
  const found = mentionAt("@one @two", 4);
  assert.deepEqual(found, { query: "one", start: 0 });
});

/* ─── Which run plays ──────────────────────────────────────────────────────── */

test("a prompt picks the script that matches it", () => {
  assert.equal(pickScript("rename projectName everywhere").id, "rename");
  assert.equal(pickScript("build the macOS app and fix any warnings").id, "build");
  assert.equal(pickScript("add a theme setting: light, dark, follow system").id, "theme");
  assert.equal(pickScript("show the stash list in the git panel").id, "stash");
  assert.equal(pickScript("add a model field to Conversation").id, "model-field");
});

test("anything unrecognised still plays something", () => {
  // The fallback is the point: a prototype that does nothing on an unexpected
  // sentence reads as broken rather than as a prototype.
  assert.equal(pickScript("why is the moon like that").id, "generic");
  assert.equal(pickScript("").id, "generic");
});

/* ─── Plan mode ────────────────────────────────────────────────────────────── */

test("a plan is written from the run it is planning", () => {
  // The point of generating it: a plan that lists files the run never
  // touches is worse than no plan at all.
  const steps = pickScript("rename projectName everywhere").steps;
  const planned = planFor(steps);
  const plan = planned.find((s) => s.t === "plan");
  if (plan?.t !== "plan") throw new Error("the run was not given a plan");
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps.every((line) => typeof line === "string" && line.length > 0));
});

test("the plan hangs the original run off its own question", () => {
  const steps = pickScript("show the stash list in the git panel").steps;
  const ask = planFor(steps).find((s) => s.t === "ask");
  if (ask?.t !== "ask") throw new Error("the plan asked nothing");
  // Saying yes runs exactly what was planned, not a second copy of it.
  assert.deepEqual(ask.accept, steps);
});

test("a script that already plans is left alone", () => {
  const steps = pickScript("add a theme setting").steps;
  assert.deepEqual(planFor(steps), steps);
});

/* ─── Shell mode ───────────────────────────────────────────────────────────── */

test("a canned command is matched on its first two words", () => {
  const long = runShell("git log --oneline -4");
  assert.deepEqual(long, runShell("git log"));
  assert.ok(long.output[0].startsWith("d2e5696"));
});

test("an uncanned command says so rather than inventing output", () => {
  const result = runShell("kubectl get pods");
  assert.match(result.output[0], /^kubectl:/);
  assert.match(result.note, /prototype/);
});

/* ─── The footer's numbers ─────────────────────────────────────────────────── */

test("elapsed time turns over into minutes", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(14_000), "14s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(161_000), "2m 41s");
});

test("tokens keep one decimal only where it says something", () => {
  assert.equal(formatTokens(940), "940");
  assert.equal(formatTokens(2100), "2.1k");
  assert.equal(formatTokens(31_400), "31k");
});

/* ─── The mode cycle ───────────────────────────────────────────────────────── */

test("shift+tab returns to where it started", () => {
  assert.equal(cycleMode("ask"), "accept");
  assert.equal(cycleMode("accept"), "plan");
  assert.equal(cycleMode("plan"), "ask");
});

process.exit(failures ? 1 : 0);
