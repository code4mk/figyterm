/**
 * The Figy Code window.
 *
 * `docs/CODE-AGENT.md` argues for an agent of our own and says the window's
 * body should be ours rather than a pty. This is that body, built before the
 * agent exists: every transcript in it is scripted, every tool call is
 * invented, and nothing here reads a file or runs a command. It is a design
 * being tried at full size, because the questions this window asks — what a
 * permission prompt looks like when you are about to say yes to it for the
 * fortieth time, how a failed command reads three lines after the thing that
 * caused it — cannot be answered in a static mock.
 *
 * Two things in it are real, and deliberately so. The **chrome** is the
 * language the Claude and Draw windows settled — a 44px bar in three zones, a
 * breadcrumb for where you are, a 28px status bar saying what the agent can
 * reach — because a prototype wearing a bespoke frame is a prototype whose
 * frame gets argued about instead of its body. And the **project** is a real
 * folder, chosen through the OS dialog or from the terminal's own history and
 * remembered across restarts; see `services/figycode-projects.ts` for why the
 * window knows the path and nothing behind it.
 *
 * Escape, in order: close a completion popup, answer "no" to a question, come
 * back from `/rewind` or `/model`, leave shell mode, interrupt a run, close
 * the window. One meaning at a time, the innermost first, which is the only
 * arrangement that never surprises.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Maximize2,
  Minimize2,
  Minus,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import { useOverlayRect } from "../../hooks/useOverlayRect";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import { fullscreenRect, useDraggableModal } from "../../hooks/useDraggableModal";
import { collapseHome, normalizeDir, recentDirs } from "../../services/recent-dirs";
import {
  findFiles,
  hitMeta,
  openProjectIndex,
  type FileHit,
  type ProjectInfo,
} from "../../services/figycode-files";
import {
  addExtraDir,
  forgetProject,
  loadProjects,
  projectLabel,
  rememberProject,
  saveProjects,
  type FigyProject,
} from "../../services/figycode-projects";
import {
  CHECKPOINTS,
  COMMAND_RUNS,
  MODELS,
  MODE_LABEL,
  NOTICE_GALLERY,
  USER,
  cycleMode,
  filterCommands,
  formatElapsed,
  formatTokens,
  mentionAt,
  pickScript,
  planFor,
  runShell,
  type Block,
  type PermissionMode,
  type Prompt,
  type Step,
} from "../../services/figycode-demo";
import { BlockView } from "./FigyBlocks";
import { PromptCard } from "./FigyPrompt";
import {
  Composer,
  CompletionPopup,
  RunningLine,
  type ComposerHandle,
  type PopupItem,
} from "./FigyComposer";
import { ModelScreen, RewindScreen, Welcome, type RewindScope } from "./FigyScreens";
import { FigyProjects } from "./FigyProjects";

export interface FigyCodeModalProps {
  visible: boolean;
  onClose: () => void;
  onMinimize: () => void;
  /** The folder the focused terminal is in, so the window opens on it. */
  cwd?: string;
}

const MIN_SIZE = { w: 700, h: 480 };
const MAX_SIZE = { w: 2000, h: 1400 };
const DEFAULT_SIZE = { w: 960, h: 680 };

/** Which of the three things the body can be. */
type View = "chat" | "rewind" | "model";

/** A question the run has stopped on, with both of its continuations. */
interface LivePrompt {
  prompt: Prompt;
  accept: Step[];
  deny: Step[];
}

/** The conversation's name: the first thing asked of it. */
function conversationTitle(blocks: Block[]): string | null {
  const first = blocks.find((b) => b.kind === "user");
  if (!first || first.kind !== "user") return null;
  const line = first.text.replace(/\s+/g, " ").trim();
  return line.length > 54 ? `${line.slice(0, 53)}…` : line;
}

export function FigyCodeModal({ visible, onClose, onMinimize, cwd }: FigyCodeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ─── The conversation ─────────────────────────────────────────────────── */

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [live, setLive] = useState<LivePrompt | null>(null);
  const [choice, setChoice] = useState(0);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Working…");
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [background, setBackground] = useState<string | null>(null);
  const [todosHidden, setTodosHidden] = useState(false);

  /* ─── Session settings ─────────────────────────────────────────────────── */

  const [mode, setMode] = useState<PermissionMode>("ask");
  const [modelIndex, setModelIndex] = useState(0);
  const [thinking, setThinking] = useState(true);
  const [ctx, setCtx] = useState(12);
  const model = MODELS[modelIndex];

  /* ─── The composer ─────────────────────────────────────────────────────── */

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [shell, setShell] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);

  /* ─── Window state ─────────────────────────────────────────────────────── */

  const [view, setView] = useState<View>("chat");
  const [fullscreen, setFullscreen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  /* ─── The project ──────────────────────────────────────────────────────── */

  /*
    Real folders, remembered across restarts. Loaded once, lazily: the window
    is lazy-mounted anyway, and reading localStorage on every render to answer
    a question that changes twice a session would be silly.
  */
  const [projects, setProjects] = useState<FigyProject[]>(() => loadProjects());
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const recent = useMemo(() => (visible ? recentDirs() : []), [visible]);

  /*
    The folder the window opens on: whatever it was last pointed at, else the
    terminal's own. A window claiming a project while the shell behind it is
    somewhere else is the kind of small lie that costs trust in everything
    else on screen.
  */
  useEffect(() => {
    if (!visible || activeRoot) return;
    const fallback = projects[0]?.root ?? (cwd ? normalizeDir(cwd) : null);
    if (!fallback) return;
    setActiveRoot(fallback);
    /*
      The terminal's folder becomes a project the moment it is adopted, not
      the first time it is picked from the list. Otherwise the window is
      pointed at a folder that the folder list has never heard of, and "Add
      folder" has nothing to add to.
    */
    if (!projects.some((p) => p.root === fallback)) {
      const next = rememberProject(projects, fallback);
      setProjects(next);
      saveProjects(next);
    }
  }, [activeRoot, cwd, projects, visible]);

  const project = projects.find((p) => p.root === activeRoot) ?? null;
  const extraDirs = project?.extraDirs ?? [];

  /* ─── The file index behind @ ──────────────────────────────────────────── */

  /** What the backend found in the folder, or why it could not look. */
  const [index, setIndex] = useState<ProjectInfo | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [hits, setHits] = useState<FileHit[]>([]);

  /**
   * Index the folder once, when it is adopted.
   *
   * The walk is the slow part and it happens here rather than on the first
   * `@`, so the first mention is as quick as the twentieth. A folder that
   * cannot be read is not an error worth a dialog — the mention list says so
   * when it is opened, and everything else in the window carries on.
   */
  useEffect(() => {
    if (!activeRoot) return;
    let live = true;
    setIndex(null);
    setIndexError(null);
    setHits([]);
    openProjectIndex(activeRoot)
      .then((info) => {
        if (live) setIndex(info);
      })
      .catch((error: unknown) => {
        if (live) setIndexError(String(error));
      });
    return () => {
      live = false;
    };
    /*
      On the folder, and deliberately not on `visible`: the window is kept
      mounted once opened, so including it would re-walk the whole
      repository every time the window was dismissed and brought back. The
      backend rebuilds its own index when it goes stale, which is the right
      place for that decision — it knows how old the index is.
    */
  }, [activeRoot]);

  /* ─── Block ids ────────────────────────────────────────────────────────── */

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const push = useCallback((block: Block) => setBlocks((prev) => [...prev, block]), []);

  /* ─── The run loop ─────────────────────────────────────────────────────── */

  const queue = useRef<Step[]>([]);
  const timer = useRef<number | null>(null);
  /*
    The loop calls itself through a ref rather than through the closure: the
    chain is built out of timeouts, and a `useCallback` that referred to
    itself would capture whichever version of itself existed when the first
    timeout was set.
  */
  const advanceRef = useRef<() => void>(() => {});

  const applyStep = useCallback(
    (step: Step): "pause" | "go" => {
      switch (step.t) {
        case "say":
          push({ id: nextId(), kind: "assistant", text: step.text });
          return "go";
        case "status":
          setStatus(step.label);
          return "go";
        case "tool":
          push({ id: nextId(), kind: "tool", tool: step.tool });
          return "go";
        case "plan":
          push({ id: nextId(), kind: "plan", steps: step.steps, note: step.note });
          return "go";
        case "todos":
          /*
            One to-do list per run, rewritten in place. Appending a second
            copy every time an item is ticked is what a transcript of events
            would do, and it reads as five lists where there is one.
          */
          setBlocks((prev) => {
            const at = prev.findIndex((b) => b.kind === "todos");
            const block: Block = {
              id: at >= 0 ? prev[at].id : nextId(),
              kind: "todos",
              items: step.items,
            };
            if (at < 0) return [...prev, block];
            const next = [...prev];
            next[at] = block;
            return next;
          });
          return "go";
        case "notice":
          push({ id: nextId(), kind: "notice", notice: step.notice });
          return "go";
        case "summary":
          push({
            id: nextId(),
            kind: "summary",
            headline: step.headline,
            stats: step.stats,
            detail: step.detail,
            files: step.files,
          });
          return "go";
        case "actions":
          push({ id: nextId(), kind: "actions", chips: step.chips });
          return "go";
        case "background":
          setBackground(step.label);
          return "go";
        case "ask":
          setLive({ prompt: step.prompt, accept: step.accept ?? [], deny: step.deny ?? [] });
          setChoice(0);
          setRunning(false);
          return "pause";
      }
    },
    [push]
  );

  const finish = useCallback(() => {
    setRunning(false);
    setBackground(null);
    // Every turn costs context, and the status bar is where that is admitted.
    setCtx((c) => Math.min(99, c + 2));
  }, []);

  const advance = useCallback(() => {
    const step = queue.current.shift();
    if (!step) {
      finish();
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (applyStep(step) === "go") advanceRef.current();
    }, step.wait ?? 140);
  }, [applyStep, finish]);
  advanceRef.current = advance;

  const startRun = useCallback(
    (steps: Step[]) => {
      queue.current = [...steps];
      setRunning(true);
      setStatus("Working…");
      setStartedAt(Date.now());
      setElapsed(0);
      setTokens(0);
      advance();
    },
    [advance]
  );

  /** Stops the run where it is. `why` is pushed as a notice when given. */
  const stopRun = useCallback(
    (why?: string) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      queue.current = [];
      setRunning(false);
      setBackground(null);
      if (why) {
        push({
          id: nextId(),
          kind: "notice",
          notice: { tone: "stop", title: "Interrupted by you", body: why },
        });
      }
    },
    [push]
  );

  // Timers outlive the component if the window is torn down mid-run.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  /**
   * The meter, while something is happening.
   *
   * Tokens climb at an invented rate. The point of the line is that a run has
   * a cost and the cost is visible while it is spent — Lever 5 in the design
   * note — and a plausible number makes that argument where a frozen one
   * makes the opposite one.
   */
  useEffect(() => {
    if (!running) return;
    const tick = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
      setTokens((n) => n + 40 + Math.round(Math.random() * 140));
    }, 400);
    return () => window.clearInterval(tick);
  }, [running, startedAt]);

  /* ─── Answering a question ─────────────────────────────────────────────── */

  const answer = useCallback(
    (index: number) => {
      if (!live) return;
      const option = live.prompt.options[index];
      const denied = index === live.prompt.denyIndex;

      push({
        id: nextId(),
        kind: "prompt",
        prompt: live.prompt,
        answer: option?.label ?? "dismissed",
      });

      // "Yes, allow all edits this session" is the mode switch, said in the
      // place where the question about it came up.
      if (!denied && /allow all edits|auto-accept/i.test(option?.label ?? "")) setMode("accept");

      const next = denied ? live.deny : live.accept;
      setLive(null);
      queue.current = [...next, ...queue.current];
      setRunning(true);
      setStartedAt(Date.now());
      setElapsed(0);
      advance();
    },
    [advance, live, push]
  );

  /* ─── Commands, chips and shell ────────────────────────────────────────── */

  const say = useCallback(
    (textToSay: string) => push({ id: nextId(), kind: "assistant", text: textToSay }),
    [push]
  );

  const command = useCallback(
    (name: string) => {
      const run = COMMAND_RUNS[name];
      if (run) {
        startRun(run);
        return;
      }
      switch (name) {
        case "/model":
          setChoice(modelIndex);
          setView("model");
          return;
        case "/rewind":
          setChoice(0);
          setView("rewind");
          return;
        case "/compact":
          setCtx(9);
          say("Summarised 14 older turns into about 1,400 tokens. Context is back to **9%**.");
          return;
        case "/permissions":
          push({
            id: nextId(),
            kind: "notice",
            notice: {
              tone: "info",
              title: "Permission mode",
              body: `Currently ${MODE_LABEL[mode]}. shift+tab cycles it, or use the pill in the composer.`,
              actions: [
                { label: MODE_LABEL.ask },
                { label: MODE_LABEL.accept },
                { label: MODE_LABEL.plan },
              ],
            },
          });
          return;
        case "/harness":
          push({
            id: nextId(),
            kind: "notice",
            notice: {
              tone: "info",
              title: "Figy Harness isn't wired up yet",
              body: "This window is a design prototype — the hand-off lands with the agent core.",
            },
          });
          return;
        case "/errors":
          NOTICE_GALLERY.forEach((notice) => push({ id: nextId(), kind: "notice", notice }));
          say("Those are the five, as they appear inline. Nothing above actually happened.");
          return;
        default:
          say(`\`${name}\` isn't a command yet. Try /review, /rewind, /model or /init.`);
      }
    },
    [mode, modelIndex, push, say, startRun]
  );

  const submit = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;

      if (shell) {
        const result = runShell(value);
        push({
          id: nextId(),
          kind: "shell",
          command: value,
          output: result.output,
          note: result.note,
        });
        setText("");
        return;
      }

      setText("");

      /*
        Typing instead of answering is an answer.

        The composer says so — "answer above, or type to tell FigyCode
        something else" — and the alternative is a question left hanging over
        a conversation that has moved on, with a queue behind it that would
        resume at the wrong moment.
      */
      if (live) {
        push({
          id: nextId(),
          kind: "prompt",
          prompt: live.prompt,
          answer: "answered in the box instead",
        });
        setLive(null);
        queue.current = [];
      }

      if (value.startsWith("/")) {
        command(value.split(/\s+/)[0]);
        return;
      }

      push({ id: nextId(), kind: "user", text: value });
      const steps = pickScript(value).steps;
      // A question is answered in plan mode too — it is writing that stops.
      const asking = /^(why|what|where|how|who|explain|does|is|can)\b/i.test(value);
      startRun(mode === "plan" && !asking ? planFor(steps) : steps);
    },
    [command, live, mode, push, shell, startRun]
  );

  /** A chip in a notice or in the row after a summary. */
  const onAction = useCallback(
    (label: string) => {
      const asMode = (Object.keys(MODE_LABEL) as PermissionMode[]).find(
        (m) => MODE_LABEL[m] === label
      );
      if (asMode) {
        setMode(asMode);
        say(`Switched to **${MODE_LABEL[asMode]}**.`);
        return;
      }
      if (label.startsWith("/")) {
        command(label);
        return;
      }
      switch (label) {
        case "commit these changes":
          push({
            id: nextId(),
            kind: "shell",
            command: 'git commit -am "Pass model through to the CLI"',
            output: [
              "[main 7c1e0b2] Pass model through to the CLI",
              " 2 files changed, 27 insertions(+)",
            ],
            note: "committed on main · nothing pushed",
          });
          return;
        case "open a PR":
          push({
            id: nextId(),
            kind: "notice",
            notice: {
              tone: "info",
              title: "A pull request would open here",
              body: "The forge integration is not part of this prototype.",
            },
          });
          return;
        case "use Figy Fast":
          setModelIndex(1);
          say("Carrying on with **Figy Fast**. The session and its context are unchanged.");
          return;
        case "wait":
        case "stop":
        case "leave them":
          say("Stopped. Tell me when to pick it up again.");
          return;
        case "show both":
          say("Your version is on the left, mine on the right — the diff viewer would open here.");
          return;
        default:
          // Anything else is a sentence, so it is sent as one.
          push({ id: nextId(), kind: "user", text: label });
          startRun(pickScript(label).steps);
      }
    },
    [command, push, say, startRun]
  );

  /* ─── Projects ─────────────────────────────────────────────────────────── */

  const newConversation = useCallback(() => {
    stopRun();
    setLive(null);
    setBlocks([]);
    setView("chat");
    setCtx(12);
    setText("");
    setShell(false);
  }, [stopRun]);

  /**
   * Pointing the window at a folder.
   *
   * A new folder is a new conversation, not the same one re-rooted: every
   * path in the transcript above would now refer to somewhere else, and a
   * scroll you cannot trust is worse than a scroll you have lost.
   */
  const openProject = useCallback(
    (root: string) => {
      const next = rememberProject(projects, root);
      setProjects(next);
      saveProjects(next);
      setActiveRoot(normalizeDir(root.trim()));
      newConversation();
    },
    [newConversation, projects]
  );

  const forget = useCallback(
    (root: string) => {
      const next = forgetProject(projects, root);
      setProjects(next);
      saveProjects(next);
    },
    [projects]
  );

  const addFolder = useCallback(async () => {
    if (!activeRoot) return;
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: activeRoot,
    });
    if (typeof picked !== "string") return;
    const next = addExtraDir(projects, activeRoot, picked);
    setProjects(next);
    saveProjects(next);
  }, [activeRoot, projects]);

  /* ─── Completion ───────────────────────────────────────────────────────── */

  const slashing = !shell && text.startsWith("/") && !/\s/.test(text);
  const mention = shell ? null : mentionAt(text, caret);
  const mentionQuery = mention?.query ?? null;

  /**
   * The mention list, fetched as it is typed.
   *
   * Debounced, because a keystroke is faster than an IPC round trip and the
   * ranking of `cla` is wasted work once `clau` has been typed. The sequence
   * number is the other half of that: replies can land out of order, and a
   * slow early query overwriting a fast later one is how a list ends up
   * showing the answer to a question nobody asked any more.
   */
  const askedRef = useRef(0);
  useEffect(() => {
    if (mentionQuery === null) return;
    if (!index) {
      setHits([]);
      return;
    }
    const asked = ++askedRef.current;
    const timer = window.setTimeout(() => {
      findFiles(mentionQuery, 12)
        .then((found) => {
          if (askedRef.current === asked) setHits(found);
        })
        .catch(() => {
          if (askedRef.current === asked) setHits([]);
        });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [index, mentionQuery]);

  const popup: PopupItem[] = useMemo(() => {
    if (slashing) {
      return filterCommands(text).map((c) => ({
        value: `${c.name} `,
        label: c.name,
        meta: c.summary,
      }));
    }
    if (mention) {
      return hits.map((hit) => ({
        value: `@${hit.path}${hit.isDir ? "" : " "}`,
        label: hit.path,
        meta: hitMeta(hit),
      }));
    }
    return [];
  }, [hits, mention, slashing, text]);

  /**
   * What the popup says when it has nothing.
   *
   * An empty list is the one state that has to explain itself: no folder, a
   * folder that would not read, an index still being built, or a query that
   * genuinely matches nothing all look identical from the outside.
   */
  const popupEmpty = !mention
    ? null
    : !activeRoot
      ? "No folder open — choose one from the title bar"
      : indexError
        ? `Could not read that folder: ${indexError}`
        : !index
          ? "Indexing the folder…"
          : `Nothing matches “${mention.query}”`;

  // The list changes under the cursor as you type, so the cursor is clamped
  // rather than left pointing past the end of a shorter list.
  const popupAt = popup.length ? Math.min(popupIndex, popup.length - 1) : 0;

  /** Puts the caret somewhere after React has written the new value. */
  const focusAt = useCallback((at: number) => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setCaret(at);
    });
  }, []);

  /**
   * Taking a row from the popup.
   *
   * The path goes into the sentence where it was being typed, as text —
   * `explain how sessions are named in @src/services/claude-session.ts` is
   * one thought, and a mention that lived anywhere but in the line would
   * make it two.
   *
   * A folder keeps its trailing slash and gains no space, so the popup
   * stays open on `@src/services/` and the next keystroke narrows inside it.
   */
  const complete = useCallback(
    (index: number) => {
      const item = popup[index];
      if (!item) return;
      const next = mention
        ? `${text.slice(0, mention.start)}${item.value}${text.slice(caret)}`
        : item.value;
      const at = mention ? mention.start + item.value.length : next.length;
      setText(next);
      setCaret(at);
      setPopupIndex(0);
      focusAt(at);
    },
    [caret, focusAt, mention, popup, text]
  );

  /** The three buttons under the box, which type the character for you. */
  const insert = useCallback(
    (token: "@" | "/" | "!") => {
      if (token === "!") {
        // The draft survives the switch. Whatever is half-typed, it is not
        // the button's business to throw it away.
        setShell((on) => !on);
        focusAt(text.length);
        return;
      }
      setShell(false);
      const next = !text || text.endsWith(" ") ? `${text}${token}` : `${text} ${token}`;
      setText(next);
      setCaret(next.length);
      setPopupIndex(0);
      focusAt(next.length);
    },
    [focusAt, text]
  );

  /* ─── Screens ──────────────────────────────────────────────────────────── */

  const leaveScreen = useCallback(() => {
    setView("chat");
    setChoice(0);
  }, []);

  const restore = useCallback(
    (scope: RewindScope) => {
      const what =
        scope === "both"
          ? "Code and conversation"
          : scope === "chat"
            ? "The conversation"
            : "The code";
      leaveScreen();
      push({
        id: nextId(),
        kind: "notice",
        notice: {
          tone: "info",
          title: "Rewound",
          body: `${what} is back to where it was. Nothing was actually moved — this is a prototype.`,
        },
      });
    },
    [leaveScreen, push]
  );

  const chooseModel = useCallback(
    (index: number) => {
      setModelIndex(index);
      leaveScreen();
      say(`Now using **${MODELS[index].name}** for this session.`);
    },
    [leaveScreen, say]
  );

  /* ─── Keyboard ─────────────────────────────────────────────────────────── */

  /**
   * One handler for the whole window, reached by bubbling.
   *
   * One, because the arrangement where each control took its own chord is
   * what made Escape mean three things at once in the first draft.
   *
   * **It stops only what it takes.** The first version ended with a blanket
   * `stopPropagation` on the argument that the shell behind must not see
   * what was typed here — which was wrong twice over. The shell only
   * receives keys when a terminal pane has the focus, and this window has
   * it; and the app's own shortcuts are a window-level listener that the
   * blanket stop also silenced, so with FigyCode open there was no light/dark
   * toggle, no command palette and no way to reach any other window. The
   * chords below are deliberately narrow for the same reason: plain Tab is
   * the completion, `Ctrl+Shift+Tab` is the shell's, and neither may take the
   * other's key.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      /** No modifier at all: the keys the composer owns while it has focus. */
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
      /* Ctrl, and never ⌘ — `ctrl+t` is what the window says in its own to-do
         header, and ⌘T belongs to the shell's new tab even from in here. */
      const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

      if (e.key === "Escape") {
        stop();
        // An open popup with nothing in it — "nothing matches that" — is
        // still something Escape should take away before it takes anything
        // else.
        if ((popup.length || popupEmpty) && (slashing || mention)) {
          // Leave the text, lose the popup: the quickest way to dismiss a
          // suggestion without losing what was typed.
          setText((t) => `${t} `);
          return;
        }
        if (live) {
          answer(live.prompt.denyIndex);
          return;
        }
        if (view !== "chat") {
          leaveScreen();
          return;
        }
        if (shell) {
          setShell(false);
          setText("");
          return;
        }
        if (running) {
          stopRun("Stopped before the next step. What should FigyCode do instead?");
          return;
        }
        onClose();
        return;
      }

      if (e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        stop();
        // On an edit prompt, shift+tab is the second option — "yes, and stop
        // asking" — which is the same promise the mode makes.
        const chord = live?.prompt.options.findIndex((o) => o.chord === "shift+tab") ?? -1;
        if (live && chord >= 0) answer(chord);
        else setMode(cycleMode);
        return;
      }

      if (e.key === "Tab" && bare && popup.length) {
        stop();
        complete(popupAt);
        return;
      }

      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare) {
        const delta = e.key === "ArrowDown" ? 1 : -1;
        if (popup.length) {
          stop();
          setPopupIndex((i) => (popup.length + Math.min(i, popup.length - 1) + delta) % popup.length);
          return;
        }
        const count =
          live?.prompt.options.length ??
          (view === "model" ? MODELS.length : view === "rewind" ? CHECKPOINTS.length : 0);
        if (count) {
          stop();
          setChoice((i) => (count + i + delta) % count);
        }
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && bare) {
        stop();
        if (popup.length) {
          complete(popupAt);
          return;
        }
        if (live) {
          answer(choice);
          return;
        }
        if (view === "model") {
          chooseModel(choice);
          return;
        }
        if (view === "rewind") {
          restore("both");
          return;
        }
        submit(text);
        return;
      }

      // A digit picks an option outright, which is what the numbers are for.
      // ⌘1–9 stays the shell's way of reaching a terminal tab.
      if (live && !text && bare && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        if (index < live.prompt.options.length) {
          stop();
          answer(index);
        }
        return;
      }

      if (e.key === "!" && !shell && !text) {
        stop();
        setShell(true);
        return;
      }

      if (ctrlOnly && e.key === "t") {
        stop();
        setTodosHidden((h) => !h);
        return;
      }

      if (ctrlOnly && e.key === "r") {
        stop();
        setChoice(0);
        setView("rewind");
        return;
      }

      if (ctrlOnly && e.key === "b" && background) {
        stop();
        push({
          id: nextId(),
          kind: "shell",
          command: background,
          output: ["VITE v5.4.11  ready in 412 ms", "➜  Local:   http://localhost:1420/"],
          note: "still running in the background",
        });
        return;
      }

      /*
        Everything else goes on: typing reaches the textarea, and a chord
        this window has no opinion about reaches the app, which is how
        light/dark, the palette and every other window stay available while
        this one has the keyboard.
      */
    },
    [
      answer,
      background,
      choice,
      complete,
      chooseModel,
      leaveScreen,
      live,
      mention,
      onClose,
      popup.length,
      popupAt,
      popupEmpty,
      push,
      restore,
      running,
      shell,
      slashing,
      stopRun,
      submit,
      text,
      view,
    ]
  );

  /* ─── Window plumbing ──────────────────────────────────────────────────── */

  const { style, onDragStart, onResizeStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("figy-code")), []);
  useOverlayZSync("figy-code", setFrontZ);

  /*
    A window, and now it says where it is.

    It has no backdrop any more, so it covers only the rectangle it occupies
    — and the browser, whose page is a native webview that no CSS can sit
    over, hides that page whenever something is genuinely on top of it. With
    no rectangle registered the stack assumes "covers everything", which
    would blank the browser from the other side of the screen.
  */
  useOverlayRect("figy-code", modalRef, visible);

  useEffect(() => {
    if (visible) {
      raise();
      return;
    }
    releaseFront("figy-code");
    setFrontZ(null);
  }, [visible, raise]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => {
      if (prev) reset();
      else {
        const rect = fullscreenRect();
        place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
      }
      return !prev;
    });
  }, [place, reset]);

  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen, place]);

  // The keyboard belongs to the composer the moment the window appears.
  useEffect(() => {
    if (visible) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible]);

  // Follow the tail. A transcript that has to be chased is a transcript
  // nobody reads while it is being written.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks, live, running, status]);

  if (!visible) return null;

  /* ─── Strings the chrome needs ─────────────────────────────────────────── */

  const title = conversationTitle(blocks);
  const label = activeRoot ? projectLabel(activeRoot) : "No folder";
  const hint = mention
    ? "↑↓ choose · tab insert · esc close"
    : "↑↓ choose · ↵ or tab to complete · esc close";

  const placeholder = shell
    ? "Run a command — its output is added to the conversation"
    : live
      ? "Answer above, or type to tell FigyCode something else"
      : "Ask FigyCode to change something, or explain it";

  const modal = (
    <div
      ref={modalRef}
      role="dialog"
      /* Not modal: the app behind it stays live, and saying otherwise would
         tell a screen reader the rest of the window is inert when it isn't. */
      aria-modal={false}
      aria-label="FigyCode"
      className={`figy-modal pointer-events-auto flex flex-col overflow-hidden ${
        fullscreen ? "rounded-none" : "rounded-xl"
      }`}
      style={style}
      onPointerDownCapture={raise}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      tabIndex={-1}
    >
      {/*
        The title bar, in the language the Claude and Draw windows settled:
        three zones — what this window is, where you are in it, and what the
        window itself can do. The middle one is a breadcrumb, and only its
        first half is a button, because "take me to the list of these" is the
        one thing anyone tries to click on a crumb.
      */}
      <header
        className="figy-header flex items-center gap-2 px-2 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onDragStart}
      >
        <div className="flex items-center gap-1.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          <span className="figy-mark">ƒ</span>
          <span className="figy-brand-title">FigyCode</span>
        </div>

        <span className="figy-sep" />

        <div className="figy-locator flex items-center gap-1.5 flex-1 min-w-0">
          <button
            className="figy-locator-project flex items-center gap-1.5 min-w-0"
            onClick={() => setPickerOpen(true)}
            onPointerDown={(e) => e.stopPropagation()}
            title={activeRoot ? `${activeRoot}\nChoose another folder` : "Choose a folder"}
          >
            <FolderOpen size={11} className="shrink-0 opacity-70" />
            <span className="truncate">{label}</span>
          </button>
          <ChevronRight size={11} className="figy-locator-sep shrink-0" />
          <span className={`figy-locator-conv truncate ${title ? "" : "idle"}`} title={title ?? undefined}>
            {title ?? "New conversation"}
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          {running && (
            <span className="figy-live-count mr-1.5" title="A run is in progress">
              <span className="figy-dot live" />
              running
            </span>
          )}

          <span className="figy-sep" />

          <button className="figy-iconbtn" onClick={onMinimize} title="Minimize" aria-label="Minimize">
            <Minus size={12} />
          </button>
          <button
            className={`figy-iconbtn ${fullscreen ? "on" : ""}`}
            onClick={toggleFullscreen}
            title={fullscreen ? "Restore" : "Maximize"}
            aria-label={fullscreen ? "Restore" : "Maximize"}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            className="figy-iconbtn danger"
            onClick={onClose}
            title="Close (Esc) — the conversation is kept"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      {/* ─── Body ──────────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="figy-body flex-1 min-h-0">
        {view === "rewind" ? (
          <RewindScreen selected={choice} onSelect={setChoice} onRestore={restore} />
        ) : view === "model" ? (
          <ModelScreen
            selected={choice}
            onSelect={setChoice}
            onChoose={chooseModel}
            thinking={thinking}
            onToggleThinking={() => setThinking((t) => !t)}
          />
        ) : blocks.length === 0 ? (
          <Welcome
            model={model}
            user={USER}
            root={activeRoot}
            index={index}
            others={projects.filter((p) => p.root !== activeRoot).slice(0, 3)}
            onPick={openProject}
            onBrowse={() => setPickerOpen(true)}
          />
        ) : (
          <div className="figy-transcript">
            {blocks.map((block) => (
              <BlockView
                key={block.id}
                block={block.kind === "todos" ? { ...block, hidden: todosHidden } : block}
                onAction={onAction}
                onToggleTodos={() => setTodosHidden((h) => !h)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ─── Bottom: the question, the spinner, the popup, the box ─────────── */}
      <div className="figy-bottom">
        {live && (
          <PromptCard prompt={live.prompt} selected={choice} onSelect={setChoice} onChoose={answer} />
        )}

        {running && (
          <RunningLine
            label={status}
            elapsed={formatElapsed(elapsed)}
            tokens={formatTokens(tokens)}
            background={background}
            onBackground={() =>
              push({
                id: nextId(),
                kind: "shell",
                command: background ?? "",
                output: ["VITE v5.4.11  ready in 412 ms", "➜  Local:   http://localhost:1420/"],
                note: "still running in the background",
              })
            }
          />
        )}

        {!running && !live && background && (
          <div className="figy-running idle">
            <div className="figy-running-spacer" />
            <button type="button" className="figy-bg-chip" onClick={() => setBackground(null)}>
              <span className="figy-bg-dot" />1 background task · {background} · ctrl+b
            </button>
          </div>
        )}

        <CompletionPopup
          items={popup}
          selected={popupAt}
          hint={hint}
          empty={popupEmpty}
          onSelect={setPopupIndex}
          onChoose={complete}
        />

        <Composer
          ref={inputRef}
          value={text}
          shell={shell}
          placeholder={placeholder}
          running={running}
          modeLabel={MODE_LABEL[mode]}
          modeTone={mode}
          modelLabel={model.short}
          onChange={(value) => {
            setText(value);
            setCaret(inputRef.current?.caret() ?? value.length);
            setPopupIndex(0);
          }}
          onCaret={() => setCaret(inputRef.current?.caret() ?? 0)}
          onInsert={insert}
          onCycleMode={() => setMode(cycleMode)}
          onPickModel={() => {
            setChoice(modelIndex);
            setView("model");
          }}
          onSend={() => submit(text)}
          onStop={() => stopRun("Stopped before the next step. What should FigyCode do instead?")}
        />
      </div>

      {/*
        The status bar: what the agent can reach, and what the session has
        spent. It reads left to right as one sentence — the folder it would
        run in, then every other folder it was granted.
      */}
      <div className="figy-statusbar flex items-center gap-2 px-3 shrink-0">
        {activeRoot ? (
          <>
            <FolderOpen size={10} className="figy-folder-icon shrink-0" />
            <span className="figy-folder-primary truncate" title={activeRoot}>
              {collapseHome(activeRoot)}
            </span>

            {extraDirs.map((dir) => (
              <span key={dir} className="figy-chip-sm shrink-0" title={`${dir} — also reachable`}>
                {collapseHome(dir)}
              </span>
            ))}

            {/* Beside the folders it adds to, rather than three zones away on
                the title bar: a control belongs with the thing it changes. */}
            <button
              className="figy-chip-sm add shrink-0"
              onClick={() => void addFolder()}
              title="Add a folder the agent may also read and edit"
            >
              <FolderPlus size={10} />
              Add folder
            </button>
          </>
        ) : (
          <button className="figy-chip-sm add shrink-0" onClick={() => setPickerOpen(true)}>
            <FolderPlus size={10} />
            Choose a folder
          </button>
        )}

        <div className="flex-1" />

        <span className="figy-status-right shrink-0" title="Scripted — this window has no agent yet">
          prototype · ctx {ctx}%
        </span>

        <div
          className="editor-resize-handle"
          onPointerDown={(e) => onResizeStart(e, "se")}
          title="Resize"
          role="separator"
          aria-orientation="horizontal"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="editor-resize-icon">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {pickerOpen && (
        <FigyProjects
          projects={projects}
          recent={recent}
          cwd={cwd}
          activeRoot={activeRoot}
          onOpen={openProject}
          onForget={forget}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );

  return (
    <OverlayPortal>
      {/*
        There is no backdrop, only a layer that places the window.

        A click outside used to dismiss, and must not: a conversation is work
        in progress — a half-typed prompt, a question waiting on an answer, a
        run with a timer behind it — and a stray click on the shell should
        not put it away. But a sheet that merely *stops* dismissing is a
        sheet that swallows every click instead, which leaves the app behind
        it looking broken. So it takes no pointer events at all: the terminal,
        the tab strip and the status bar all still work with this window open,
        and the window itself is the only thing in the layer that can be
        clicked. Escape and the ✕ are the ways out, and both are in the
        chrome.
      */}
      <div
        className="fixed inset-0 flex items-start justify-center pt-[6vh] pointer-events-none"
        style={{ zIndex: frontZ ?? undefined }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}
