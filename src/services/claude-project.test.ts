/**
 * The command line is the part that is silently wrong when it is wrong: a
 * mis-built argv doesn't throw, it starts a conversation against the wrong
 * folder or with a flag the CLI ignores.
 */

import assert from "node:assert/strict";
import {
  addDirCommand,
  alreadyCovered,
  claudeArgs,
  ClaudeProject,
  conversationTitle,
  lastSegment,
  projectName,
  ungrantedDirs,
} from "./claude-project";

function project(overrides: Partial<ClaudeProject> = {}): ClaudeProject {
  return {
    id: "p1",
    root: "/Users/me/GitHub/nexus-re",
    extraDirs: [],
    conversations: [],
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  };
}

// ─── Names ──────────────────────────────────────────────────────────────────

assert.equal(lastSegment("/Users/me/GitHub/nexus-re"), "nexus-re");
assert.equal(lastSegment("/Users/me/GitHub/nexus-re/"), "nexus-re", "trailing slash");
assert.equal(lastSegment("C:\\Users\\me\\api"), "api", "windows separators");
assert.equal(lastSegment("/"), "/", "the root is not nameless");
assert.equal(lastSegment("api"), "api", "a bare name is its own last segment");

assert.equal(projectName(project()), "nexus-re");
assert.equal(projectName(project({ root: "/" })), "/", "no project may be nameless");

// ─── Argv ───────────────────────────────────────────────────────────────────

assert.deepEqual(
  claudeArgs(project(), { sessionId: "abc-123" }),
  ["--session-id", "abc-123", "--name", "nexus-re"],
  "the minimum: an id and a name"
);

assert.deepEqual(
  claudeArgs(project({ extraDirs: ["/Users/me/design", "/Users/me/types"] }), {
    sessionId: "abc-123",
  }),
  [
    "--session-id",
    "abc-123",
    "--name",
    "nexus-re",
    "--add-dir",
    "/Users/me/design",
    "/Users/me/types",
  ],
  "--add-dir is variadic: one flag, every folder"
);

assert.deepEqual(
  claudeArgs(project(), { sessionId: "abc-123", resume: true }),
  ["--resume", "abc-123", "--name", "nexus-re"],
  "resuming replaces the id flag and keeps everything else"
);

assert.deepEqual(
  claudeArgs(project({ model: "opus", permissionMode: "plan" }), { sessionId: "abc-123" }),
  ["--session-id", "abc-123", "--name", "nexus-re", "--model", "opus", "--permission-mode", "plan"],
  "launch options when set"
);

{
  // The whole reason argv is a list: none of this is escaped, quoted or
  // rewritten, because none of it is ever handed to a shell.
  const hostile = "/Users/me/$(rm -rf ~)/a 'folder'";
  const args = claudeArgs(project({ root: hostile, extraDirs: [hostile] }), {
    sessionId: "abc-123",
  });
  assert.ok(args.includes(hostile), "a hostile path survives verbatim as one argument");
  assert.equal(projectName(project({ root: hostile })), "a 'folder'");
}

{
  // A trailing separator must not produce an empty argument, which `claude`
  // would read as the next flag's value.
  const args = claudeArgs(project({ extraDirs: ["/Users/me/design/"] }), {
    sessionId: "abc-123",
  });
  assert.ok(args.includes("/Users/me/design"), "trailing separators are trimmed");
  assert.ok(!args.includes(""), "no empty arguments");
}

// ─── Folders ────────────────────────────────────────────────────────────────

assert.equal(
  alreadyCovered(project(), "/Users/me/GitHub/nexus-re"),
  true,
  "the primary folder is already reachable"
);
assert.equal(
  alreadyCovered(project(), "/Users/me/GitHub/nexus-re/"),
  true,
  "and its trailing-slash spelling is the same folder"
);
assert.equal(
  alreadyCovered(project({ extraDirs: ["/Users/me/design"] }), "/Users/me/design"),
  true
);
assert.equal(alreadyCovered(project(), "/Users/me/other"), false);

assert.deepEqual(
  ungrantedDirs(project({ extraDirs: ["/a", "/b"] }), {
    launchedWith: { root: "/Users/me/GitHub/nexus-re", extraDirs: ["/a"] },
  }),
  ["/b"],
  "a folder added after this conversation started was never granted to it"
);

assert.deepEqual(
  ungrantedDirs(project({ extraDirs: ["/a"] }), {
    launchedWith: { root: "/Users/me/GitHub/nexus-re", extraDirs: ["/a/"] },
  }),
  [],
  "spelling differences are not missing grants"
);

assert.equal(addDirCommand("/Users/me/design/"), "/add-dir /Users/me/design\r");

// ─── Titles ─────────────────────────────────────────────────────────────────

const conversation = {
  sessionId: "abc",
  title: "",
  startedAt: 0,
  endedAt: null,
  launchedWith: { root: "/r", extraDirs: [] },
};
assert.equal(conversationTitle(conversation, 2), "Conversation 3", "ordinals are 1-based");
assert.equal(conversationTitle({ ...conversation, title: "fix the parser" }, 0), "fix the parser");
assert.equal(
  conversationTitle({ ...conversation, title: "   " }, 0),
  "Conversation 1",
  "a blank title is no title"
);

console.log("claude-project: ok");
