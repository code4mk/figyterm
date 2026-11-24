/**
 * The invented world behind the Figy Code window.
 *
 * There is no agent yet — `docs/CODE-AGENT.md` is still a proposal — and the
 * window is being designed before the thing it talks to exists. So everything
 * here is a fiction: a repository that is never read, tools that are never
 * run, and a handful of scripted runs that play back on a timer and pause
 * where a real agent would stop to ask.
 *
 * It is kept in one file, apart from the components, for two reasons. The
 * first is that swapping it for the real core should be a change of import and
 * not a hunt through the markup. The second is that the only decisions worth
 * testing — which command the slash popup should offer, which script a prompt
 * should play, what "2.1k tokens" rounds from — are pure, and they are here.
 *
 * Nothing in this file touches Tauri, the filesystem or the clock beyond
 * arithmetic on numbers it is handed.
 */

/** Who the start screen greets. Invented, like the rest of it. */
export const USER = "Mostafa";

/* ─── The repository, as the window believes it ───────────────────────────── */

/*
  There is no project list here any more.

  There was — three invented repositories with invented branches — and it was
  the one fiction that got in the way, because the folder is the single thing
  about this window a person can check against the shell behind it. Projects
  are real paths now, in `figycode-projects.ts`; what is left in this file is
  only what the absent agent would have said.
*/

/* ─── Models ──────────────────────────────────────────────────────────────── */

export interface DemoModel {
  id: string;
  name: string;
  /** The name the status bar uses, which is the id people say out loud. */
  short: string;
  note: string;
  badge?: string;
}

export const MODELS: DemoModel[] = [
  { id: "figy-pro", name: "Figy Pro", short: "figy-pro", note: "best for most coding", badge: "default" },
  { id: "figy-fast", name: "Figy Fast", short: "figy-fast", note: "quick edits and questions" },
  { id: "figy-max", name: "Figy Max", short: "figy-max", note: "hardest problems · uses more of your limit" },
];

/* ─── Slash commands ──────────────────────────────────────────────────────── */

export interface DemoCommand {
  name: string;
  summary: string;
}

/**
 * The six from the design, plus `/errors`.
 *
 * `/errors` is the one command here that is not pretending to be a feature: it
 * prints the inline problem styles — interrupted, retry, context, limit,
 * failed — as a gallery, because they are the hardest states to reach on
 * purpose and a design that cannot be looked at cannot be reviewed. It goes
 * when the real agent arrives.
 */
export const COMMANDS: DemoCommand[] = [
  { name: "/review", summary: "review the working tree like a PR" },
  { name: "/rewind", summary: "jump back to any checkpoint" },
  { name: "/model", summary: "switch model · figy-pro, figy-fast" },
  { name: "/permissions", summary: "manual, acceptEdits, auto, plan…" },
  { name: "/harness", summary: "move this session to Figy Harness" },
  { name: "/init", summary: "write a FIGY.md rules file for this repo" },
  { name: "/compact", summary: "summarise the older turns right now" },
  { name: "/errors", summary: "preview how problems are reported inline" },
];

/*
  There is no file list here either.

  `@` reads the real folder now — `figycode-files.ts` over an index the Rust
  side keeps — so the invented one went the way of the invented projects. The
  only piece of mention handling left in this file is `mentionAt` at the
  bottom, which is about where the caret is and not about what exists.
*/

/* ─── Checkpoints, for /rewind ────────────────────────────────────────────── */

export const CHECKPOINTS: { label: string; detail: string }[] = [
  { label: "now", detail: "current state" },
  { label: '"update the old test to match"', detail: "2 min ago · 1 file" },
  { label: '"add tests"', detail: "6 min ago · 1 file" },
  { label: '"add a model field to Conversation…"', detail: "12 min ago · 1 file" },
  { label: "session start", detail: "14 min ago · clean" },
];

/* ─── Permission modes ────────────────────────────────────────────────────── */

/**
 * What shift+tab cycles through.
 *
 * Three states rather than a checkbox because the middle one is the whole
 * point: an agent you have decided to trust for the next ten minutes should
 * not ask eleven times, and one you have not should not be able to write
 * anything at all.
 */
export type PermissionMode = "ask" | "accept" | "plan";

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "ask before edits",
  accept: "accept edits on",
  plan: "plan mode on",
};

/** What the footer says after the mode, when the mode is worth explaining. */
export const MODE_NOTE: Record<PermissionMode, string> = {
  ask: "shift+tab to cycle",
  accept: "shift+tab to cycle",
  plan: "nothing will be changed · shift+tab to cycle",
};

export function cycleMode(mode: PermissionMode): PermissionMode {
  return mode === "ask" ? "accept" : mode === "accept" ? "plan" : "ask";
}

/* ─── The pieces a transcript is made of ──────────────────────────────────── */

/** A line in a rendered hunk. `…` is the gap between two of them. */
export interface DiffLine {
  no: number | null;
  sign: "+" | "-" | " " | "…";
  text: string;
}

export type ToolKind = "read" | "search" | "edit" | "write" | "bash";

export interface ToolRow {
  kind: ToolKind;
  /** `Read`, `Edit`, `Bash` — the verb, as the agent would name the call. */
  name: string;
  /** The path, pattern or command the verb applies to. */
  target: string;
  /** Anything else worth one glance: `3 tests`, `1.8s · 44 passed, 1 failed`. */
  meta?: string;
  added?: number;
  removed?: number;
  diff?: DiffLine[];
  /** Captured output, for a command. */
  output?: string[];
  /** Whether the body starts open. A diff usually does; a test log does not. */
  open?: boolean;
}

export interface TodoItem {
  text: string;
  state: "done" | "doing" | "todo";
}

export type NoticeTone = "stop" | "warn" | "info" | "error";

export interface NoticeAction {
  label: string;
  primary?: boolean;
}

export interface Notice {
  tone: NoticeTone;
  title: string;
  body: string;
  actions?: NoticeAction[];
}

export interface PromptOption {
  label: string;
  /** The quiet half of the line: `recommended · already a dependency`. */
  hint?: string;
  /** A chord that picks this option without arrowing to it. */
  chord?: string;
}

/**
 * A question the run has stopped on.
 *
 * One shape for all four kinds in the design — a file edit, a command, a
 * question of the agent's own, and the end of plan mode — because they are the
 * same interaction every time: a card saying what is about to happen, a short
 * numbered list, and a keyboard line under it. Only the top of the card
 * differs, which is what `variant` chooses.
 */
export interface Prompt {
  variant: "edit" | "bash" | "question" | "plan";
  title: string;
  /** `1 of 3 files`, `question 1 of 1`. */
  subtitle?: string;
  /** For `bash`: the command, shown as a shell line. */
  command?: string;
  /** For `bash`: what it will touch, in one muted line. */
  facts?: string;
  diff?: DiffLine[];
  options: PromptOption[];
  footer: string;
  /** Which option means no, so Escape can pick it. */
  denyIndex: number;
}

/** Everything that can appear in the scroll. */
export type Block =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; tool: ToolRow }
  | { id: number; kind: "plan"; steps: string[]; note: string }
  | { id: number; kind: "todos"; items: TodoItem[]; hidden?: boolean }
  | { id: number; kind: "shell"; command: string; output: string[]; note: string }
  | {
      id: number;
      kind: "summary";
      headline: string;
      stats: string;
      detail: string;
      files: string[];
    }
  | { id: number; kind: "notice"; notice: Notice }
  | { id: number; kind: "actions"; chips: { label: string; primary?: boolean }[] }
  | { id: number; kind: "prompt"; prompt: Prompt; answer?: string };

/* ─── Scripts ─────────────────────────────────────────────────────────────── */

/**
 * One beat of a scripted run.
 *
 * `wait` is how long the window should sit on the *previous* beat before this
 * one lands — the thing that makes a transcript feel like it is being produced
 * rather than pasted. `ask` suspends the run until an answer comes back, and
 * carries the two continuations with it, so a script is a tree without needing
 * a second data structure for the branches.
 */
export type Step =
  | { t: "say"; text: string; wait?: number }
  | { t: "status"; label: string; wait?: number }
  | { t: "tool"; tool: ToolRow; wait?: number }
  | { t: "plan"; steps: string[]; note: string; wait?: number }
  | { t: "todos"; items: TodoItem[]; wait?: number }
  | { t: "notice"; notice: Notice; wait?: number }
  | {
      t: "summary";
      headline: string;
      stats: string;
      detail: string;
      files: string[];
      wait?: number;
    }
  | { t: "actions"; chips: { label: string; primary?: boolean }[]; wait?: number }
  | { t: "background"; label: string | null; wait?: number }
  | { t: "ask"; prompt: Prompt; wait?: number; accept?: Step[]; deny?: Step[] };

export interface Script {
  id: string;
  /** What a prompt has to mention for this run to be the one that plays. */
  match: RegExp;
  steps: Step[];
}

const KEEP_GOING: Step[] = [
  { t: "say", text: "Alright — tell me what you'd like instead.", wait: 400 },
];

/* The run from the conversation screen: a small feature, carried to tests. */
const MODEL_FIELD: Script = {
  id: "model-field",
  match: /\bmodel\b|--model|conversation/i,
  steps: [
    { t: "status", label: "Reading the files…" },
    {
      t: "say",
      wait: 700,
      text:
        "I'll add an optional **model** to Conversation, emit it in buildArgs(), " +
        "then cover it with tests.",
    },
    {
      t: "tool",
      wait: 900,
      tool: {
        kind: "read",
        name: "Read",
        target: "claude-project.ts · claude-project.test.ts",
      },
    },
    { t: "status", label: "Adding the field…" },
    {
      t: "tool",
      wait: 1500,
      tool: {
        kind: "edit",
        name: "Edit",
        target: "src/services/claude-project.ts",
        added: 3,
        removed: 0,
        open: true,
        diff: [
          { no: 34, sign: " ", text: "  sessionId: string;" },
          { no: 35, sign: "+", text: "  /** Model alias passed as `--model`. */" },
          { no: 36, sign: "+", text: "  model?: string;" },
          { no: null, sign: "…", text: "" },
          { no: 44, sign: "+", text: '  if (c.model) args.push("--model", c.model);' },
        ],
      },
    },
    { t: "status", label: "Writing the tests…" },
    {
      t: "tool",
      wait: 1600,
      tool: {
        kind: "write",
        name: "Write",
        target: "src/services/claude-project.test.ts",
        added: 24,
        meta: "3 tests",
      },
    },
    { t: "status", label: "Running the tests…" },
    {
      t: "tool",
      wait: 1800,
      tool: {
        kind: "bash",
        name: "Bash",
        target: "npm test",
        meta: "1.8s · 44 passed, 1 failed",
        output: [
          "  ok  a trailing space opens a new, empty token",
          "  ok  model is omitted when unset",
          "  FAIL  buildArgs puts --model after the prompt",
          "        expected [--model, figy-pro, -p] to equal [-p, --model, figy-pro]",
        ],
      },
    },
    {
      t: "say",
      wait: 800,
      text:
        "One old test checks argument order. The CLI accepts both orders, so I'll " +
        "update the test rather than the code.",
    },
    { t: "status", label: "Updating the test…" },
    {
      t: "tool",
      wait: 1700,
      tool: {
        kind: "edit",
        name: "Edit",
        target: "src/services/claude-project.test.ts",
        added: 2,
        removed: 2,
      },
    },
    {
      t: "say",
      wait: 700,
      text:
        "Done. **Conversation.model** is optional and only emitted when set, so " +
        "existing sessions launch exactly as before.",
    },
    {
      t: "summary",
      wait: 400,
      headline: "2 files changed",
      stats: "+27 -0",
      detail: "tests passing · 2m 41s · 9 tool calls",
      files: ["M src/services/claude-project.ts", "M src/services/claude-project.test.ts"],
    },
    {
      t: "actions",
      wait: 300,
      chips: [
        { label: "commit these changes", primary: true },
        { label: "/review" },
        { label: "open a PR" },
        { label: "/rewind" },
      ],
    },
  ],
};

/* A rename: the edit permission, and the retry when the file moved underneath. */
const RENAME: Script = {
  id: "rename",
  match: /\brename\b|\beverywhere\b/i,
  steps: [
    { t: "status", label: "Searching…" },
    {
      t: "tool",
      wait: 900,
      tool: {
        kind: "search",
        name: "Search",
        target: '"projectName"',
        meta: "4 matches in 3 files",
      },
    },
    {
      t: "ask",
      wait: 700,
      prompt: {
        variant: "edit",
        title: "Edit src/services/claude-project.ts",
        subtitle: "1 of 3 files",
        diff: [
          { no: 50, sign: " ", text: "/** The derived name: whatever the primary folder is called. */" },
          { no: 51, sign: "-", text: "export function projectName(folders: string[]): string {" },
          { no: 51, sign: "+", text: "export function deriveProjectName(folders: string[]): string {" },
        ],
        options: [
          { label: "Yes" },
          { label: "Yes, allow all edits this session", chord: "shift+tab" },
          { label: "No, tell FigyCode what to change", chord: "esc" },
        ],
        footer: "↑↓ select · ↵ confirm · ctrl+e open in editor",
        denyIndex: 2,
      },
      deny: KEEP_GOING,
      accept: [
        { t: "status", label: "Renaming…" },
        {
          t: "tool",
          wait: 1200,
          tool: {
            kind: "edit",
            name: "Edit",
            target: "src/services/claude-project.ts",
            added: 1,
            removed: 1,
          },
        },
        {
          t: "notice",
          wait: 1100,
          notice: {
            tone: "warn",
            title: "Edit didn't apply — the file changed on disk",
            body: "FigyCode re-read claude-project.ts and retried. Your changes were kept.",
            actions: [{ label: "show both" }],
          },
        },
        {
          t: "tool",
          wait: 1200,
          tool: {
            kind: "edit",
            name: "Edit",
            target: "src/components/Claude/ClaudeModal.tsx",
            added: 2,
            removed: 2,
          },
        },
        {
          t: "tool",
          wait: 1000,
          tool: {
            kind: "edit",
            name: "Edit",
            target: "src/services/claude-session.ts",
            added: 1,
            removed: 1,
          },
        },
        {
          t: "say",
          wait: 700,
          text: "Renamed in 3 files. The old name is gone — **grep finds nothing**.",
        },
        {
          t: "summary",
          wait: 300,
          headline: "3 files changed",
          stats: "+4 -4",
          detail: "tests passing · 48s · 6 tool calls",
          files: [
            "M src/services/claude-project.ts",
            "M src/services/claude-session.ts",
            "M src/components/Claude/ClaudeModal.tsx",
          ],
        },
        {
          t: "actions",
          wait: 250,
          chips: [{ label: "commit these changes", primary: true }, { label: "/review" }, { label: "/rewind" }],
        },
      ],
    },
  ],
};

/* A build: the command permission, and a command that fails. */
const BUILD: Script = {
  id: "build",
  match: /\bbuild\b|\bcompile\b|\bbundle\b|\bwarnings?\b/i,
  steps: [
    { t: "say", wait: 600, text: "I'll build a universal bundle first so we see every warning." },
    {
      t: "ask",
      wait: 500,
      prompt: {
        variant: "bash",
        title: "Bash command",
        command: "npm run tauri build -- --target universal-apple-darwin",
        facts: "writes to src-tauri/target · network: crates.io · about 3 min",
        options: [
          { label: "Yes" },
          { label: "Yes, and don't ask again for npm run tauri build here" },
          { label: "No, and tell FigyCode what to do instead", chord: "esc" },
        ],
        footer: "↑↓ select · ↵ confirm · esc to say no",
        denyIndex: 2,
      },
      deny: KEEP_GOING,
      accept: [
        { t: "status", label: "Building…" },
        { t: "background", label: "npm run tauri build" },
        {
          t: "tool",
          wait: 2200,
          tool: {
            kind: "bash",
            name: "Bash",
            target: "npm run tauri build",
            meta: "1m 12s · exit 101",
            open: true,
            output: [
              "   Compiling figyterm v0.1.0 (/Users/you/GitHub/fig-alternative/src-tauri)",
              "warning: unused variable: `window`",
              "   --> src/menu.rs:142:9",
              "error[E0277]: `?` couldn't convert the error to `tauri::Error`",
              "   --> src/agent/mod.rs:88:34",
            ],
          },
        },
        { t: "background", label: null },
        {
          t: "notice",
          wait: 500,
          notice: {
            tone: "error",
            title: "Command failed: cargo build (exit 101)",
            body: "FigyCode is reading the error and will try a fix.",
            actions: [{ label: "stop" }],
          },
        },
        { t: "status", label: "Reading the error…" },
        {
          t: "tool",
          wait: 1300,
          tool: { kind: "read", name: "Read", target: "src-tauri/src/agent/mod.rs", meta: "lines 60–120" },
        },
        {
          t: "tool",
          wait: 1400,
          tool: {
            kind: "edit",
            name: "Edit",
            target: "src-tauri/src/agent/mod.rs",
            added: 2,
            removed: 1,
            open: true,
            diff: [
              { no: 86, sign: " ", text: "  let key = keychain::get(\"openrouter\")" },
              { no: 87, sign: "-", text: "      .map_err(|e| e)?;" },
              { no: 87, sign: "+", text: "      .map_err(|e| tauri::Error::Anyhow(e.into()))?;" },
            ],
          },
        },
        {
          t: "say",
          wait: 800,
          text: "That was the only error. The unused-variable warning in menu.rs is next if you want it.",
        },
        {
          t: "summary",
          wait: 300,
          headline: "1 file changed",
          stats: "+2 -1",
          detail: "build passing · 3m 06s · 5 tool calls",
          files: ["M src-tauri/src/agent/mod.rs"],
        },
        {
          t: "actions",
          wait: 250,
          chips: [{ label: "fix the warning too", primary: true }, { label: "/review" }, { label: "/rewind" }],
        },
      ],
    },
  ],
};

/* A plan, and the question at the end of one. */
const THEME: Script = {
  id: "theme",
  match: /\btheme\b|\blight\b|\bdark\b|\bappearance\b/i,
  steps: [
    { t: "say", wait: 600, text: "Here's my plan. Nothing has been changed yet." },
    {
      t: "plan",
      wait: 500,
      note: "~9 files · no new dependencies",
      steps: [
        "add a **theme** key to settings in claude-session.ts (persisted)",
        "new ThemeProvider reads it and the OS setting",
        "radio group in Settings › Appearance",
        "swap hard-coded colours in 6 components for CSS variables",
        "tests for the follow-system fallback",
      ],
    },
    {
      t: "ask",
      wait: 600,
      prompt: {
        variant: "plan",
        title: "Ready to code?",
        options: [
          { label: "Yes, and auto-accept edits" },
          { label: "Yes, and ask before each edit" },
          { label: "No, keep planning" },
        ],
        footer: "↑↓ select · ↵ confirm · or type feedback to revise the plan",
        denyIndex: 2,
      },
      deny: [
        {
          t: "say",
          wait: 400,
          text: "Still planning. Tell me what to change and I'll redraw it.",
        },
      ],
      accept: [
        { t: "status", label: "Starting on the settings key…" },
        {
          t: "todos",
          wait: 600,
          items: [
            { text: "add the theme key to settings", state: "doing" },
            { text: "ThemeProvider reads it and the OS setting", state: "todo" },
            { text: "radio group in Settings › Appearance", state: "todo" },
            { text: "swap hard-coded colours", state: "todo" },
            { text: "tests for the follow-system fallback", state: "todo" },
          ],
        },
        {
          t: "tool",
          wait: 1400,
          tool: {
            kind: "edit",
            name: "Edit",
            target: "src/services/claude-session.ts",
            added: 6,
          },
        },
        {
          t: "todos",
          wait: 900,
          items: [
            { text: "add the theme key to settings", state: "done" },
            { text: "ThemeProvider reads it and the OS setting", state: "doing" },
            { text: "radio group in Settings › Appearance", state: "todo" },
            { text: "swap hard-coded colours", state: "todo" },
            { text: "tests for the follow-system fallback", state: "todo" },
          ],
        },
        {
          t: "tool",
          wait: 1500,
          tool: { kind: "write", name: "Write", target: "src/components/ThemeProvider.tsx", added: 41 },
        },
        {
          t: "say",
          wait: 800,
          text: "Two of five done. Carrying on with the Settings panel.",
        },
      ],
    },
  ],
};

/* The agent's own question, from the "where should this live" screen. */
const PERSIST: Script = {
  id: "persist",
  match: /\bremember\b|\bpersist\b|\bbetween launches\b|\bstore\b/i,
  steps: [
    { t: "status", label: "Reading the files…" },
    {
      t: "tool",
      wait: 900,
      tool: { kind: "read", name: "Read", target: "claude-session.ts · tauri.conf.json" },
    },
    {
      t: "ask",
      wait: 800,
      prompt: {
        variant: "question",
        title: "Where should the theme be saved?",
        subtitle: "question 1 of 1",
        options: [
          { label: "Tauri store plugin", hint: "recommended · already a dependency" },
          { label: "localStorage", hint: "simplest · webview only" },
          { label: "settings.json next to sessions", hint: "readable by the CLI" },
          { label: "Something else…" },
        ],
        footer: "↑↓ select · ↵ confirm · 4 to type your own",
        denyIndex: 3,
      },
      deny: [{ t: "say", wait: 400, text: "Go on — where would you like it?" }],
      accept: [
        { t: "status", label: "Wiring the store…" },
        {
          t: "tool",
          wait: 1300,
          tool: { kind: "edit", name: "Edit", target: "src/services/claude-session.ts", added: 9, removed: 2 },
        },
        {
          t: "tool",
          wait: 1200,
          tool: { kind: "bash", name: "Bash", target: "npm test", meta: "2.1s · 47 passed" },
        },
        {
          t: "say",
          wait: 700,
          text: "Saved through the store plugin, so the CLI and the app read the same value.",
        },
        {
          t: "summary",
          wait: 300,
          headline: "1 file changed",
          stats: "+9 -2",
          detail: "tests passing · 1m 04s · 4 tool calls",
          files: ["M src/services/claude-session.ts"],
        },
      ],
    },
  ],
};

/* To-dos and a background task, from that screen. */
const STASH: Script = {
  id: "stash",
  match: /\bstash\b|\bgit panel\b|\bto-?dos?\b/i,
  steps: [
    { t: "background", label: "npm run dev" },
    {
      t: "todos",
      wait: 500,
      items: [
        { text: "read GitPanel.tsx and git.ts", state: "done" },
        { text: "add stashList() to git.ts", state: "done" },
        { text: "wire the stash list into GitPanel", state: "doing" },
        { text: "tests for stashList()", state: "todo" },
        { text: "run npm test", state: "todo" },
      ],
    },
    {
      t: "tool",
      wait: 1200,
      tool: { kind: "edit", name: "Edit", target: "src/services/git.ts", added: 18 },
    },
    { t: "status", label: "Wiring the stash list…" },
    {
      t: "tool",
      wait: 1600,
      tool: { kind: "edit", name: "Edit", target: "src/components/GitPanel.tsx", added: 22, removed: 3 },
    },
    {
      t: "todos",
      wait: 900,
      items: [
        { text: "read GitPanel.tsx and git.ts", state: "done" },
        { text: "add stashList() to git.ts", state: "done" },
        { text: "wire the stash list into GitPanel", state: "done" },
        { text: "tests for stashList()", state: "doing" },
        { text: "run npm test", state: "todo" },
      ],
    },
    {
      t: "tool",
      wait: 1500,
      tool: { kind: "write", name: "Write", target: "src/services/git.test.ts", added: 31, meta: "4 tests" },
    },
    {
      t: "tool",
      wait: 1400,
      tool: { kind: "bash", name: "Bash", target: "npm test", meta: "2.4s · 48 passed" },
    },
    { t: "background", label: null },
    {
      t: "summary",
      wait: 400,
      headline: "3 files changed",
      stats: "+71 -3",
      detail: "tests passing · 4m 12s · 11 tool calls",
      files: [
        "M src/services/git.ts",
        "M src/components/GitPanel.tsx",
        "A src/services/git.test.ts",
      ],
    },
  ],
};

/* Anything else. Short, and honest that it is reading before it answers. */
const GENERIC: Script = {
  id: "generic",
  match: /.*/,
  steps: [
    { t: "status", label: "Looking around the repo…" },
    {
      t: "tool",
      wait: 900,
      tool: { kind: "search", name: "Search", target: "the words in your message", meta: "7 matches in 4 files" },
    },
    {
      t: "tool",
      wait: 1100,
      tool: { kind: "read", name: "Read", target: "src/services/claude-project.ts", meta: "lines 1–200" },
    },
    { t: "status", label: "Working…" },
    {
      t: "say",
      wait: 1300,
      text:
        "Here's what I found, and what I'd change. This window is a **design " +
        "prototype** — the transcript is scripted, so the next turn is invented " +
        "rather than reasoned.",
    },
    {
      t: "tool",
      wait: 900,
      tool: {
        kind: "edit",
        name: "Edit",
        target: "src/services/claude-project.ts",
        added: 4,
        removed: 1,
        open: true,
        diff: [
          { no: 118, sign: " ", text: "export function buildArgs(c: Conversation): string[] {" },
          { no: 119, sign: "-", text: "  const args = [\"-p\"];" },
          { no: 119, sign: "+", text: "  const args: string[] = [];" },
          { no: 120, sign: "+", text: "  if (c.resume) args.push(\"--resume\", c.resume);" },
          { no: 121, sign: "+", text: "  args.push(\"-p\");" },
        ],
      },
    },
    {
      t: "summary",
      wait: 500,
      headline: "1 file changed",
      stats: "+4 -1",
      detail: "tests passing · 52s · 4 tool calls",
      files: ["M src/services/claude-project.ts"],
    },
  ],
};

/**
 * In order, because the first match wins and the specific ones have to go
 * before `GENERIC`, whose pattern matches everything by design.
 */
export const SCRIPTS: Script[] = [RENAME, BUILD, THEME, PERSIST, STASH, MODEL_FIELD, GENERIC];

export function pickScript(prompt: string): Script {
  return SCRIPTS.find((script) => script.match.test(prompt)) ?? GENERIC;
}

/**
 * The same run, in plan mode.
 *
 * Plan mode is not a different task, it is the same task with a stop before
 * the first write — so this reads the run's own steps, says out loud what
 * they are about to do, and hangs the whole thing off one question. A script
 * that already plans for itself is left alone.
 *
 * It is written from the steps rather than from a second copy of each script
 * because a plan that disagrees with what then happens is worse than no plan.
 */
export function planFor(steps: Step[]): Step[] {
  if (steps.some((s) => s.t === "plan")) return steps;

  const lines: string[] = [];
  let writes = 0;

  for (const step of steps) {
    if (step.t !== "tool") continue;
    const { kind, target } = step.tool;
    if (kind === "edit") {
      writes++;
      lines.push(`edit **${target}**`);
    } else if (kind === "write") {
      writes++;
      lines.push(`write **${target}**`);
    } else if (kind === "bash") {
      lines.push(`run \`${target}\``);
    }
  }

  if (lines.length === 0) {
    lines.push("read the files that matter", "make the change", "run the tests");
  }

  return [
    { t: "say", wait: 600, text: "Here's my plan. Nothing has been changed yet." },
    {
      t: "plan",
      wait: 500,
      steps: lines,
      note: `${writes || "no"} file${writes === 1 ? "" : "s"} written · no new dependencies`,
    },
    {
      t: "ask",
      wait: 500,
      prompt: {
        variant: "plan",
        title: "Ready to code?",
        options: [
          { label: "Yes, and auto-accept edits" },
          { label: "Yes, and ask before each edit" },
          { label: "No, keep planning" },
        ],
        footer: "↑↓ select · ↵ confirm · or type feedback to revise the plan",
        denyIndex: 2,
      },
      accept: steps,
      deny: [{ t: "say", wait: 400, text: "Still planning. Tell me what to change and I'll redraw it." }],
    },
  ];
}

/**
 * The two commands that do work rather than open a screen.
 *
 * They are scripts like any other — a slash command that reads and writes is
 * a run with a different way of being started, and giving it its own code
 * path would be the first step towards two run loops.
 */
export const COMMAND_RUNS: Record<string, Step[]> = {
  "/review": [
    { t: "status", label: "Reading the working tree…" },
    {
      t: "tool",
      wait: 800,
      tool: { kind: "bash", name: "Bash", target: "git diff --stat", meta: "2 files · +27 -0" },
    },
    {
      t: "tool",
      wait: 1100,
      tool: { kind: "read", name: "Read", target: "the changed hunks", meta: "2 files" },
    },
    {
      t: "say",
      wait: 1300,
      text:
        "Two notes. **buildArgs** pushes `--model` before the prompt, which the CLI " +
        "accepts but the other flags don't follow — worth matching. And the new test " +
        "asserts argument order, which is the thing we just decided not to care about.",
    },
    {
      t: "notice",
      wait: 500,
      notice: {
        tone: "info",
        title: "Nothing blocking",
        body: "2 suggestions, 0 problems. Both are in claude-project.test.ts.",
        actions: [{ label: "fix both", primary: true }, { label: "leave them" }],
      },
    },
  ],
  "/init": [
    { t: "status", label: "Reading the repository…" },
    {
      t: "tool",
      wait: 900,
      tool: { kind: "search", name: "Search", target: "package.json · Cargo.toml · docs/", meta: "4 files" },
    },
    { t: "status", label: "Writing FIGY.md…" },
    {
      t: "tool",
      wait: 1600,
      tool: {
        kind: "write",
        name: "Write",
        target: "FIGY.md",
        added: 32,
        open: true,
        diff: [
          { no: 1, sign: "+", text: "# FIGY.md" },
          { no: 2, sign: "+", text: "" },
          { no: 3, sign: "+", text: "Tauri + React + TypeScript. `npm test` runs the suite;" },
          { no: 4, sign: "+", text: "there is no framework — tests are plain scripts." },
          { no: null, sign: "…", text: "" },
          { no: 18, sign: "+", text: "Never write a file around the editor's save path." },
        ],
      },
    },
    {
      t: "say",
      wait: 700,
      text: "Written. Edit it like any other file — FigyCode reads it at the start of every session.",
    },
  ],
};

/* ─── Shell mode ──────────────────────────────────────────────────────────── */

/**
 * Canned output for `!`.
 *
 * Keyed by the command's first two words, so `git log --oneline -4` and
 * `git log` land on the same entry rather than needing one line per spelling.
 */
const SHELL: Record<string, string[]> = {
  "git log": [
    "d2e5696 Give the terminal a Claude Code window",
    "4a1530d Git panel: stashes tab",
    "9be2c01 PTY resize flicker fix",
    "71f0e3a Session ids minted client-side",
  ],
  "git status": [
    "On branch main",
    "Changes not staged for commit:",
    "  modified:   src/services/claude-project.ts",
    "",
    "Untracked files:",
    "  docs/CODE-AGENT.md",
  ],
  "npm test": [
    "figy-args",
    "  ok  a trailing space opens a new, empty token",
    "  ok  an escaped space stays inside its token",
    "44 passed",
  ],
  "npm run": ["> figy-term@0.1.0 lint", "> eslint src --max-warnings 0", "", "✔ no problems"],
  "git diff": [
    "diff --git a/src/services/claude-project.ts b/src/services/claude-project.ts",
    "@@ -34,6 +34,9 @@",
    "+  /** Model alias passed as `--model`. */",
    "+  model?: string;",
  ],
};

export interface ShellResult {
  output: string[];
  note: string;
}

export function runShell(command: string): ShellResult {
  const key = command.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  const output = SHELL[key];
  if (output) {
    return { output, note: "ran in 0.1s · added to the conversation so FigyCode can see it" };
  }
  return {
    output: [`${command.trim().split(/\s+/)[0] ?? ""}: nothing canned for this one yet`],
    note: "this window is a prototype · only a few commands have invented output",
  };
}

/* ─── The gallery behind /errors ──────────────────────────────────────────── */

export const NOTICE_GALLERY: Notice[] = [
  {
    tone: "stop",
    title: "Interrupted by you",
    body: "Stopped before editing GitPanel.tsx. What should FigyCode do instead?",
  },
  {
    tone: "warn",
    title: "Edit didn't apply — the file changed on disk",
    body: "FigyCode re-read claude-project.ts and retried. Your changes were kept.",
    actions: [{ label: "show both" }],
  },
  {
    tone: "info",
    title: "Context 86% full",
    body: "Older turns will be summarised automatically at 95%.",
    actions: [{ label: "/compact", primary: true }],
  },
  {
    tone: "error",
    title: "Figy Pro limit reached",
    body: "Resets at 4:30 pm. Your session is saved.",
    actions: [{ label: "use Figy Fast", primary: true }, { label: "wait" }],
  },
  {
    tone: "error",
    title: "Command failed: cargo build (exit 101)",
    body: "FigyCode is reading the error and will try a fix.",
    actions: [{ label: "stop" }],
  },
];

/* ─── Small arithmetic the footer and the spinner need ────────────────────── */

/** `14s`, then `2m 41s`. Seconds all the way down would read as a stopwatch. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** `940`, `2.1k`, `31k`. One decimal only where it says something. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * Which commands to offer for what has been typed.
 *
 * Prefix first, then anything containing it, because `/re` should put
 * `/review` and `/rewind` above `/permissions` — which contains "re" in the
 * middle of a word nobody is thinking of.
 */
export function filterCommands(query: string): DemoCommand[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
  const contains = COMMANDS.filter(
    (c) => !starts.includes(c) && c.name.slice(1).toLowerCase().includes(q)
  );
  return [...starts, ...contains];
}

/*
  Ranking files used to live here, over the invented list.

  It is in Rust now — `commands/figy_files.rs` — and not because TypeScript
  could not do it: the ranking runs against every path in the repository on
  every keystroke, and the list never crosses the IPC boundary at all, only
  the dozen rows that won. The basename-before-path rule it was written for
  survives there as a scoring bonus, with tests of its own.
*/

/**
 * The `@word` being typed at the caret, if there is one.
 *
 * Returns the query without its `@`, or `null` when the caret is not inside a
 * mention — which is most of the time, and is why this is a separate function
 * rather than a regex repeated at three call sites. A mention ends at
 * whitespace, so `@src/services/` is one and `@file and then` is not.
 */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // An `@` only opens a mention at the start of a word.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}
