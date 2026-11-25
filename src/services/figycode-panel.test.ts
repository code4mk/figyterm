/**
 * The panel's seed.
 *
 * Two things are worth a test here and they pull in opposite
 * directions: the seed has to carry enough that the first turn does not
 * spend a round trip asking what is on screen, and it has to shut up
 * about everything it has already said. Both are easy to get wrong in a
 * way nothing on screen would show — an over-eager seed just looks like
 * a slightly more expensive panel.
 */

import assert from "node:assert/strict";
import { settingsFrom, type AgentStatus } from "./figycode-agent";
import {
  MAX_SELECTION,
  PANEL_SYSTEM,
  emptyContext,
  seedContext,
  withContext,
  type EditorContext,
} from "./figycode-panel";

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

console.log("figycode-panel");

const file = "src/components/Editor/EditorModal.tsx";

function context(over: Partial<EditorContext> = {}): EditorContext {
  return { ...emptyContext(), file, tabs: ["FigyBlocks.tsx", "session.rs"], ...over };
}

/* ─── The first message ────────────────────────────────────────────────────── */

test("the first message carries the file, the tabs and the selection", () => {
  const seed = seedContext(
    context({ selection: { text: "const x = 1;", startLine: 12, endLine: 12 } }),
    null
  );
  assert.match(seed, /Open file: src\/components\/Editor\/EditorModal\.tsx/);
  assert.match(seed, /Other tabs open: FigyBlocks\.tsx, session\.rs/);
  assert.match(seed, /Selected, lines 12–12:/);
  assert.match(seed, /const x = 1;/);
});

test("with nothing open there is nothing to say", () => {
  // Rather than "Open file: null", which is a fact about our code.
  assert.equal(seedContext(emptyContext(), null), "");
});

test("the context goes above the sentence, and only when there is one", () => {
  assert.equal(withContext("what does this do", "Open file: a.ts"), "Open file: a.ts\n\nwhat does this do");
  assert.equal(withContext("hello", ""), "hello");
});

/* ─── Every message after it ──────────────────────────────────────────────── */

test("a second message repeats nothing", () => {
  // The expensive mistake, and an invisible one: the file is already
  // three messages up in the same conversation.
  const before = context();
  assert.equal(seedContext(context(), before), "");
});

test("switching tabs is news; the tab strip is not", () => {
  const before = context();
  const seed = seedContext(context({ file: "src/main.rs" }), before);
  assert.equal(seed, "Open file: src/main.rs");
  assert.doesNotMatch(seed, /Other tabs/, "said once, on the first message");
});

test("a new selection is news, and the same one is not", () => {
  const selection = { text: "fn main() {}", startLine: 3, endLine: 3 };
  const before = context({ selection });
  assert.equal(seedContext(context({ selection }), before), "");

  const moved = seedContext(
    context({ selection: { text: "fn other() {}", startLine: 9, endLine: 9 } }),
    before
  );
  assert.match(moved, /Selected, lines 9–9:/);
});

test("clearing the selection says nothing rather than saying it is gone", () => {
  // A message with no excerpt is a message about no excerpt. Spending
  // a line to announce the absence is the panel talking about itself.
  const before = context({ selection: { text: "x", startLine: 1, endLine: 1 } });
  assert.equal(seedContext(context({ selection: null }), before), "");
});

/* ─── ⌘A ──────────────────────────────────────────────────────────────────── */

test("a selection too big to quote becomes its own address", () => {
  // Select-all is one keystroke. A truncated excerpt would be worse
  // than none: the model answers about the half it saw and nothing
  // says the other half existed.
  const huge = "x".repeat(MAX_SELECTION + 1);
  const seed = seedContext(
    context({ selection: { text: huge, startLine: 1, endLine: 900 } }),
    null
  );
  assert.match(seed, /Selected: lines 1–900 of src\/components\/Editor\/EditorModal\.tsx/);
  assert.match(seed, /too much to quote/);
  assert.ok(!seed.includes("xxxxxxxxxx"), "the text itself does not ride along");
});

test("a selection just under the cap is quoted whole", () => {
  const text = "y".repeat(MAX_SELECTION);
  const seed = seedContext(context({ selection: { text, startLine: 1, endLine: 2 } }), null);
  assert.ok(seed.includes(text));
});

/* ─── The preamble ────────────────────────────────────────────────────────── */

test("the preamble does not claim the panel is missing tools it has", () => {
  /*
    It used to say "you cannot run commands, use git, or reach the
    network", which was true when the backend offered this surface
    seven tools. Both surfaces carry the whole registry now, and a
    preamble that lies about the tools produces a model that
    apologises instead of working.
  */
  for (const lie of [
    "You cannot run commands",
    "cannot run commands",
    "You cannot use git",
    "reach the network",
  ]) {
    assert.ok(!PANEL_SYSTEM.includes(lie), `the panel's prompt still says "${lie}"`);
  }
});

test("the preamble names the tools the panel actually has", () => {
  // Said once, because a model that does not know it has a shell will
  // guess at what the test would have printed.
  assert.match(PANEL_SYSTEM, /same tools as the main FigyCode window/);
  assert.match(PANEL_SYSTEM, /todo_write/);
  assert.match(PANEL_SYSTEM, /shell/);
});

test("the preamble says to wait for a slow command rather than poll it", () => {
  /*
    The pathology this is for: asked to build a Docker image in the
    background and report back, the model called `bash_output`, read
    "still running, 7 lines", and called it again — forty times. Each
    of those is a whole request that re-sends the conversation, and
    the transcript became forty rows that each said nothing.

    The tool exists now; this is the sentence that makes it get used.
  */
  assert.match(PANEL_SYSTEM, /bash_wait/);
  assert.match(PANEL_SYSTEM, /Never poll `bash_output` in a loop/);
});

test("the preamble is the panel's own", () => {
  // Sharing the window's would be a shared cache prefix: paying 1.25×
  // to write an entry that destroys one saving 10×.
  assert.match(PANEL_SYSTEM, /panel/);
  // Still the one thing only this surface knows, and still the reason
  // its turns are cheaper than the window's.
  assert.match(PANEL_SYSTEM, /given to you in the message/);
});

/* ─── Saving a setting without resetting the others ───────────────────────── */

test("changing one setting keeps every other one", () => {
  /*
    The bug this exists for: `agent_configure` writes what it is given,
    so sending `{models, active}` to switch model turned the tool router
    off — every time, silently, because `router` is a boolean and an
    absent boolean is false. Both surfaces have a model picker now, so
    both would have had it.
  */
  const status: AgentStatus = {
    hasKey: true,
    hasExaKey: true,
    router: true,
    hasRouterKey: true,
    routerModel: "jev-latest",
    routerPrice: 0.00004,
    active: "fast",
    model: "gpt-5.4-nano",
    models: [],
    budgetUsd: 2.5,
    path: "/tmp/figycode-agent.json",
  };

  const next = settingsFrom(status, { active: "slow" });
  assert.equal(next.active, "slow");
  assert.equal(next.router, true, "the picker stayed on");
  assert.equal(next.routerModel, "jev-latest");
  assert.equal(next.routerPrice, 0.00004);
  assert.equal(next.budgetUsd, 2.5, "the ceiling survived a model switch");
});

test("a null from the backend does not become a stored null", () => {
  // The backend sends `null` for "not set" and takes `undefined` for
  // "leave it"; writing the null back stores a router model of null.
  const next = settingsFrom({
    hasKey: false,
    hasExaKey: false,
    router: false,
    hasRouterKey: false,
    routerModel: null,
    routerPrice: null,
    active: null,
    model: "",
    models: [],
    path: "",
  });
  assert.equal(next.routerModel, undefined);
  assert.equal(next.routerPrice, undefined);
});

/* ─── The keys never ride along ───────────────────────────────────────────── */

test("no key is ever written back", () => {
  // They never come back from the backend, and an empty one means
  // "keep the stored one" — so a round trip must not carry a blank.
  const next = settingsFrom({
    hasKey: true,
    hasExaKey: true,
    router: false,
    hasRouterKey: false,
    active: null,
    model: "",
    models: [],
    path: "",
  });
  assert.ok(!("exaKey" in next), "the Exa key is not part of a save");
  assert.ok(!("routerKey" in next), "nor the router's");
});

process.exit(failures ? 1 : 0);
