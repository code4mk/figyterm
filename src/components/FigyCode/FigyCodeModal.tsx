/**
 * The Figy Code window.
 *
 * `docs/CODE-AGENT.md` argues for an agent of our own and says the body of
 * its window should be ours rather than a pty. This is that body, and as of
 * this version it is telling the truth: every line in the transcript came
 * from `src-tauri/src/agent/`, every tool call ran, and the cost in the
 * status bar is what the provider reported.
 *
 * It began as a prototype over a scripted transcript, which is why the
 * design is further along than the agent behind it. That was the point —
 * what a permission prompt looks like when you are about to say yes to it
 * for the fortieth time, and how a failed command reads three lines after
 * the thing that caused it, are questions a static mock cannot answer.
 *
 * **There is no turn loop here.** The window sends a message and renders
 * events; `agent/session.rs` decides what happens after a tool call. Two
 * implementations of that would diverge within a month, and the one in the
 * front end would be the one nobody tested.
 *
 * Escape, in order: close a completion completion.items, answer "no" to a question,
 * come back from a screen, leave shell mode, interrupt the turn, close the
 * window. One meaning at a time, the innermost first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PrimaryHome } from "../AppShell/PrimaryChrome";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Maximize2,
  Minimize2,
  Settings2,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import {
  claimFront,
  isFront,
  noOverlayOpen,
  releaseFront,
} from "../../services/overlay-stack";
import { useOverlayRect } from "../../hooks/useOverlayRect";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import { fullscreenRect, useDraggableModal } from "../../hooks/useDraggableModal";
import { BASE_SLOT_Z, useBaseSlot } from "../../hooks/useBaseSlot";
import { collapseHome, normalizeDir, recentDirs } from "../../services/recent-dirs";
import { countDir, setExtraDirs, type DirCount } from "../../services/figycode-files";
import {
  addExtraDir,
  removeExtraDir,
  forgetProject,
  loadProjects,
  projectLabel,
  rememberProject,
  saveProjects,
  type FigyProject,
} from "../../services/figycode-projects";
import {
  MODE_LABEL,
  cycleMode,
  formatCost,
  formatElapsed,
  formatTokens,
  type Block,
} from "../../services/figycode-blocks";
import {
  agentTestRouter,
  settingsFrom,
  type AgentSettings,
  type Totals,
} from "../../services/figycode-agent";
import { BlockView } from "./FigyBlocks";
import { PromptCard } from "./FigyPrompt";
import { BackgroundBar, Composer, CompletionPopup, RunningLine } from "./FigyComposer";
import { ProjectDialog, ResumeDialog, UsageDialog, Welcome } from "./FigyScreens";
import { FigyProjects } from "./FigyProjects";
import { SettingsDialog } from "./FigySettings";
import { ModelPicker } from "./FigyModelPicker";
import { ContextDialog } from "./FigyContext";
import { ToolsDialog } from "./FigyTools";
import { useAgentSurface } from "./useAgentSurface";
import { screenFor, type Screen } from "../../services/figycode-views";

export interface FigyCodeModalProps {
  visible: boolean;
  onClose: () => void;
  /** The folder the focused terminal is in, so the window opens on it. */
  cwd?: string;
  /**
   * This is the base: it fills the slot above the status bar, never moves and
   * cannot be put away. See `useBaseSlot` for why that is a prop rather than a
   * second component.
   */
  docked?: boolean;
}

const MIN_SIZE = { w: 700, h: 480 };
const MAX_SIZE = { w: 2000, h: 1400 };
const DEFAULT_SIZE = { w: 960, h: 680 };

/**
 * Which dialog is over the transcript, if any.
 *
 * One at a time, by construction. They were a mixture of a dialog and
 * two body screens, which meant two different ways to be somewhere
 * else and two different ways back.
 */
type Dialog = "settings" | "resume" | "usage" | "context" | "project" | "tools" | null;

/**
 * The prompt the agent is given, built once per session.
 *
 * **Frozen on purpose.** Order on the wire is `tools → system → messages`
 * and caching is a prefix match, so a timestamp, a branch name or the open
 * file in here would invalidate the whole cache on every turn. Volatile
 * facts belong in the first user message. `agent/session.rs` holds the same
 * rule from the other side.
 */
const SYSTEM_PROMPT = [
  "You are FigyCode, a coding agent inside the Figylo terminal.",
  "",
  "You work in one project folder. Read before you edit: `edit` replaces exact text,",
  "so copy the lines from a `read` rather than retyping them. Prefer `grep` to find",
  "where something is and then `read` the range, rather than reading whole files.",
  "",
  "Be brief. The person is watching you work and will read one or two sentences",
  "between tool calls, not a report.",
  "",
  // The transcript, as something somebody reads. Both halves of this
  // were learned from a real one that went Ls, Bash, answer — three
  // rows and no words, which tells you what happened and nothing
  // about why any of it was worth doing.
  "Two things make the transcript readable, and they do different jobs.",
  "",
  "Every tool takes a `why`: four or five words on what *this* call is for, in your",
  "own words, written for the person rather than for yourself. \"checking how retries",
  "are wired\", \"building to see if it compiles\". The window shows it on the row",
  "instead of the path or the command, so a long call is something to read rather",
  "than a spinner. Always pass it.",
  "",
  "And say a line of your own before a run of tool calls, when it is worth saying:",
  "what you are about to do, or what you just learned that changed the plan. Not",
  "before every call — the rows cover that, and a sentence per tool is noise. Before",
  "the first one, and again when the answer to something surprised you. A request",
  "with one obvious action needs no preamble at all; just do it.",
  "",
  "Tool results are re-sent on every later turn, so ask for what you need and not",
  "more. Do not re-read a range you have already been given.",
  "",
  // The pathology this replaces: asked to build a Docker image and
  // report back, a model with only `bash_output` polls it. Each poll
  // is a whole round trip that re-sends the conversation, so a
  // four-minute build arrived as forty rows that each said "still
  // running, 7 lines" and forty times the input bill.
  "For something slow — a build, a test suite, an install — start it with",
  "background=true and then call `bash_wait` on its id. It returns when the command is",
  "done, with its exit code. **Never poll `bash_output` in a loop**: each call is a",
  "whole request that re-sends this conversation, and it tells the person nothing that",
  "the waiting row does not already show them. When the wait comes back, say what",
  "happened in a sentence — whether it worked, and what to do about it if it did not.",

  "",
  // The list is the only thing that keeps the model's own intent in the
  // prefix without restating it in prose every turn — but only if it
  // reaches for it, and a tool description alone is read once and
  // forgotten by turn nine.
  // A command's row says `Bash npm run build` on its own, which is a
  // fact rather than a reason — and over two minutes of watching it,
  // the reason is what somebody wants.
  "When you run a command or send a question to a sub-agent, pass `why`: four or",
  "five words on what you are doing, in your own words. It is what the person",
  "watching sees while it runs.",
  "",
  "For anything with more than two or three steps, write the plan down with",
  "`todo_write` before you start, mark one item `running` while you are on it, and",
  "update the list as you finish each. It is how the person follows what you are",
  "doing, and how you keep track of what you have not done yet.",
].join("\n");

/** This window is the `window` surface; the editor's panel is the other. */
const SURFACE = "window" as const;

/**
 * What the window knows before the backend has answered.
 *
 * Nothing. There is no local copy of the settings any more — the file is
 * the backend's and `agent_status` is the only reader — so the empty
 * state is "not configured" rather than a guess at a default provider
 * that was wrong for everybody not using OpenAI.
 */
/** The conversation's name: the first thing asked of it. */
function conversationTitle(blocks: Block[]): string | null {
  const first = blocks.find((b) => b.kind === "user");
  if (!first || first.kind !== "user") return null;
  const line = first.text.replace(/\s+/g, " ").trim();
  return line.length > 54 ? `${line.slice(0, 53)}…` : line;
}

export function FigyCodeModal({
  visible,
  onClose,
  cwd,
  docked = false,
}: FigyCodeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ─── Window state ─────────────────────────────────────────────────────── */

  const [dialog, setDialog] = useState<Dialog>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);


  /* ─── The project ──────────────────────────────────────────────────────── */

  const [projects, setProjects] = useState<FigyProject[]>(() => loadProjects());
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const recent = useMemo(() => (visible ? recentDirs() : []), [visible]);

  /*
    The folder the window opens on: whatever it was last pointed at, else
    the terminal's own. A window claiming a project while the shell behind
    it is somewhere else is the kind of small lie that costs trust in
    everything else on screen.
  */
  useEffect(() => {
    if (!visible || activeRoot) return;
    const fallback = projects[0]?.root ?? (cwd ? normalizeDir(cwd) : null);
    if (!fallback) return;
    setActiveRoot(fallback);
    if (!projects.some((p) => p.root === fallback)) {
      const next = rememberProject(projects, fallback);
      setProjects(next);
      saveProjects(next);
    }
  }, [activeRoot, cwd, projects, visible]);

  const project = projects.find((p) => p.root === activeRoot) ?? null;
  const extraDirs = project?.extraDirs ?? [];

  /* ─── The agent ────────────────────────────────────────────────────────── */

  /*
    The chatbox, shared with the editor's panel.

    Everything in `useAgentSurface` was written here first and moved
    there when the panel needed the same behaviour — the reducer, the
    completion, the attachments, what Enter means while a card is up.
    What stays in this file is what it means to be a *window*: the
    dialogs, the project list, the title bar, dragging and fullscreen.
  */
  const commandRef = useRef<(name: string) => boolean>(() => false);
  const agent = useAgentSurface({
    surface: SURFACE,
    system: SYSTEM_PROMPT,
    root: activeRoot,
    active: visible,
    // The window has `bash`, so the window has a `!` prompt.
    shell: true,
    onCommand: useCallback((name: string) => commandRef.current(name), []),
    commandHint: "Try /model, /project, /context, /usage, /tools, /resume or /clear.",
    noFolder: {
      short: "No folder open — choose one from the title bar",
      long: "Choose one from the title bar first — every tool resolves against it.",
    },
  });
  const {
    session,
    choice,
    setChoice,
    elapsed,
    mode,
    setMode,
    status,
    configured,
    totals,
    context,
    past,
    rules,
    tools,
    loadContext,
    loadUsage,
    loadPast,
    loadTools,
    saveSettings: persist,
    inputRef,
    text,
    setText,
    setCaret,
    shell,
    setShell,
    attachments,
    addFiles,
    removeFile,
    queued,
    unqueue,
    completion,
    setPopupIndex,
    complete,
    insert,
    index,
    notice,
    running,
    stopJob,
    openJob,
    setOpenJob,
    log,
    command,
    send,
    answer,
    interrupt,
    newConversation: clearConversation,
    resume: resumeConversation,
    forgetConversation,
  } = agent;

  /*
    The grant itself, sent whenever the list changes.

    The window owns these — they are in `localStorage` and edited in
    `/project` — and for a while that was the only place they existed.
    The backend enforces against what it has been told, so a folder it
    has not been told about is a folder the settings claim and every
    tool refuses. Sent on open and on every change, including the
    change to none.
  */
  useEffect(() => {
    if (!activeRoot) return;
    void setExtraDirs(SURFACE, extraDirs).catch(() => {});
  }, [activeRoot, extraDirs]);

  /*
    How much is in each extra folder, counted when `/project` opens.

    Not on adoption: walking a folder is a second or two and these are
    only ever looked at in one dialog. `null` is a folder that would
    not read — renamed, unmounted, gone — which is worth showing
    rather than hiding, because the agent has been granted it.
  */
  const [dirCounts, setDirCounts] = useState<Record<string, DirCount | null>>({});

  useEffect(() => {
    if (dialog !== "project") return;
    let alive = true;
    for (const dir of extraDirs) {
      if (dir in dirCounts) continue;
      countDir(dir)
        .then((count) => alive && setDirCounts((all) => ({ ...all, [dir]: count })))
        .catch(() => alive && setDirCounts((all) => ({ ...all, [dir]: null })));
    }
    return () => {
      alive = false;
    };
    // `dirCounts` is read to skip what is already counted, and writing
    // to it must not start the effect again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, extraDirs]);

  /* ─── Commands ─────────────────────────────────────────────────────────── */

  /* ─── Sending ──────────────────────────────────────────────────────────── */

  /* ─── Projects ─────────────────────────────────────────────────────────── */

  /**
   * Starting fresh, and closing whatever asked for it.
   *
   * The hook ends the conversation; the dialog it was asked from is
   * this window's and it has to be dismissed here, or `/clear` typed
   * into the settings dialog leaves the dialog sitting over an empty
   * transcript.
   */
  const newConversation = useCallback(() => {
    clearConversation();
    setDialog(null);
  }, [clearConversation]);

  const resume = useCallback(
    (sessionId: string) => void resumeConversation(sessionId).then(() => setDialog(null)),
    [resumeConversation]
  );

  /*
    The commands that open something.

    Filled through a ref because they reach for the hook's loaders and
    the hook is constructed above them — and they cannot move into the
    hook, because what each one opens is a dialog this window has and
    the editor's panel does not.
  */
  /**
   * Opens a screen, having loaded what it needs.
   *
   * One function for every way in — a command, the status bar's two
   * figures, the composer's "manage models" — because otherwise a
   * button would show the last answer it happened to have while the
   * command showed a fresh one, and the two would disagree about the
   * same number.
   */
  const show = useCallback(
    (screen: Screen) => {
      /*
        `/tools` needs two calls, because the two halves of that screen
        come from different places: the registry says what the tools
        *are* and the breakdown says how many of them the last message
        actually offered. Without the second, the one fact about the
        tool picker that cannot be seen anywhere else is missing from
        the screen that is about tools.
      */
      const ready =
        screen === "tools"
          ? Promise.all([loadTools(), loadContext().catch(() => null)])
          : screen === "context"
            ? loadContext()
            : screen === "usage"
              ? loadUsage()
              : screen === "resume"
                ? loadPast()
                : Promise.resolve(null);
      // Shown either way: a screen that fails to load says so in its
      // own empty state, which beats a command that does nothing.
      void Promise.resolve(ready)
        .catch(() => null)
        .then(() => setDialog(screen));
    },
    [loadContext, loadPast, loadTools, loadUsage]
  );

  /*
    Which command opens which screen is `COMMAND_SCREEN`, shared with
    the editor panel — `/project` was offered by the composer on both
    surfaces and handled on only one, so typing it there completed from
    the popup and then answered "No command /project".

    Through a ref because these reach for the loaders above them, and
    they cannot move into the hook: *how* a screen is shown is the
    surface's own, a dialog here and a tab in a sheet there.
  */
  useEffect(() => {
    commandRef.current = (name: string) => {
      const screen = screenFor(name);
      if (screen === null) return false;
      /*
        Intercepted rather than left to the hook, which ends the
        conversation but knows nothing about the dialog that may be
        over it — `/clear` typed with one open would empty the
        transcript behind a screen still describing it.
      */
      if (screen === "clear") {
        newConversation();
        return true;
      }
      show(screen);
      return true;
    };
  });

  /** Saving closes the dialog it was saved from. */
  const saveSettings = useCallback(
    (next: AgentSettings, quiet?: boolean) => void persist(next, quiet).then(() => setDialog(null)),
    [persist]
  );

  const openProject = useCallback(
    (root: string) => {
      const next = rememberProject(projects, root);
      setProjects(next);
      saveProjects(next);
      setActiveRoot(normalizeDir(root.trim()));
      // A new folder is a new conversation, not the same one re-rooted:
      // every path in the transcript above would now mean somewhere else.
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

  const dropFolder = useCallback(
    (dir: string) => {
      if (!activeRoot) return;
      const next = removeExtraDir(projects, activeRoot, dir);
      setProjects(next);
      saveProjects(next);
    },
    [activeRoot, projects]
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

    /*
      Said once, because half of it is immediate and half is not.

      The tools read the workspace per turn, so the folder is
      readable from the next message. The *prompt* that names the
      folders is frozen with the conversation, like the rules file —
      so a model mid-conversation can use the folder when told about
      it and will not volunteer that it exists.
    */
    if (session.blocks.length > 0) {
      notice({
        tone: "info",
        title: `${collapseHome(picked)} is reachable now`,
        body: "Tools can read and edit there from your next message. It is named in the prompt from the next conversation, so say so if you want it looked at.",
      });
    }
  }, [activeRoot, notice, projects, session.blocks.length]);

  /* ─── Settings ─────────────────────────────────────────────────────────── */

  /* ─── Keyboard ─────────────────────────────────────────────────────────── */

  /**
   * What Escape means, in order: the closest thing first.
   *
   * One function because there are two ways in. The window's own
   * handler fires when focus is inside it, and a document listener
   * covers when it is not — which is most of the time while a turn is
   * running, since nobody holds the caret in the box for two minutes
   * while they watch. Escape not stopping the agent because the last
   * thing clicked was a tool row is the bug this exists for.
   */
  const escape = useCallback(() => {
    if (dialog) {
      setDialog(null);
      return;
    }
    if ((completion.items.length || completion.empty) && (completion.slashing || completion.mention)) {
      setText((t) => `${t} `);
      return;
    }
    if (session.live) {
      answer(session.live.prompt.denyIndex);
      return;
    }
    if (shell) {
      setShell(false);
      setText("");
      return;
    }
    if (session.running) {
      interrupt();
      return;
    }
    onClose();
  }, [
    answer,
    dialog,
    interrupt,
    completion.mention,
    onClose,
    completion.items.length,
    completion.empty,
    session.live,
    session.running,
    shell,
    completion.slashing,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey;

      /*
        A text field owns its own keys.

        This handler claims Enter, Tab, the arrows and `!` on behalf of the
        composer, and the event reaches it by bubbling — so without this,
        typing an API key containing `!` flipped the window into shell
        mode, and Enter in the settings form did nothing at all. Escape
        still gets through, because leaving the screen is the window's
        business rather than the field's.
      */
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && e.key !== "Escape") return;

      if (e.key === "Escape") {
        stop();
        escape();
        return;
      }

      if (e.key === "Tab" && e.shiftKey && bare) {
        stop();
        const chord = session.live?.prompt.options.findIndex((o) => o.chord === "shift+tab") ?? -1;
        if (session.live && chord >= 0) answer(chord);
        else setMode(cycleMode);
        return;
      }

      if (e.key === "Tab" && bare && completion.items.length) {
        stop();
        complete(completion.at);
        return;
      }

      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare) {
        const delta = e.key === "ArrowDown" ? 1 : -1;
        if (completion.items.length) {
          stop();
          setPopupIndex((i) => (completion.items.length + Math.min(i, completion.items.length - 1) + delta) % completion.items.length);
          return;
        }
        const count = session.live?.prompt.options.length ?? 0;
        if (count) {
          stop();
          setChoice((i) => (count + i + delta) % count);
        }
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && bare) {
        stop();
        if (completion.items.length) {
          complete(completion.at);
          return;
        }
        if (session.live) {
          answer(choice);
          return;
        }
        send(text);
        return;
      }

      if (session.live && !text && bare && /^[1-9]$/.test(e.key)) {
        const option = Number(e.key) - 1;
        if (option < session.live.prompt.options.length) {
          stop();
          answer(option);
        }
        return;
      }

      if (e.key === "!" && !shell && !text) {
        stop();
        setShell(true);
      }
    },
    [
      answer,
      choice,
      complete,
      interrupt,
      completion.mention,
      onClose,
      completion.items.length,
      completion.at,
      completion.empty,
      send,
      session.live,
      session.running,
      shell,
      completion.slashing,
      text,
      dialog,
    ]
  );

  /* ─── Window plumbing ──────────────────────────────────────────────────── */

  const { style, onDragStart, onResizeStart, place, reset } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  useBaseSlot(docked, place);

  const [frontZ, setFrontZ] = useState<number | null>(null);
  /*
    The base never joins the overlay stack.

    `claimFront` exists to answer "which of these windows is on top", and the
    base is not one of these windows — it is what they are on top of. Letting
    it claim a rank would put it above whatever was already open the moment it
    was clicked, which is every floating window, all of them.
  */
  const raise = useCallback(() => {
    if (docked) return;
    setFrontZ(claimFront("figy-code"));
  }, [docked]);
  useOverlayZSync("figy-code", setFrontZ);
  // Registered either way: the browser's native webview has to know this
  // rectangle is here whether it is the base or a window above it.
  useOverlayRect("figy-code", modalRef, visible);

  /*
    Escape, from wherever the focus happens to be.

    The window's own handler is a React `onKeyDown` on the modal, so it
    only fires while something inside it has focus. Clicking a tool row
    to read it, or the transcript to scroll, puts focus on the document
    — and then the key that stops the agent silently does nothing,
    which is exactly when somebody is reaching for it.

    Only when this window is the front overlay, and only for events
    that did not come from inside it: anything in the modal is the
    handler above's, and handling it twice would close a dialog *and*
    interrupt the turn behind it.
  */
  useEffect(() => {
    if (!visible && !docked) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalRef.current?.contains(e.target as Node)) return;
      // Not ours if something else is on top: the rank alone does not
      // say, because every open overlay has one. The base has no rank at
      // all, so it asks the other question — whether anything is above it.
      if (docked ? !noOverlayOpen() : !isFront("figy-code")) return;
      e.preventDefault();
      escape();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [docked, visible, escape]);

  useEffect(() => {
    if (docked) return;
    if (visible) {
      raise();
      return;
    }
    releaseFront("figy-code");
    setFrontZ(null);
  }, [docked, visible, raise]);

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

  useEffect(() => {
    if (visible) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible]);

  /*
    Follow the tail — but only if the reader is at it.

    Pinning unconditionally is the bug every streaming transcript ships
    with: scroll up to read what a tool returned and the next token drags
    you back to the bottom. So the window follows while you are within a
    few lines of the end, and offers to catch up when you are not.
  */
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [atBottom, session.blocks, session.live, session.running, session.status]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }, []);

  // The base is never hidden; that is what being the base means.
  if (!visible && !docked) return null;

  /* ─── Strings the chrome needs ─────────────────────────────────────────── */

  const title = conversationTitle(session.blocks);
  const label = activeRoot ? projectLabel(activeRoot) : "No folder";
  const hint = completion.mention
    ? "↑↓ choose · tab insert · esc close"
    : "↑↓ choose · ↵ or tab to complete · esc close";

  const placeholder = shell
    ? "Run a command — shown here, not sent to the model"
    : session.live
      ? "Answer above, or type to tell FigyCode something else"
      : configured
        ? "Ask FigyCode to change something, or explain it"
        : "Add a model in /model first";

  const modal = (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal={false}
      aria-label="FigyCode"
      className={`figy-modal pointer-events-auto flex flex-col overflow-hidden ${
        fullscreen || docked ? "rounded-none" : "rounded-xl"
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
      <header
        className={`figy-header flex items-center gap-2 px-2 select-none ${
          docked ? "" : "cursor-grab active:cursor-grabbing"
        }`}
        onPointerDown={docked ? undefined : onDragStart}
      >
        <div className="flex items-center gap-1.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          {docked && <PrimaryHome />}
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
          <span
            className={`figy-locator-conv truncate ${title ? "" : "idle"}`}
            title={title ?? undefined}
          >
            {title ?? "New conversation"}
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          {session.running && (
            <span
              className="figy-live-count mr-1.5"
              title={session.live ? "Waiting for your answer" : "A turn is in progress"}
            >
              <span className={`figy-dot ${session.live ? "" : "live"}`} />
              {session.live ? "waiting for you" : "running"}
            </span>
          )}

          {/*
            No window controls on the base. Minimize, maximize and close are
            all answers to "put this away", and the base is what is left when
            everything is put away — a close button here would empty the
            window, and a minimize would send it to a dock it cannot be
            restored over. Changing the base is a settings decision, which is
            where the control for it lives.
          */}
          {!docked && (
            <>
              <span className="figy-sep" />

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
            </>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="figy-body flex-1 min-h-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          // A few lines of slack: "at the bottom" should survive the
          // half-line a new paragraph adds under the cursor.
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          setAtBottom(gap < 72);
        }}
      >
        {session.blocks.length === 0 ? (
          <Welcome
            root={activeRoot}
            index={index}
            model={status.model}
            configured={configured}
            rules={rules}
            others={projects.filter((p) => p.root !== activeRoot).slice(0, 3)}
            earlier={past.length}
            onPick={openProject}
            onBrowse={() => setPickerOpen(true)}
            onConfigure={() => show("settings")}
            onResume={() => command("/resume")}
          />
        ) : (
          <div className="figy-transcript">
            {session.blocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                /*
                  A notice's chip is a sentence the user is sending, so
                  it goes through `send` like any other — "Carry on" is
                  a message, not a special path through the loop.
                */
                onAction={send}
              />
            ))}
          </div>
        )}
      </div>

      <div className="figy-bottom">
        {/*
          Only while there is something to catch up with. A button that is
          always there is a button nobody reads.
        */}
        {!atBottom && session.blocks.length > 0 && (
          <button type="button" className="figy-to-bottom" onClick={toBottom}>
            {session.running ? "Jump to the live answer" : "Jump to the end"} ↓
          </button>
        )}


        {/*
          What is waiting for the turn to end.

          Shown, because a message that was typed and did not appear is
          a message somebody thinks was lost — they will type it again,
          and then both go. The ✕ is there because the commonest reason
          to type ahead is to change your mind.
        */}
        {queued && (
          <div className="figy-queued">
            <span className="figy-queued-mark">↵</span>
            <span className="figy-queued-text">{queued.text}</span>
            <span className="figy-queued-note">sends when this finishes</span>
            <button
              type="button"
              className="figy-queued-drop"
              onClick={unqueue}
              title="Don't send this"
              aria-label="Don't send this"
            >
              ✕
            </button>
          </div>
        )}

        {session.live && (
          <PromptCard
            prompt={session.live.prompt}
            selected={choice}
            onSelect={setChoice}
            onChoose={answer}
          />
        )}

        {/*
          Not while it is waiting on you.

          The line said "Bash… 45s · 327 tokens · esc to interrupt"
          under a card asking whether Bash may run at all. Nothing
          was running, the seconds were counting the time somebody
          spent reading, and the one key the line offered meant
          something different from the key the card offered.
        */}
        {session.running && !session.live && (
          <RunningLine
            label={session.status}
            elapsed={formatElapsed(elapsed)}
            /* The provider's figure once it lands, the rough one until
               then — a meter that reads zero while text is pouring in is
               worse than an estimate. */
            tokens={formatTokens(session.usage?.output ?? session.streamed / 4)}
          />
        )}

        <CompletionPopup
          items={completion.items}
          selected={completion.at}
          hint={hint}
          empty={completion.empty}
          onSelect={setPopupIndex}
          onChoose={complete}
        />

        {/*
          What is running in the background, whether or not a turn is.

          Above the composer rather than in the status bar: it is the
          thing you check on the way to typing the next message, and a
          build you started is not a fact about the window.
        */}
        <BackgroundBar
          jobs={running}
          open={openJob}
          log={log}
          onOpen={setOpenJob}
          onStop={stopJob}
        />

        <Composer
          ref={inputRef}
          value={text}
          shell={shell}
          placeholder={placeholder}
          running={session.running}
          modeLabel={MODE_LABEL[mode]}
          modeTone={mode === "acceptEdits" ? "accept" : mode}
          /*
            Which model answers, beside the send button.

            It belongs here rather than in the status bar: it is part
            of composing a message — which model is about to read this
            — and the bar is where the window reports on itself.
            Setting a model *up* is still the dialog's job; this is for
            choosing between ones that are.
          */
          attachments={attachments}
          onFiles={addFiles}
          onRemoveFile={removeFile}
          modelPicker={
            <ModelPicker
              models={status.models}
              active={status.active}
              onPick={(id) => saveSettings(settingsFrom(status, { active: id }), true)}
              onManage={() => show("settings")}
            />
          }
          onChange={(value) => {
            setText(value);
            setCaret(inputRef.current?.caret() ?? value.length);
            setPopupIndex(0);
          }}
          onCaret={() => setCaret(inputRef.current?.caret() ?? 0)}
          onInsert={insert}
          onCycleMode={() => setMode(cycleMode)}
          onSend={() => send(text)}
          onStop={interrupt}
        />
      </div>

      <div className="figy-statusbar flex items-center gap-2 px-3 shrink-0">
        {activeRoot ? (
          <>
            <button
              className="figy-folder-button min-w-0"
              onClick={() => show("project")}
              title={`${activeRoot}\nWhat this project is, and what else it can reach`}
            >
              <FolderOpen size={10} className="figy-folder-icon shrink-0" />
              <span className="figy-folder-primary truncate">{collapseHome(activeRoot)}</span>
            </button>

            {/*
              The paths themselves are not here any more.

              A row of grey folder names was most of the bar's width,
              said nothing about what they were for, and could not be
              acted on. The count is in `/project`, beside everything
              else about the folder, where taking one back is possible.
            */}
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

        {/*
          Spend and cache hit rate, while they are being spent. The advantage
          of a window over a CLI, and the reason `agent/ledger.rs` exists:
          a hit rate reading zero across a long conversation is a bug you can
          see rather than one you find on the bill.
        */}
        {/*
          Two buttons, because they answer two questions. How full the
          window is leads to *what is filling it*; what the session has
          spent leads to the ledger. They used to be one button that
          went to the second, so the number people clicked and the
          thing they got were about different subjects.
        */}
        {session.usage?.contextPercent != null && (
          <button
            className="figy-status-right shrink-0"
            onClick={() => show("context")}
            title="What is filling the context window"
          >
            ctx {session.usage.contextPercent}%
          </button>
        )}

        <button
          className="figy-status-right shrink-0"
          onClick={() => show("usage")}
          title="This session's tokens and spend"
        >
          {session.usage ? `cache ${session.usage.hitRate}% · ` : ""}
          {formatCost(session.spent)}
        </button>

        {/*
          And the way in to everything else that is configured. Named,
          not just an icon: the gear alone is a guess, and the one
          thing a new window needs is the screen that makes it work.
        */}
        <button
          className={`figy-status-right figy-status-settings ${
            dialog === "settings" ? "on" : ""
          } shrink-0`}
          onClick={() => show("settings")}
          title="Models, keys, limits and the permission mode"
          aria-haspopup="dialog"
          aria-expanded={dialog === "settings"}
        >
          <Settings2 size={11} className="shrink-0" />
          <span>Settings</span>
        </button>

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

      {dialog === "settings" && (
        <SettingsDialog
          /* Remounted when what is stored changes, so the draft starts
             from the saved state rather than from whatever was on
             screen the last time it was opened. */
          key={`${status.models.length}|${status.active ?? ""}|${status.model}`}
          status={status}
          mode={mode}
          earlier={past.length}
          rules={rules?.name ?? null}
          onMode={setMode}
          onSave={saveSettings}
          onTest={() => agentTestRouter(SURFACE)}
          onCommand={command}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "resume" && (
        <ResumeDialog
          conversations={past}
          onResume={resume}
          onForget={forgetConversation}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "usage" && (
        <UsageDialog totals={totals ?? emptyTotals} onClose={() => setDialog(null)} />
      )}

      {dialog === "context" && (
        <ContextDialog context={context} onClose={() => setDialog(null)} />
      )}

      {dialog === "tools" && (
        <ToolsDialog
          tools={tools}
          /*
            The breakdown, for what the picker did on the last message
            — the one thing about it that cannot be seen anywhere
            else. `toolsView` is what reads it, so the window and the
            panel draw the same conclusion from it.
          */
          context={context}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "project" && (
        <ProjectDialog
          root={activeRoot}
          index={index}
          model={status.model}
          configured={configured}
          rules={rules}
          others={projects.filter((p) => p.root !== activeRoot).slice(0, 3)}
          earlier={past.length}
          extraDirs={extraDirs}
          counts={dirCounts}
          onPick={openProject}
          onBrowse={() => setPickerOpen(true)}
          onConfigure={() => show("settings")}
          onResume={() => command("/resume")}
          onAddDir={() => void addFolder()}
          onRemoveDir={dropFolder}
          onClose={() => setDialog(null)}
        />
      )}

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
        There is no backdrop, only a layer that places the window. A click
        outside must not dismiss — a conversation is work in progress — and
        a sheet that merely stops dismissing swallows every click instead,
        which leaves the app behind it looking broken.
      */}
      <div
        className={`fixed inset-0 pointer-events-none ${
          docked ? "" : "flex items-start justify-center pt-[6vh]"
        }`}
        // The base is placed by `useBaseSlot` rather than by this layer, so it
        // needs no centring — and it takes a constant z below the stack, since
        // it has no rank of its own to paint at.
        style={{ zIndex: docked ? BASE_SLOT_Z : (frontZ ?? undefined) }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}

const emptyTotals: Totals = {
  turns: 0,
  input: 0,
  cached: 0,
  output: 0,
  costUsd: 0,
  toolCostUsd: 0,
  hitRate: 0,
  largestToolResult: 0,
};
