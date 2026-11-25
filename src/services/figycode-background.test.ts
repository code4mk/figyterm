/**
 * Background jobs, seen from the window.
 *
 * The part worth testing is the diff. A finished job *stays* in the
 * shell's list — deliberately, because "it disappeared" is not an
 * outcome — so whether a completion is announced once or on every poll
 * for the rest of the session comes down to comparing against the
 * previous reading rather than against the current state. At one poll
 * a second, getting that wrong is sixty identical notices a minute.
 */

import assert from "node:assert/strict";
import type { BackgroundJob } from "./figycode-agent";
import {
  backgroundLabel,
  finishedSince,
  formatDuration,
  mine,
  outcomeOf,
  reportOf,
  shortCommand,
  stillRunning,
} from "./figycode-background";

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

console.log("figycode-background");

function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "bg_1",
    command: "docker build -t figycode-image .",
    owner: "window",
    finished: false,
    status: null,
    ms: 4_000,
    lines: 7,
    ...over,
  };
}

/* ─── Noticing what finished ──────────────────────────────────────────────── */

test("a job that was running and is now done is announced", () => {
  const before = [job()];
  const now = [job({ finished: true, status: 0, ms: 134_000 })];
  assert.deepEqual(
    finishedSince(before, now).map((one) => one.id),
    ["bg_1"]
  );
});

test("and is announced exactly once, however many times we look", () => {
  /*
    The shell keeps finished jobs on purpose. Comparing against the
    current state rather than the previous reading would re-announce
    the same completed build on every poll — sixty notices a minute,
    for as long as the window stayed open.
  */
  const done = [job({ finished: true, status: 0 })];
  assert.deepEqual(finishedSince(done, done), [], "the second look says nothing");
});

test("a job that finished before we ever saw it still counts", () => {
  // A command that fails fast beats the next poll, so its only
  // appearance in the list is already finished.
  const now = [job({ finished: true, status: 127 })];
  assert.deepEqual(
    finishedSince([], now).map((one) => one.id),
    ["bg_1"]
  );
});

test("a job that merely vanished is not a completion", () => {
  /*
    Finished jobs stay in the list, so a disappearance means the window
    closed or the shell was replaced. Inventing a completion for it
    would be a lie with an exit code on it.
  */
  assert.deepEqual(finishedSince([job()], []), []);
});

test("one job finishing does not announce the others", () => {
  const before = [job({ id: "bg_1" }), job({ id: "bg_2" })];
  const now = [job({ id: "bg_1", finished: true, status: 0 }), job({ id: "bg_2" })];
  assert.deepEqual(
    finishedSince(before, now).map((one) => one.id),
    ["bg_1"]
  );
});

test("still running is what the bar draws", () => {
  const jobs = [job({ id: "bg_1", finished: true, status: 0 }), job({ id: "bg_2" })];
  assert.deepEqual(
    stillRunning(jobs).map((one) => one.id),
    ["bg_2"]
  );
});

/* ─── The outcome, in words ───────────────────────────────────────────────── */

test("a non-zero exit is a failure, not a completion with a footnote", () => {
  // "Finished" for a build that exited 1 is how an agent tells
  // somebody their image built when it did not.
  const out = outcomeOf(job({ finished: true, status: 1, ms: 134_000 }));
  assert.equal(out.tone, "error");
  assert.match(out.title, /FAILED · exit 1 · 2m 14s/);
});

test("exit zero reads as done and says how long it took", () => {
  const out = outcomeOf(job({ finished: true, status: 0, ms: 134_000 }));
  assert.equal(out.tone, "info");
  assert.match(out.title, /docker build finished · 2m 14s/);
});

test("a job killed without an exit code is told apart from both", () => {
  // Stopped is not failed and is not done. Three outcomes, three
  // sentences.
  const out = outcomeOf(job({ finished: true, status: null, ms: 9_000 }));
  assert.equal(out.tone, "warn");
  assert.match(out.title, /stopped/);
  assert.match(out.body, /killed/);
});

test("the body carries the whole command, not the shortened one", () => {
  // The title is for scanning and the body is for knowing which of two
  // builds this was.
  const out = outcomeOf(job({ finished: true, status: 0 }));
  assert.match(out.body, /docker build -t figycode-image \./);
});

/* ─── Whose job it is ─────────────────────────────────────────────────────── */

test("only the conversation that started a job reports it", () => {
  /*
    Both surfaces watch one shell — it is one machine and one set of
    processes — so both see every job finish. Without this the FigyCode
    window and the editor panel would each spend a request telling
    their own model about the same build, and one of them never
    started it and has no idea what it was for.
  */
  const done = [
    job({ id: "bg_1", owner: "window", finished: true, status: 0 }),
    job({ id: "bg_2", owner: "panel", finished: true, status: 0 }),
  ];
  assert.deepEqual(
    mine(done, "window").map((one) => one.id),
    ["bg_1"]
  );
  assert.deepEqual(
    mine(done, "panel").map((one) => one.id),
    ["bg_2"]
  );
});

test("a job with no owner is nobody's to speak for", () => {
  // Which is what a shell that does not track owners reports, and the
  // safe reading of "nobody started this" is "say nothing".
  const orphan = [job({ owner: "" as never, finished: true, status: 0 })];
  assert.deepEqual(mine(orphan, "window"), []);
  assert.deepEqual(mine(orphan, "panel"), []);
});

/* ─── What the agent is told, which is not what the person reads ──────────── */

test("the agent is told the two facts it cannot know, and what to do", () => {
  /*
    The notice is for the person and is already on screen. This is the
    message that makes the agent go and look — the id and the command
    are already in its history from the call that started them, so what
    this adds is that it ended and how.
  */
  const ok = reportOf(job({ finished: true, status: 0, ms: 134_000 }));
  assert.match(ok, /bg_1/, "which job");
  assert.match(ok, /exit 0/);
  assert.match(ok, /2m 14s/);
  assert.match(ok, /one sentence/, "a green build does not need four paragraphs");

  const bad = reportOf(job({ finished: true, status: 1 }));
  assert.match(bad, /FAILED with exit 1/);
  assert.match(bad, /bash_output/, "a failure is worth reading the log for");
  assert.match(bad, /fix it/);
});

test("a killed job does not ask the agent to restart it", () => {
  // Somebody pressed Stop. An agent that helpfully starts it again has
  // undone the one thing they asked for.
  const out = reportOf(job({ finished: true, status: null }));
  assert.match(out, /stopped/);
  assert.match(out, /Do not restart it unless I ask/);
});

test("the outcome says whether it failed, for the tone of the notice", () => {
  assert.equal(outcomeOf(job({ finished: true, status: 0 })).failed, false);
  assert.equal(outcomeOf(job({ finished: true, status: 1 })).failed, true);
});

/* ─── Reading it at a glance ──────────────────────────────────────────────── */

test("a command is named by its first two words", () => {
  // What identifies it at a glance; the rest is flags.
  assert.equal(shortCommand("docker build -t figycode-image ."), "docker build");
  assert.equal(shortCommand("npm run build"), "npm run");
  assert.equal(shortCommand("make"), "make");
});

test("a very long first two words are cut rather than allowed to push the row", () => {
  assert.ok(shortCommand(`${"x".repeat(50)} build`).length <= 32);
});

test("durations read in the units somebody would say", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(47_000), "47s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(134_000), "2m 14s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(5_400_000), "1h 30m");
  // A clock that went backwards is not a negative build.
  assert.equal(formatDuration(-5), "0s");
});

test("the label names the command when there is one and counts when there are more", () => {
  assert.equal(backgroundLabel([]), null, "nothing running, nothing to say");
  assert.equal(backgroundLabel([job({ ms: 47_000 })]), "docker build · 47s");
  assert.equal(
    backgroundLabel([job({ id: "bg_1" }), job({ id: "bg_2" })]),
    "2 background tasks"
  );
  assert.equal(
    backgroundLabel([job({ finished: true, status: 0 })]),
    null,
    "a finished job is not a running one"
  );
});

process.exit(failures ? 1 : 0);
