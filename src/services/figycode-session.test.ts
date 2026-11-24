/**
 * The transcript, as a function of the events that produced it.
 *
 * Worth testing because every case here is one that only happens against a
 * real model, at speed, once: text arriving in forty pieces, a tool row
 * created before its arguments exist, a refusal that must not look like a
 * crash, an interruption that must not look like an error. None of those
 * are reproducible by clicking.
 */

import assert from "node:assert/strict";
import type { TurnEvent } from "./figycode-agent";
import {
  answerOf,
  applyEvent,
  emptySession,
  NONE_OF_THESE,
  promptFor,
  pushUser,
  resumeSession,
  subjectOf,
  type SessionState,
} from "./figycode-session";

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

console.log("figycode-session");

/** Feeds a list of events to a fresh session. */
function play(...events: TurnEvent[]): SessionState {
  return events.reduce(applyEvent, emptySession());
}

/* ─── Text ─────────────────────────────────────────────────────────────────── */

test("streamed text becomes one paragraph, not forty blocks", () => {
  const state = play(
    { kind: "text", text: "I'll add " },
    { kind: "text", text: "the field " },
    { kind: "text", text: "and a test." }
  );
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].kind, "assistant");
  assert.equal(
    state.blocks[0].kind === "assistant" ? state.blocks[0].text : "",
    "I'll add the field and a test."
  );
});

test("text after a tool call starts a new paragraph", () => {
  // Otherwise the second half of the turn is glued onto the first.
  const state = play(
    { kind: "text", text: "Looking." },
    { kind: "toolStarted", id: "c1", name: "read" },
    { kind: "toolFinished", id: "c1", name: "read", text: "ok", detail: null, tokens: 1 },
    { kind: "text", text: "Found it." }
  );
  const assistants = state.blocks.filter((b) => b.kind === "assistant");
  assert.equal(assistants.length, 2);
});

/* ─── Tool rows ────────────────────────────────────────────────────────────── */

test("a tool row appears when the call starts, before its arguments exist", () => {
  const state = play({ kind: "toolStarted", id: "c1", name: "grep" });
  const block = state.blocks[0];
  assert.equal(block.kind, "tool");
  if (block.kind !== "tool") return;
  assert.equal(block.tool.running, true);
  assert.equal(block.tool.name, "Grep");
  assert.equal(block.tool.target, "");
  assert.equal(state.status, "Grep…");
});

test("the row is filled in when the call ends, not duplicated", () => {
  const state = play(
    { kind: "toolStarted", id: "c1", name: "edit" },
    {
      kind: "toolFinished",
      id: "c1",
      name: "edit",
      text: "Edited src/main.rs: 1 replacement at line 2, +1 -1",
      detail: { path: "src/main.rs", added: 1, removed: 1 },
      tokens: 12,
    }
  );
  assert.equal(state.blocks.length, 1);
  const block = state.blocks[0];
  if (block.kind !== "tool") throw new Error("expected a tool row");
  assert.equal(block.tool.running, false);
  assert.equal(block.tool.target, "src/main.rs");
  assert.equal(block.tool.added, 1);
  assert.match(block.tool.meta ?? "", /Edited src\/main.rs/);
});

test("only the first line of a result reaches the row", () => {
  // The whole result is already in the conversation and paid for there.
  const state = play(
    { kind: "toolStarted", id: "c1", name: "bash" },
    {
      kind: "toolFinished",
      id: "c1",
      name: "bash",
      text: "$ npm test\nexit 0 in 1800ms\n… forty more lines …",
      detail: { cmd: "npm test" },
      tokens: 400,
    }
  );
  const block = state.blocks[0];
  if (block.kind !== "tool") throw new Error("expected a tool row");
  assert.equal(block.tool.meta, "$ npm test");
  assert.equal(block.tool.target, "npm test");
});

test("a failure and a refusal are told apart", () => {
  // A refusal is the mode working. Rendering it like a crash would teach
  // people that plan mode is broken.
  const failed = play(
    { kind: "toolStarted", id: "c1", name: "edit" },
    { kind: "toolFailed", id: "c1", name: "edit", error: "edit: no such file" }
  ).blocks[0];
  const refused = play(
    { kind: "toolStarted", id: "c2", name: "edit" },
    { kind: "toolRefused", id: "c2", name: "edit", reason: "Plan mode: nothing is changed." }
  ).blocks[0];

  if (failed.kind !== "tool" || refused.kind !== "tool") throw new Error("expected tool rows");
  assert.equal(failed.tool.failed, true);
  assert.equal(refused.tool.failed, undefined);
  assert.equal(refused.tool.refused, true);
});

test("an event for a call that was never started is ignored", () => {
  // Out-of-order events must not invent a row with no verb on it.
  const state = play({
    kind: "toolFinished",
    id: "ghost",
    name: "read",
    text: "x",
    detail: null,
    tokens: 1,
  });
  assert.equal(state.blocks.length, 0);
});

test("two calls in one turn are kept apart by id", () => {
  const state = play(
    { kind: "toolStarted", id: "c1", name: "read" },
    { kind: "toolStarted", id: "c2", name: "grep" },
    { kind: "toolFinished", id: "c2", name: "grep", text: "7 matches", detail: null, tokens: 3 }
  );
  const [first, second] = state.blocks;
  if (first.kind !== "tool" || second.kind !== "tool") throw new Error("expected tool rows");
  assert.equal(first.tool.running, true, "the unfinished one is still running");
  assert.equal(second.tool.running, false);
});

test("the token meter moves while the text is still arriving", () => {
  // The provider's count arrives at the end of the turn; a meter wired
  // only to that reads zero for the whole time anybody is watching.
  const state = play({ kind: "text", text: "a".repeat(400) });
  assert.equal(state.streamed, 400);
  assert.equal(pushUser(state, "next").streamed, 0, "it resets per message");
});

/* ─── Cost ─────────────────────────────────────────────────────────────────── */

test("spend accumulates across the turns of one message", () => {
  const state = play(
    { kind: "turn", input: 1000, cached: 800, output: 20, costUsd: 0.001, hitRate: 80, contextPercent: 1 },
    { kind: "turn", input: 2000, cached: 1800, output: 30, costUsd: 0.002, hitRate: 90, contextPercent: 2 }
  );
  assert.ok(Math.abs(state.spent - 0.003) < 1e-9);
  assert.equal(state.usage?.hitRate, 90, "the bar shows the latest turn");
});

/* ─── Ending ───────────────────────────────────────────────────────────────── */

test("finishing stops the spinner and clears any question", () => {
  let state = pushUser(emptySession(), "do it");
  state = applyEvent(state, {
    kind: "needsApproval",
    id: "c1",
    name: "edit",
    arguments: { path: "a.rs", old: "x", new: "y" },
  });
  assert.ok(state.live);
  state = applyEvent(state, { kind: "finished", reason: "stop" });
  assert.equal(state.running, false);
  assert.equal(state.live, null);
});

test("the step limit says so in the transcript", () => {
  const state = play({ kind: "finished", reason: "step_limit" });
  const notice = state.blocks[0];
  if (notice.kind !== "notice") throw new Error("expected a notice");
  assert.match(notice.notice.title, /40 steps/);
  assert.equal(notice.notice.tone, "warn");
});

test("an interruption is quieter than a failure", () => {
  const stopped = play({ kind: "failed", error: "Interrupted" }).blocks[0];
  const broke = play({ kind: "failed", error: "Rate limited (429)" }).blocks[0];
  if (stopped.kind !== "notice" || broke.kind !== "notice") throw new Error("expected notices");
  assert.equal(stopped.notice.tone, "stop");
  assert.equal(broke.notice.tone, "error");
  assert.match(broke.notice.body, /429/);
});

test("a retry is a wait, not a notice per attempt", () => {
  const state = play(
    { kind: "text", text: "thinking" },
    {
      kind: "retrying",
      attempt: 2,
      total: 4,
      seconds: 8,
      reason: "Rate limited by the provider (429): slow down",
    }
  );
  assert.match(state.status, /trying again in 8s \(2 of 4\)/);
  assert.match(state.status, /Rate limited/);
  // Four attempts must not be four notices for one hiccup.
  assert.equal(state.blocks.filter((b) => b.kind === "notice").length, 0);
});

test("an interruption offers to be picked back up", () => {
  const stopped = play({ kind: "failed", error: "Interrupted" }).blocks[0];
  if (stopped.kind !== "notice") throw new Error("expected a notice");
  assert.deepEqual(
    stopped.notice.actions?.map((a) => a.label),
    ["Carry on"]
  );
});

test("compacting says what the pause is, and leaves a mark", () => {
  // A conversation quietly losing its middle is the sort of thing
  // somebody should be able to see happened.
  let state = play({ kind: "compacting" });
  assert.match(state.status, /Summarising/);

  state = applyEvent(state, { kind: "compacted", messages: 6 });
  const notice = state.blocks[0];
  if (notice.kind !== "notice") throw new Error("expected a notice");
  assert.match(notice.notice.title, /summarised/i);
  assert.equal(notice.notice.tone, "info");
});

test("how full the window is rides along with the cost", () => {
  const state = play({
    kind: "turn",
    input: 1000,
    cached: 0,
    output: 50,
    costUsd: 0.01,
    hitRate: 0,
    contextPercent: 42,
  });
  assert.equal(state.usage?.contextPercent, 42);
});

test("every block gets its own id", () => {
  const state = play(
    { kind: "text", text: "a" },
    { kind: "toolStarted", id: "c1", name: "read" },
    { kind: "failed", error: "Interrupted" }
  );
  const ids = state.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ─── Permission cards ─────────────────────────────────────────────────────── */

test("the proposal and the decision are separate things", () => {
  // They were one card. The diff and the controls for approving it became
  // one block of text, and a four-line edit produced something nobody
  // could take in at a glance.
  const live = promptFor("c1", "edit", { path: "Dockerfile", old: "a", new: "b" });
  assert.equal(live.prompt.title, "Edit Dockerfile", "the proposal's heading");
  assert.equal(live.prompt.question, "Make this edit to Dockerfile?", "the decision");
  assert.ok(live.prompt.diff, "the proposal carries what changes");
});

test("the question names the thing, not the tool", () => {
  assert.equal(
    promptFor("c", "delete", { path: "src/old.ts" }).prompt.question,
    "Move old.ts to the trash?"
  );
  assert.equal(promptFor("c", "bash", { cmd: "npm test" }).prompt.question, "Run this command?");
  assert.equal(
    promptFor("c", "bash", { cmd: "npm run dev", background: true }).prompt.question,
    "Start this in the background?"
  );
  assert.equal(
    promptFor("c", "search_web", { query: "tokio" }).prompt.question,
    "Search the web for “tokio”?"
  );
});

test("a command gets its command line and a two-word thing to remember", () => {
  const live = promptFor("c1", "bash", { cmd: "npm test -- --watch" });
  assert.equal(live.prompt.variant, "bash");
  assert.equal(live.prompt.command, "npm test -- --watch");
  assert.equal(live.rememberKey, "bash:npm test");
  assert.match(live.prompt.options[1].label, /npm test/);
});

test("an edit shows what is being replaced", () => {
  const live = promptFor("c1", "edit", {
    path: "src/main.rs",
    old: "let a = 1;",
    new: "let a = 2;",
  });
  assert.equal(live.prompt.variant, "edit");
  assert.deepEqual(
    live.prompt.diff?.map((line) => `${line.sign}${line.text}`),
    ["-let a = 1;", "+let a = 2;"]
  );
  // There is nothing specific to remember about one edit.
  assert.equal(live.rememberKey, null);
});

test("anything else is a plain question naming its subject", () => {
  const live = promptFor("c1", "fetch_url", { url: "https://example.com" });
  assert.equal(live.prompt.variant, "question");
  assert.equal(live.rememberKey, "fetch_url");
});

test("saying no is saying no, whichever card it is", () => {
  const live = promptFor("c1", "bash", { cmd: "rm -rf build" });
  const answer = answerOf(live, live.prompt.denyIndex);
  assert.equal(answer.allow, false);
  assert.equal(answer.remember, undefined);
});

test("the middle option is the only one that writes anything down", () => {
  const bash = promptFor("c1", "bash", { cmd: "npm test" });
  assert.equal(answerOf(bash, 0).remember, undefined, "yes-once remembers nothing");
  assert.equal(answerOf(bash, 1).remember, "bash:npm test");
});

test("allowing all edits is a mode change, not a memory", () => {
  // There is no useful key for "this edit"; what the option means is
  // acceptEdits, and that is what it does.
  const edit = promptFor("c1", "edit", { path: "a.rs", old: "x", new: "y" });
  const answer = answerOf(edit, 1);
  assert.equal(answer.acceptEdits, true);
  assert.equal(answer.remember, undefined);
});

/* ─── A question of the model's own ────────────────────────────────────────── */

test("a question the model asked is drawn as the card a permission uses", () => {
  const state = play({
    kind: "askingUser",
    id: "ask_1",
    question: "The field is used in two places. Rename both?",
    options: ["Rename both", "Leave the old one"],
  });
  const live = state.live;
  assert.ok(live);
  assert.equal(live.kind, "question", "it goes back by a different route to an approval");
  assert.equal(live.prompt.question, "The field is used in two places. Rename both?");
  assert.equal(live.rememberKey, null, "the next question is a different question");
});

test("a question always offers the answer the model did not think of", () => {
  // Otherwise the card is a trap: three options and no way to say none
  // of them, with Escape meaning nothing.
  const state = play({
    kind: "askingUser",
    id: "ask_1",
    question: "Which?",
    options: ["this", "that"],
  });
  const prompt = state.live!.prompt;
  assert.equal(prompt.options.length, 3);
  assert.equal(prompt.options[2].label, NONE_OF_THESE);
  assert.equal(prompt.denyIndex, 2, "so Escape picks it");
});

test("an empty option is dropped rather than drawn as a blank row", () => {
  const state = play({
    kind: "askingUser",
    id: "ask_1",
    question: "Which?",
    options: ["this", "   ", "that"],
  });
  assert.deepEqual(
    state.live!.prompt.options.map((option) => option.label),
    ["this", "that", NONE_OF_THESE]
  );
});

/* ─── The plan ─────────────────────────────────────────────────────────────── */

/** A `todo_write` round trip, as the backend emits it. */
function wrote(id: string, items: [string, string][]): TurnEvent[] {
  return [
    { kind: "toolStarted", id, name: "todo_write" },
    {
      kind: "toolFinished",
      id,
      name: "todo_write",
      text: "x",
      detail: { items: items.map(([text, status]) => ({ text, status })), done: 0 },
      tokens: 20,
    },
  ];
}

test("the plan is a block of its own, not a tool row", () => {
  const state = play(...wrote("t1", [["read the handler", "running"]]));
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].kind, "todos");
  assert.deepEqual(
    state.blocks[0].kind === "todos" ? state.blocks[0].items : [],
    [{ text: "read the handler", status: "running" }]
  );
});

test("a second plan replaces the first rather than stacking up", () => {
  // Ten copies of a list down the scroll bury the work between them, and
  // the question it answers is only ever about the latest.
  const state = play(
    ...wrote("t1", [["one", "running"], ["two", "pending"]]),
    { kind: "text", text: "Done with the first." },
    ...wrote("t2", [["one", "done"], ["two", "running"]])
  );
  const todos = state.blocks.filter((block) => block.kind === "todos");
  assert.equal(todos.length, 1);
  assert.equal(todos[0].kind === "todos" ? todos[0].items[0].status : "", "done");
  // And it lands at the end, where somebody scrolled to the bottom sees it.
  assert.equal(state.blocks[state.blocks.length - 1].kind, "todos");
});

test("a plan that could not be written keeps its row, in red", () => {
  // The only way an error here is visible at all: there is no list to
  // draw, so a silent no-op would be a tool that did nothing and said
  // nothing.
  const state = play(
    { kind: "toolStarted", id: "t1", name: "todo_write" },
    {
      kind: "toolFailed",
      id: "t1",
      name: "todo_write",
      error: "todo_write: only one item can be `running`.",
    }
  );
  assert.equal(state.blocks.length, 1);
  const block = state.blocks[0];
  assert.equal(block.kind, "tool");
  assert.equal(block.kind === "tool" ? block.tool.failed : false, true);
});

test("a plan is read back out of a resumed conversation's own text", () => {
  // `detail` is not stored, but this tool writes its list into the text
  // the model reads — so the list survives in the one copy that is kept.
  const state = resumeSession(
    [
      { role: "user", content: "fix the timeout", calls: [], answers: null },
      {
        role: "assistant",
        content: "",
        calls: [{ id: "a", name: "todo_write", arguments: {} }],
        answers: null,
      },
      { role: "tool", content: "0 of 2 done\n▸ find it\n○ fix it", calls: [], answers: "a" },
      {
        role: "assistant",
        content: "",
        calls: [{ id: "b", name: "todo_write", arguments: {} }],
        answers: null,
      },
      { role: "tool", content: "1 of 2 done\n✓ find it\n▸ fix it", calls: [], answers: "b" },
    ],
    0
  );

  const todos = state.blocks.filter((block) => block.kind === "todos");
  assert.equal(todos.length, 1, "the superseded copy is dropped, not drawn empty");
  assert.deepEqual(todos[0].kind === "todos" ? todos[0].items : [], [
    { text: "find it", status: "done" },
    { text: "fix it", status: "running" },
  ]);
});

/* ─── A conversation picked back up ────────────────────────────────────────── */

test("a resumed conversation redraws its tool rows with their results", () => {
  const state = resumeSession(
    [
      { role: "system", content: "You are a coding agent.", calls: [], answers: null },
      { role: "user", content: "what does main do?", calls: [], answers: null },
      {
        role: "assistant",
        content: "",
        calls: [{ id: "call_1", name: "read", arguments: { path: "src/main.rs" } }],
        answers: null,
      },
      {
        role: "tool",
        content: "src/main.rs · 1 line\nfn main() {}",
        calls: [],
        answers: "call_1",
      },
      { role: "assistant", content: "Nothing yet.", calls: [], answers: null },
    ],
    0.42
  );

  // The system prompt is not a block: it is not something anybody said.
  assert.equal(state.blocks.length, 3);
  assert.equal(state.blocks[0].kind, "user");
  const tool = state.blocks[1];
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") {
    assert.equal(tool.tool.name, "Read");
    assert.equal(tool.tool.target, "src/main.rs", "the path, from the stored arguments");
    assert.equal(tool.tool.meta, "src/main.rs · 1 line", "the result found its row");
    assert.deepEqual(tool.tool.output, ["fn main() {}"]);
    assert.equal(tool.tool.running, undefined, "nothing is running in a conversation from disk");
  }
  assert.equal(state.blocks[2].kind, "assistant");
  assert.equal(state.running, false);
  assert.equal(state.spent, 0.42, "the spend comes back, so a budget is per conversation");
});

test("a resumed transcript keeps its block ids unique", () => {
  // They are React keys. Two blocks sharing one is a row that updates the
  // wrong neighbour, which is the kind of bug nobody finds by reading.
  const state = resumeSession(
    [
      { role: "user", content: "one", calls: [], answers: null },
      {
        role: "assistant",
        content: "Looking.",
        calls: [
          { id: "a", name: "read", arguments: { path: "a.rs" } },
          { id: "b", name: "grep", arguments: { pattern: "fn main" } },
        ],
        answers: null,
      },
    ],
    0
  );
  const ids = state.blocks.map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(state.nextId > Math.max(...ids), "the next event cannot reuse one");
});

test("a result with no row to land on is dropped rather than throwing", () => {
  // A history cut mid-turn, or a call whose row was never written. The
  // transcript is missing a line; the window is not missing.
  const state = resumeSession(
    [
      { role: "user", content: "one", calls: [], answers: null },
      { role: "tool", content: "orphan", calls: [], answers: "nobody" },
    ],
    0
  );
  assert.equal(state.blocks.length, 1);
});

/* ─── Row subjects ─────────────────────────────────────────────────────────── */

test("the row shows the argument anybody is scanning for", () => {
  assert.equal(subjectOf("read", { path: "src/main.rs" }), "src/main.rs");
  assert.equal(subjectOf("grep", { pattern: "claimFront", glob: "*.ts" }), "claimFront");
  assert.equal(subjectOf("bash", { cmd: "npm test" }), "npm test");
  assert.equal(subjectOf("move", { from: "a.rs", to: "b.rs" }), "a.rs → b.rs");
});

test("a call with nothing worth showing shows nothing rather than guessing", () => {
  assert.equal(subjectOf("ls", {}), "");
});

test("what is about to leave the machine is named on the card", () => {
  // `net` tools are asked about every time, and the question is worthless
  // without the query or the address in it.
  assert.equal(subjectOf("search_web", { query: "tokio spawn_blocking" }), "tokio spawn_blocking");
  assert.equal(subjectOf("fetch_url", { url: "https://docs.rs/tokio" }), "https://docs.rs/tokio");
});

process.exit(failures ? 1 : 0);
