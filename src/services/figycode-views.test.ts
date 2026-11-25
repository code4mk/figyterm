/**
 * The content both surfaces show.
 *
 * This file exists because the FigyCode window and the editor panel
 * drifted. Each screen was written twice, reasonably, and the two
 * disagreed about things nobody would notice in a screenshot: which
 * number the context screen led with, how many parts there were and in
 * what order, whether the spend table had a total, whether a
 * conversation had "4 turns" or "4 messages".
 *
 * The components render from `figycode-views` now, so the facts cannot
 * differ. What a test can still add is the layer under that: that the
 * numbers are *right*, and that the handful of invariants the screens
 * depend on hold — the wire order, the estimate-against-measured
 * split, the spend total actually being the sum.
 */

import assert from "node:assert/strict";
import type { ContextBreakdown, Conversation, ToolInfo, Totals } from "./figycode-agent";
import { COMMANDS } from "./figycode-blocks";
import {
  COMMAND_SCREEN,
  CONTEXT_PARTS,
  cacheWord,
  contextView,
  conversationRow,
  schemaTokens,
  toolsView,
  screenFor,
  usageView,
  when,
} from "./figycode-views";

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

console.log("figycode-views");

/* ─── Every command the composer offers does something ───────────────────── */

test("every command in the popup opens something", () => {
  /*
    `/project` was in this list and handled on only one surface, so
    typing it in the editor panel completed from the popup and then
    answered "No command /project". A command list and a command
    handler written in two places drift the moment one gains an entry.
  */
  for (const command of COMMANDS) {
    assert.ok(
      screenFor(command.name) !== null,
      `${command.name} is offered in the composer and opens nothing`
    );
  }
});

test("the aliases nobody lists still work", () => {
  // Unlisted on purpose, and accepted because people try them.
  assert.equal(screenFor("/settings"), "settings");
  assert.equal(screenFor("/folder"), "project");
  assert.equal(screenFor("/folders"), "project");
});

test("something that is not a command is not a screen", () => {
  assert.equal(screenFor("/nope"), null);
});

test("clear is an action rather than a screen", () => {
  // The one entry that is not a thing to look at, which is why both
  // surfaces have to special-case it.
  assert.equal(COMMAND_SCREEN["/clear"], "clear");
});

/* ─── Fixtures ────────────────────────────────────────────────────────────── */

function breakdown(over: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    model: "gpt-5.4-nano",
    window: 128_000,
    measured: 12_400,
    system: 1_000,
    tools: 2_000,
    user: 500,
    assistant: 800,
    toolResults: 6_000,
    messages: 9,
    turns: 4,
    images: 0,
    imageTokens: 0,
    toolsOffered: 24,
    toolsTotal: 24,
    picker: null,
    heaviest: [],
    ...over,
  };
}

function totals(over: Partial<Totals> = {}): Totals {
  return {
    turns: 6,
    input: 40_000,
    cached: 32_000,
    output: 2_000,
    costUsd: 0.12,
    toolCostUsd: 0.03,
    hitRate: 80,
    largestToolResult: 3_100,
    ...over,
  };
}

function tool(name: string, cls: ToolInfo["class"], pad: number): ToolInfo {
  return {
    name,
    description: `What ${name} does.`,
    class: cls,
    schema: { name, filler: "x".repeat(pad) },
  };
}

/* ─── The order is the content ────────────────────────────────────────────── */

test("the parts are in the order they go on the wire", () => {
  /*
    Not sorted by size and not grouped by what you can do about it —
    both of which a surface invented for itself at some point. The
    order decides what a cache keeps: a part is invalidated by anything
    before it changing, so a list in any other order cannot be reasoned
    about.
  */
  assert.deepEqual(
    CONTEXT_PARTS.map((part) => part.key),
    ["tools", "system", "user", "assistant", "toolResults", "imageTokens"]
  );
  assert.deepEqual(
    contextView(breakdown()).parts.map((part) => part.key),
    ["tools", "system", "user", "assistant", "toolResults", "imageTokens"]
  );
});

test("every part has a label and a note, because both screens show both", () => {
  for (const part of contextView(breakdown()).parts) {
    assert.ok(part.label.length > 0, `${part.key} has no label`);
    assert.ok(part.note.length > 0, `${part.key} has no note`);
  }
});

/* ─── Estimated against measured ──────────────────────────────────────────── */

test("the estimate is the sum of the parts, and measured is kept apart", () => {
  // The panel led with `measured` and the window with the estimate, so
  // the same conversation had two different headline numbers.
  const view = contextView(breakdown());
  assert.equal(view.estimated, 1_000 + 2_000 + 500 + 800 + 6_000 + 0);
  assert.equal(view.measured, 12_400);
  assert.notEqual(view.estimated, view.measured, "they are different numbers on purpose");
});

test("the percentage is of the window, and absent without one", () => {
  assert.equal(contextView(breakdown({ window: 10_300 })).percent, 100);
  assert.equal(contextView(breakdown({ window: 20_600 })).percent, 50);
  assert.equal(contextView(breakdown({ window: null })).percent, null);
});

test("the free slice is on the same scale as the parts", () => {
  // Both surfaces used to compute this at the call site, slightly
  // differently, and agreed only because `free` is zero whenever the
  // window is unknown.
  const view = contextView(breakdown({ window: 20_600 }));
  assert.equal(view.freeShare, view.free / 20_600);
  assert.equal(contextView(breakdown({ window: null })).freeShare, 0);
});

test("free is what is left, and never negative", () => {
  assert.equal(contextView(breakdown({ window: 20_000 })).free, 9_700);
  // A window smaller than what is in it is a misconfigured price row,
  // not a negative bar.
  assert.equal(contextView(breakdown({ window: 1_000 })).free, 0);
});

test("the shares are of the window when there is one and of the parts when there is not", () => {
  // A bar with no scale is a bar that says nothing.
  const sized = contextView(breakdown({ window: 20_600 }));
  assert.equal(sized.parts.find((p) => p.key === "toolResults")?.share, 6_000 / 20_600);

  const unsized = contextView(breakdown({ window: null }));
  assert.equal(unsized.parts.find((p) => p.key === "toolResults")?.share, 6_000 / 10_300);
});

/* ─── The three lines of fact ─────────────────────────────────────────────── */

test("the facts say the message count, the tools offered and which number is exact", () => {
  // The panel was missing two of these entirely, because they were
  // three hand-written spans in the window rather than a list.
  const facts = contextView(breakdown()).facts;
  assert.equal(facts.length, 3);
  assert.match(facts[0], /9 messages · 4 from you · gpt-5\.4-nano/);
  assert.match(facts[1], /24 of 24 tools offered · no tool picker/);
  // `formatTokens` drops the decimal above 10k — see its own tests.
  assert.match(facts[2], /measured 12k/);
});

test("a picker that narrowed says so, here and nowhere else", () => {
  /*
    A router that cannot be reached offers everything and says nothing
    during the turn, which is right and makes "narrowed", "switched
    off" and "not running" identical from the transcript.
  */
  const facts = contextView(breakdown({ toolsOffered: 5, picker: "jev-latest" })).facts;
  assert.match(facts[1], /5 of 24 tools offered · picker: jev-latest/);
});

test("pictures are counted in the facts only when there are some", () => {
  assert.doesNotMatch(contextView(breakdown()).facts[0], /picture/);
  assert.match(contextView(breakdown({ images: 2, imageTokens: 2200 })).facts[0], /2 pictures/);
  assert.match(contextView(breakdown({ images: 1, imageTokens: 1100 })).facts[0], /1 picture/);
});

test("before the first turn the estimate is named as an estimate", () => {
  assert.match(contextView(breakdown({ measured: 0 })).facts[2], /until the first turn is measured/);
});

/* ─── Spend ───────────────────────────────────────────────────────────────── */

test("the total is the model plus the tools, and is the last row", () => {
  // The window's table had a total and the panel's did not, so the two
  // screens about one session added up differently.
  const view = usageView(totals());
  assert.equal(view.total, 0.15);
  assert.deepEqual(
    view.spend.map((one) => one.key),
    ["model", "tools", "total"]
  );
  assert.equal(view.spend[2].cost, view.spend[0].cost + view.spend[1].cost);
  assert.ok(view.spend[2].total, "the total row says it is the total");
});

test("the tools' cost is kept apart from the model's", () => {
  // Folding them together makes a search-heavy session read as an
  // expensive model, which sends somebody to change the wrong setting.
  const view = usageView(totals({ costUsd: 0.02, toolCostUsd: 0.4 }));
  assert.equal(view.spend[0].cost, 0.02);
  assert.equal(view.spend[1].cost, 0.4);
  assert.match(view.spend[1].note ?? "", /Exa/);
});

test("the flow is cached, fresh and written, and fresh is the remainder", () => {
  const view = usageView(totals());
  assert.deepEqual(
    view.flow.map((one) => one.label),
    ["Read from cache", "Sent fresh", "Written back"]
  );
  assert.equal(view.flow[1].tokens, 8_000, "input minus cached");
  // Shares are of input *and* output together, which is what the bar
  // is drawn against.
  assert.equal(view.flow[2].share, 2_000 / 42_000);
});

test("cached greater than input does not produce a negative slice", () => {
  // The provider has reported this. It is a rounding artefact and not
  // a reason to draw a bar backwards.
  assert.equal(usageView(totals({ input: 100, cached: 500 })).flow[1].tokens, 0);
});

test("the per-turn figure does not divide by zero", () => {
  assert.equal(usageView(totals({ turns: 0 })).perTurn, 0);
});

/* ─── The cache verdict ───────────────────────────────────────────────────── */

test("the verdict waits until there is a session to judge", () => {
  /*
    Two turns in, a low rate means the first turn had nothing to hit —
    which is how caching works rather than a problem.
  */
  assert.equal(usageView(totals({ turns: 2, hitRate: 10 })).verdict, null);
  assert.ok(usageView(totals({ turns: 3, hitRate: 10 })).verdict);
});

test("seventy per cent is the line, and the words agree with it", () => {
  assert.equal(usageView(totals({ hitRate: 70 })).healthy, true);
  assert.equal(usageView(totals({ hitRate: 69 })).healthy, false);
  assert.equal(cacheWord(totals({ hitRate: 80 })), "healthy");
  assert.equal(cacheWord(totals({ hitRate: 20, turns: 9 })), "too low");
  assert.equal(cacheWord(totals({ hitRate: 20, turns: 1 })), "early days");
});

test("the largest result is reported only when there is one", () => {
  assert.equal(usageView(totals({ largestToolResult: 0 })).largest, null);
  assert.equal(usageView(totals()).largest?.tokens, 3_100);
});

/* ─── Tools ───────────────────────────────────────────────────────────────── */

const TOOLS = [
  tool("read", "read", 10),
  tool("edit", "write", 300),
  tool("bash", "exec", 100),
  tool("grep", "read", 50),
];

test("tools are sorted by what their definition weighs", () => {
  // Alphabetical answers "is grep there"; by weight it answers "what
  // am I paying for", which is the question somebody opens this to ask.
  assert.deepEqual(
    toolsView(TOOLS, null).rows.map((row) => row.name),
    ["edit", "bash", "grep", "read"]
  );
});

test("the total is the sum and the average divides by the count", () => {
  const view = toolsView(TOOLS, null);
  const sum = TOOLS.reduce((total, one) => total + schemaTokens(one.schema), 0);
  assert.equal(view.total, sum);
  assert.equal(view.count, 4);
  assert.equal(view.average, sum / 4);
});

test("an empty registry divides by nothing", () => {
  const view = toolsView([], null);
  assert.equal(view.average, 0);
  assert.equal(view.count, 0);
});

test("the classes are counted and ordered by how loudly they ask", () => {
  assert.deepEqual(toolsView(TOOLS, null).classes, [
    { cls: "read", n: 2 },
    { cls: "write", n: 1 },
    { cls: "exec", n: 1 },
  ]);
});

test("tool tokens are counted the same way the context estimate is", () => {
  // A tools total counted differently from the `tools` row in
  // /context would be two answers to one question.
  assert.equal(schemaTokens({ a: 1 }), JSON.stringify({ a: 1 }).length / 4);
});

test("the picker is reported only when it actually narrowed", () => {
  assert.equal(toolsView(TOOLS, null).offered, null, "no breakdown, nothing to say");
  assert.equal(
    toolsView(TOOLS, breakdown({ toolsOffered: 4, picker: "jev-latest" })).offered,
    null,
    "offering all four is not narrowing"
  );
  assert.deepEqual(toolsView(TOOLS, breakdown({ toolsOffered: 2, picker: "jev-latest" })).offered, {
    count: 2,
    by: "jev-latest",
  });
});

test("every row carries the description, because one screen shows it", () => {
  for (const row of toolsView(TOOLS, null).rows) {
    assert.ok(row.description.length > 0, `${row.name} lost its description`);
  }
});

/* ─── A conversation, as both lists show it ───────────────────────────────── */

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    sessionId: "s1",
    title: "Why does the router panic",
    turns: 4,
    spentUsd: 0.0132,
    updatedAt: Date.now() - 5 * 60_000,
    ...over,
  } as Conversation;
}

test("a conversation's turns are called messages on both screens", () => {
  // The window said "4 messages" and the panel said "4 turns", about
  // the same number.
  const row = conversationRow(conversation());
  assert.match(row.meta, /^4 messages · /);
  assert.match(conversationRow(conversation({ turns: 1 })).meta, /^1 message · /);
});

test("the meta line carries the cost and the time, which the panel had no way to show", () => {
  // `when` was local to the window's dialog, so the panel's list had
  // no time on it at all.
  const row = conversationRow(conversation());
  // Two decimals above a cent, as `formatCost` has always done.
  assert.match(row.meta, /\$0\.01/);
  assert.match(row.meta, /5m ago/);
});

test("an untitled conversation is named rather than blank", () => {
  assert.equal(conversationRow(conversation({ title: "" })).title, "Untitled");
});

test("how long ago reads in the units somebody would say", () => {
  const now = Date.now();
  assert.equal(when(now), "just now");
  assert.equal(when(now - 30 * 60_000), "30m ago");
  assert.equal(when(now - 4 * 3600_000), "4h ago");
  assert.equal(when(now - 24 * 3600_000), "yesterday");
  // A clock that is ahead is not a negative duration.
  assert.equal(when(now + 60_000), "just now");
});

process.exit(failures ? 1 : 0);
