import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MakePrimary, PrimaryHome } from "../AppShell/PrimaryChrome";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  History,
  Maximize2,
  Minimize2,
  PanelLeft,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import {
  fullscreenRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { useOverlayRect } from "../../hooks/useOverlayRect";
import { BASE_SLOT_Z, useBaseSlot } from "../../hooks/useBaseSlot";
import { useClaudeStore } from "../../stores/claudeStore";
import {
  addDirCommand,
  alreadyCovered,
  ClaudeProject,
  Conversation,
  conversationTitle,
  normalizeFolder,
  projectName,
  ungrantedDirs,
} from "../../services/claude-project";
import { ClaudeProbe, conversationTitleFromDisk, probeClaude } from "../../services/claude";
import { collapseHome } from "../../services/recent-dirs";
import { isMac } from "../../services/platform";
import {
  ClaudeChrome,
  loadClaudeChrome,
  NAV_WIDTH,
  saveClaudeChrome,
} from "../../services/claude-session";
import { ClaudeSetup } from "./ClaudeSetup";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryPicker, useFolderHistory } from "./HistoryPicker";
import { ClaudeNavigator } from "./ClaudeNavigator";
import { ClaudeSurface } from "./ClaudeSurface";
import { ProjectPicker } from "./ProjectPicker";

/**
 * The Claude Code window.
 *
 * A frame around the real CLI. Figylo draws the chrome — projects,
 * conversations, the folders a conversation can reach — and everything inside
 * the body is Claude Code's own terminal interface, unmodified. See
 * `docs/CLAUDE-CODE.md` for why that division is the whole design.
 *
 * **The layout.** A title bar that says where you are, a navigator down the
 * left listing every open project with its conversations under it, the
 * terminal filling what is left, and a status bar stating what the current
 * conversation can reach. The navigator (`ClaudeNavigator`) is the whole of
 * the window's navigation: it replaced a project dropdown on the title bar and
 * a rail of conversation pills beneath it, which between them could never show
 * two projects at once — which is the only thing this window has that a
 * terminal tab with `claude` typed into it does not.
 *
 * **The one structural thing** worth knowing before reading the code: *every
 * conversation opened in this session stays mounted*, whichever project is on
 * screen. `opened` is that list, `ClaudeSurface` hides itself when it is not
 * the current one, and a conversation's pty is closed only when its surface
 * unmounts — which happens when the conversation is ended, and at no other
 * time. Switching project, closing the window and quitting the app are three
 * different things, and only the last of them stops anything.
 *
 * That is also why the handlers below take a project as a parameter rather than
 * reading the current one: the navigator can start, show and close a
 * conversation in a project that is not on screen, and each of those has to
 * bring its project forward first or the click lands somewhere invisible.
 */

/**
 * How long a conversation gets to exit on its own after being asked to.
 *
 * Closing a project sends `/exit` to each of its live conversations rather than
 * pulling the pty out from under them: Claude Code knows how to shut itself
 * down, and letting it is the difference between a clean stop and a hangup
 * mid-write. The deadline is what stops that being a promise — a conversation
 * busy enough not to read its input is taken down anyway, the same
 * ask-then-insist shape `lsp/server.rs` and `git_network` already use here.
 */
const GRACEFUL_EXIT_MS = 1500;

const DEFAULT_SIZE = { w: 1000, h: 680 };
const MIN_SIZE = { w: 520, h: 360 };
const MAX_SIZE = { w: 2400, h: 1600 };

/** One mounted conversation, and which project it belongs to. */
interface OpenSurface {
  projectId: string;
  sessionId: string;
  /**
   * Bumped to start a second process for the same conversation.
   *
   * It is part of the surface's React key, so incrementing it unmounts the old
   * one — closing its pty and discarding its dead buffer — and mounts a fresh
   * one that resumes. Without it, resuming a conversation whose surface was
   * still on screen would do nothing at all: same key, same component, same
   * already-started guard.
   */
  generation: number;
}

interface ClaudeModalProps {
  visible: boolean;
  onClose: () => void;
  /** The focused pane's working directory, for a new project's folder. */
  cwd?: string;
  /**
   * This is the base: it fills the slot above the status bar, never moves and
   * cannot be put away. See `useBaseSlot`.
   */
  docked?: boolean;
  /** Counts ⌘W presses handed to this window; see the listener in `AppShell`. */
  closeTabRequest?: number;
  /**
   * How many conversations have a live process, whichever project they belong
   * to.
   *
   * Reported upwards rather than read from the store by `AppShell`, so the
   * quit prompt does not drag the project machinery into the startup bundle
   * for a window most sessions never open.
   */
  onLiveCountChange?: (count: number) => void;
  /**
   * How many conversations are waiting for the user right now.
   *
   * Reported upwards so the shell can say so while the window is closed —
   * which is the only time it matters, since a window you are looking at
   * already shows it on the tab.
   */
  onAttentionCountChange?: (count: number) => void;
  /** A file the editor asked to hand over; see the effect that consumes it. */
  mentionRequest?: ClaudeMentionRequest | null;
}

/** The token is what lets the same file be handed over twice. */
export interface ClaudeMentionRequest {
  path: string;
  token: number;
}

export function ClaudeModal({
  visible,
  onClose,
  cwd,
  closeTabRequest,
  onLiveCountChange,
  onAttentionCountChange,
  mentionRequest,
  docked = false,
}: ClaudeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [frontZ, setFrontZ] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const [probe, setProbe] = useState<ClaudeProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * The navigator's width and whether it is showing, remembered between
   * launches. Read once, written on a change — see `saveClaudeChrome`.
   */
  const [chrome, setChrome] = useState<ClaudeChrome>(loadClaudeChrome);
  /*
    Debounced, because `navWidth` changes once per pointer move while the
    divider is being dragged and `localStorage.setItem` is synchronous. The
    delay costs nothing — the value is only ever read at launch.
  */
  useEffect(() => {
    const timer = window.setTimeout(() => saveClaudeChrome(chrome), 250);
    return () => window.clearTimeout(timer);
  }, [chrome]);
  /**
   * Which projects on the bench are showing their conversations.
   *
   * Only ever consulted for the projects you are *not* in: the active one is
   * always expanded, because collapsing the project on screen would hide the
   * row that says which conversation you are reading.
   */
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  /** The navigator's *Earlier* section, which is collapsed until asked for. */
  const [historySectionOpen, setHistorySectionOpen] = useState(false);
  /** A project close waiting on the user, because work would be stopped by it. */
  const [pendingClose, setPendingClose] = useState<{ id: string; live: number } | null>(null);
  const [opened, setOpened] = useState<OpenSurface[]>([]);
  /**
   * The projects open right now — the working set.
   *
   * Its own state, and **not** derived from which projects have a running
   * conversation. The two are different questions. A project can be open with
   * nothing started in it yet (you opened it to look), and one can be closed
   * while the list still remembers it. This is the parallel-work list: what is
   * on the bench. `projects` in the store is the other thing entirely — every
   * project ever made, which the Projects modal lists and which outlives any
   * session.
   *
   * Seeded from the project that was open last time, so reopening the window
   * lands where you left it.
   */
  const [working, setWorking] = useState<string[]>(() => {
    const last = useClaudeStore.getState().activeProjectId;
    return last ? [last] : [];
  });
  /** Per conversation, the last `/add-dir` we typed into it. */
  const [sentNotes, setSentNotes] = useState<Record<string, string>>({});
  /**
   * Conversations that have rung the bell since you last looked at them.
   *
   * Only ever set for a conversation you are *not* watching: a bell from the
   * conversation on screen in an open window is something you have already
   * seen, and flagging it would make the mark meaningless.
   */
  const [attention, setAttention] = useState<Record<string, true>>({});

  const writeRef = useRef<Record<string, (text: string) => void>>({});
  const focusRef = useRef<Record<string, () => void>>({});

  const projects = useClaudeStore((s) => s.projects);
  const activeProjectId = useClaudeStore((s) => s.activeProjectId);
  const activeConversation = useClaudeStore((s) => s.activeConversation);
  /*
    Actions only — reactive state comes from the three selectors above.

    Taken once rather than through `useClaudeStore()`, which returns the whole
    state and so hands back a new object identity on *every* write. That object
    is a dependency of half the callbacks in this file, so subscribing to it
    would rebuild them, and re-run their effects, every time anything in any
    project changed. The action functions themselves are created once when the
    store is and never change.
  */
  const [store] = useState(() => useClaudeStore.getState());

  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  );

  // The base never joins the stack — there is nothing for it to be raised
  // above, and claiming a rank would put it over every open window.
  const raise = useCallback(() => {
    if (docked) return;
    setFrontZ(claimFront("claude"));
  }, [docked]);
  // A claim by any overlay renumbers the rest; this re-reads ours.
  useOverlayZSync("claude", setFrontZ);

  const {
    style: modalStyle,
    onDragStart,
    onResizeStart,
    place,
    reset,
  } = useDraggableModal({
    defaultSize: DEFAULT_SIZE,
    minSize: MIN_SIZE,
    maxSize: MAX_SIZE,
    elementRef: modalRef,
  });

  // Only in picture-in-picture is this a window rather than a modal with a
  // full-screen backdrop; see the note in `overlay-stack.ts`.
  useOverlayRect("claude", modalRef, docked);

  /*
    Back to a window's own geometry when something else takes the primary
    slot: centred, default size, not fullscreen. See `useBaseSlot`.
  */
  const undock = useCallback(() => {
    setFullscreen(false);
    reset();
  }, [reset]);

  useBaseSlot(docked, place, undock);

  useEffect(() => {
    /*
      Becoming the primary gives up the claim.

      A window that is promoted was in the overlay stack, and `if (docked)
      return` left its rank there — so the stack still believed a floating
      window was open and frontmost. `noOverlayOpen()` then said no for the
      primary's own Escape, and the browser went on hiding its native page
      behind a window that had become the thing underneath.
    */
    if (docked) {
      releaseFront("claude");
      setFrontZ(null);
      return;
    }
    if (visible) raise();
    else releaseFront("claude");
  }, [docked, visible, raise]);

  useEffect(() => () => releaseFront("claude"), []);

  // ─── Is it installed ──────────────────────────────────────────────────────

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      setProbe(await probeClaude());
    } catch (error) {
      setProbe({
        found: false,
        path: null,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    if (visible && !probe && !probing) void runProbe();
  }, [visible, probe, probing, runProbe]);

  // ─── Conversations ────────────────────────────────────────────────────────

  const conversations = project?.conversations ?? [];
  const currentSessionId = project ? activeConversation[project.id] ?? null : null;
  const current = conversations.find((c) => c.sessionId === currentSessionId) ?? null;

  const isOpen = useCallback(
    (sessionId: string) => opened.some((entry) => entry.sessionId === sessionId),
    [opened]
  );

  /**
   * Whether a conversation has a process behind it right now.
   *
   * Two facts, and both are needed: `endedAt` says the process reported itself
   * gone, and being mounted is what says there is one at all — a conversation
   * remembered from a previous launch has `endedAt` set and no surface, and one
   * closed by its ✕ has no surface either.
   */
  const isLive = useCallback(
    (conversation: Conversation) =>
      conversation.endedAt === null && isOpen(conversation.sessionId),
    [isOpen]
  );

  /** Where the current conversation sits, for the ordinal an untitled one uses. */
  const currentIndex = current ? conversations.indexOf(current) : 0;

  /* How this platform spells the chords the window's tooltips quote. */
  const modKey = isMac ? "⌘" : "Ctrl+";
  const navChord = isMac ? "⌘B" : "Ctrl+Shift+B";

  /**
   * Whether there is a surface on screen right now.
   *
   * False is the empty state, and it covers more than "no conversations": a
   * tab can exist without a process behind it — remembered from a previous
   * launch, or closed and reopened — and there is nothing to draw until one is
   * started.
   */
  const currentIsMounted = currentSessionId !== null && isOpen(currentSessionId);

  /**
   * This folder's conversations on disk, for the empty state's list.
   *
   * Read whenever the project changes rather than when the panel appears: it is
   * one directory listing, and having it already in hand is the difference
   * between a list and a flash of "Reading…" every time the last tab closes.
   */
  const history = useFolderHistory(
    project?.root ?? null,
    conversations.map((c) => c.sessionId)
  );

  /*
    Read by `onAttention`, which is handed to every surface and must not be
    rebuilt when the current conversation changes — a new identity there would
    restart nothing, but it would churn every mounted surface's props on every
    tab switch.
  */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const currentSessionRef = useRef(currentSessionId);
  currentSessionRef.current = currentSessionId;

  /** Looking at a conversation is what clears its mark. */
  useEffect(() => {
    if (!visible || !currentSessionId) return;
    setAttention((flags) => {
      if (!flags[currentSessionId]) return flags;
      const next = { ...flags };
      delete next[currentSessionId];
      return next;
    });
  }, [visible, currentSessionId]);

  /**
   * Brings a project to the front without disturbing anything running in it.
   *
   * Declared before everything that uses it rather than left to `openProject`
   * further down, and that is a hard requirement rather than a tidiness one: a
   * `useCallback` dependency array is evaluated *during* render, so listing a
   * `const` from further down the function body is a reference to a binding
   * that has not been initialised yet.
   */
  const surfaceProject = useCallback(
    (id: string) => {
      setWorking((ids) => (ids.includes(id) ? ids : [...ids, id]));
      // Guarded: `switchProject` bumps `lastUsedAt`, so calling it for the
      // project already on screen would reshuffle the recent list on every
      // click of a conversation.
      if (id !== activeProjectId) store.switchProject(id);
    },
    [activeProjectId, store]
  );

  const startNewConversation = useCallback(
    (target: ClaudeProject) => {
      /*
        Switch to it first.

        The navigator offers *New conversation* under every project it lists,
        not only the one on screen, and starting one in a project you are not
        looking at would spawn a process behind a surface that is hidden — the
        click would appear to do nothing at all.

        `surfaceProject` is a no-op for the project already current, which is
        the overwhelmingly common case and the one ⌘T takes.
      */
      surfaceProject(target.id);

      const conversation: Conversation = {
        sessionId: crypto.randomUUID(),
        title: "",
        startedAt: Date.now(),
        endedAt: null,
        // Recorded at launch, because this is what the *process* was granted —
        // a folder added to the project later is not retroactively granted to
        // a session already running.
        launchedWith: { root: target.root, extraDirs: [...target.extraDirs] },
      };
      store.startConversation(target.id, conversation);
      setOpened((entries) => [
        ...entries,
        { projectId: target.id, sessionId: conversation.sessionId, generation: 0 },
      ]);
    },
    [store, surfaceProject]
  );

  /**
   * Keeps a project's most recent conversation selected, without opening it.
   *
   * It deliberately does **not** start anything. An earlier version opened a
   * conversation the moment a project had none, which made the first tab
   * impossible to close — closing it emptied the list, which started another —
   * and meant the window began talking to Claude before being asked to.
   * Starting a conversation is now always something the user does.
   */
  useEffect(() => {
    if (!visible || !project || currentSessionId) return;
    const last = project.conversations[project.conversations.length - 1];
    if (last) store.selectConversation(project.id, last.sessionId);
  }, [visible, project, currentSessionId, store]);

  /**
   * Shows a conversation, in whichever project owns it.
   *
   * The project is a parameter now that the navigator lists more than one at a
   * time: clicking a conversation under a project you are not in switches to
   * that project and lands on that conversation, which is the whole point of
   * being able to see them.
   */
  const showConversation = useCallback(
    (target: ClaudeProject, conversation: Conversation) => {
      surfaceProject(target.id);
      store.selectConversation(target.id, conversation.sessionId);
      if (!isOpen(conversation.sessionId)) {
        setOpened((entries) => [
          ...entries,
          { projectId: target.id, sessionId: conversation.sessionId, generation: 0 },
        ]);
      }
    },
    [surfaceProject, store, isOpen]
  );

  /**
   * Closes a conversation's tab.
   *
   * One ✕, one meaning: the process is stopped if it is running, and the tab
   * goes away. It used to take two clicks — end, then forget — which read as a
   * close button that did nothing the first time.
   *
   * Nothing is destroyed by it. The conversation's transcript is the CLI's file
   * and stays where it is, so a closed conversation is still in *Earlier
   * conversations* and still resumes with its full history.
   */
  const closeConversation = useCallback(
    (target: ClaudeProject, conversation: Conversation) => {
      // Unmounting the surface is what closes the pty — see `ClaudeSurface`.
      setOpened((entries) =>
        entries.filter((entry) => entry.sessionId !== conversation.sessionId)
      );
      store.forgetConversation(target.id, conversation.sessionId);
    },
    [store]
  );

  /**
   * Starts a new process for a conversation that has ended, keeping the thread.
   *
   * `claude --resume <id>` replays the whole conversation into a fresh process,
   * so nothing is lost but the dead scrollback — and that is what the new xterm
   * is for. This is also the only route back for a conversation that ended
   * while its surface was on screen.
   */
  const resumeConversation = useCallback(
    (target: ClaudeProject, conversation: Conversation) => {
      surfaceProject(target.id);
      store.selectConversation(target.id, conversation.sessionId);
      setOpened((entries) => {
        const existing = entries.find((entry) => entry.sessionId === conversation.sessionId);
        if (!existing) {
          return [
            ...entries,
            { projectId: target.id, sessionId: conversation.sessionId, generation: 0 },
          ];
        }
        return entries.map((entry) =>
          entry.sessionId === conversation.sessionId
            ? { ...entry, generation: entry.generation + 1 }
            : entry
        );
      });
      // It is about to be running again, so it must stop being marked ended —
      // `ClaudeSurface` will say otherwise soon enough if the resume fails.
      store.restartConversation(target.id, conversation.sessionId);
    },
    [surfaceProject, store]
  );

  /** Opens a project: onto the bench, and on screen. */
  const openProject = surfaceProject;

  /**
   * Closes a project — takes it off the bench, and keeps it.
   *
   * Not the same as forgetting it: the project stays in the Projects list with
   * its folders and its history, and reopening it is one click. What closing
   * does end is the work in progress — its conversations are stopped, because
   * a project that is closed is not one you are working in. They resume with
   * their full history, like any other stopped conversation.
   *
   * Closing the last one is allowed and leaves the working set empty, which is
   * a state the window has a screen for rather than an edge case it avoids.
   */
  /*
    Read by the deadline that follows a project close, which fires long after
    the render that scheduled it.
  */
  const workingRef = useRef(working);
  workingRef.current = working;

  /** Pending graceful-close deadlines, so the window can be torn down safely. */
  const closeTimers = useRef<number[]>([]);
  useEffect(() => () => closeTimers.current.forEach(window.clearTimeout), []);

  /** Live conversations of one project, by session id. */
  const liveSessionsOf = useCallback(
    (projectId: string) =>
      opened
        .filter((entry) => entry.projectId === projectId)
        .filter((entry) => {
          const owner = projects.find((p) => p.id === entry.projectId);
          const conversation = owner?.conversations.find(
            (c) => c.sessionId === entry.sessionId
          );
          return conversation?.endedAt === null;
        })
        .map((entry) => entry.sessionId),
    [opened, projects]
  );

  /**
   * Takes a project off the bench and switches away from it.
   *
   * Only the visible half: the surfaces stay mounted for a moment longer so
   * their conversations can exit cleanly. See `closeWorkingProject`.
   */
  const retireProject = useCallback(
    (id: string) => {
      const remaining = working.filter((openId) => openId !== id);
      setWorking(remaining);
      // Computed out here rather than inside the updater: a state updater has
      // to be a pure function of the previous state, and this is a write to
      // another store.
      if (activeProjectId === id) {
        store.switchProject(remaining[remaining.length - 1] ?? null);
      }
    },
    [working, activeProjectId, store]
  );

  /**
   * Closes a project — takes it off the bench, and keeps it.
   *
   * Not the same as forgetting it: the project stays in the Projects list with
   * its folders and its history, and reopening it is one click. What closing
   * does end is the work in progress, and that is the part worth asking about
   * — so a project with a live conversation puts the question to the user
   * first, and nothing is stopped until they answer.
   *
   * Closing the last one is allowed and leaves the working set empty, which is
   * a state the window has a screen for rather than an edge case it avoids.
   */
  const closeWorkingProject = useCallback(
    (id: string) => {
      const live = liveSessionsOf(id);
      if (live.length > 0) {
        setPendingClose({ id, live: live.length });
        return;
      }
      retireProject(id);
      setOpened((entries) => entries.filter((entry) => entry.projectId !== id));
    },
    [liveSessionsOf, retireProject]
  );

  /**
   * Closes a project whose conversations are running, having been told to.
   *
   * Asks each one to `/exit` — Claude Code's own way out, which lets it finish
   * what it is writing and shut down rather than being hung up on — then takes
   * the window off the bench immediately, so the click feels like it worked,
   * and unmounts the surfaces once the deadline is up. Anything still alive
   * then has its pty closed, which is what unmounting does.
   */
  const confirmClose = useCallback(() => {
    if (!pendingClose) return;
    const { id } = pendingClose;
    setPendingClose(null);

    for (const sessionId of liveSessionsOf(id)) {
      writeRef.current[sessionId]?.("/exit\r");
    }

    retireProject(id);

    closeTimers.current.push(
      window.setTimeout(() => {
        // Unless it is back on the bench — reopening within the deadline is
        // unlikely, but unmounting a project the user has just returned to
        // would be a strange way to reward them for it. Read from a ref rather
        // than checked inside an updater: a state updater has to be a pure
        // function of the previous state.
        if (workingRef.current.includes(id)) return;
        setOpened((entries) => entries.filter((entry) => entry.projectId !== id));
      }, GRACEFUL_EXIT_MS)
    );
  }, [pendingClose, liveSessionsOf, retireProject]);

  /**
   * Forgets a project.
   *
   * Only ever offered when nothing is running in it — a live conversation is
   * the one thing that protects a project, because forgetting one whose pty is
   * alive would leave a process nothing can reach. Its ended tabs are dropped
   * with it, which unmounts their surfaces; the folders and every transcript
   * are untouched, so the work is all still on disk.
   */
  const forgetProject = useCallback(
    (id: string) => {
      setOpened((entries) => entries.filter((entry) => entry.projectId !== id));
      setWorking((ids) => ids.filter((openId) => openId !== id));
      store.forgetProject(id);
    },
    [store]
  );

  /**
   * Takes on a conversation that exists on disk but not in this project.
   *
   * Recorded with the project's *current* folder set as `launchedWith`, which
   * is what the resumed process will actually be given — we have no idea what
   * the original run was granted, and claiming otherwise in the folders strip
   * would be a lie about access.
   */
  const adoptConversation = useCallback(
    (sessionId: string, title: string | null) => {
      if (!project) return;
      store.startConversation(project.id, {
        sessionId,
        title: title ?? "",
        startedAt: Date.now(),
        endedAt: null,
        launchedWith: { root: project.root, extraDirs: [...project.extraDirs] },
      });
      setOpened((entries) => [
        ...entries,
        { projectId: project.id, sessionId, generation: 0 },
      ]);
    },
    [project, store]
  );

  /** ⌘W, routed here by `AppShell` while this window has the keyboard. */
  const lastCloseRequest = useRef(closeTabRequest);
  useEffect(() => {
    if (closeTabRequest === lastCloseRequest.current) return;
    lastCloseRequest.current = closeTabRequest;
    if (project && current) closeConversation(project, current);
  }, [closeTabRequest, project, current, closeConversation]);

  /**
   * Pending title lookups, so closing the window doesn't leave them firing.
   *
   * A conversation has no title until the user has said something, and nothing
   * tells us when that happens — the transcript is the CLI's file, written
   * whenever it likes. So the title is asked for twice on a delay and the tab
   * keeps its ordinal until one of them finds something.
   */
  const titleTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => titleTimers.current.forEach(clearTimeout), []);

  const onStarted = useCallback(
    (sessionId: string) => {
      const owner = useClaudeStore
        .getState()
        .projects.find((p) => p.conversations.some((c) => c.sessionId === sessionId));
      if (!owner) return;

      const ask = async () => {
        const title = await conversationTitleFromDisk(owner.root, sessionId);
        if (title) useClaudeStore.getState().setConversationTitle(owner.id, sessionId, title);
      };

      titleTimers.current.push(
        setTimeout(() => void ask(), 4000),
        setTimeout(() => void ask(), 20000)
      );
    },
    []
  );

  const onExited = useCallback(
    (sessionId: string) => {
      const owner = opened.find((entry) => entry.sessionId === sessionId);
      if (owner) store.endConversation(owner.projectId, sessionId);
    },
    [opened, store]
  );

  /** What the surface reports when Claude rings the bell. */
  const onAttention = useCallback(
    (sessionId: string) => {
      const watching =
        visibleRef.current &&
        sessionId === currentSessionRef.current &&
        document.hasFocus();
      if (watching) return;
      setAttention((flags) => (flags[sessionId] ? flags : { ...flags, [sessionId]: true }));
    },
    []
  );

  const onFailed = useCallback(
    (sessionId: string) => {
      const owner = opened.find((entry) => entry.sessionId === sessionId);
      if (owner) store.endConversation(owner.projectId, sessionId);
    },
    [opened, store]
  );

  // ─── Folders ──────────────────────────────────────────────────────────────

  /**
   * Adds a folder to the project, and offers it to the running conversation.
   *
   * The `/add-dir` is typed into the session, which means typing into the
   * user's prompt box — so it happens on an explicit click and says that it
   * happened. There is no way to know from out here whether the input line was
   * empty, and a surprising result should at least be an explicable one.
   */
  const addFolder = useCallback(async () => {
    if (!project) return;
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: project.root,
    });
    if (typeof picked !== "string") return;

    const folder = normalizeFolder(picked);
    if (alreadyCovered(project, folder)) return;

    store.addFolder(project.id, folder);

    const live = current && current.endedAt === null && isOpen(current.sessionId);
    if (live && current) {
      writeRef.current[current.sessionId]?.(addDirCommand(folder));
      store.grantFolder(project.id, current.sessionId, folder);
      setSentNotes((notes) => ({ ...notes, [current.sessionId]: folder }));
    }
  }, [project, store, current, isOpen]);

  /** Grants a folder the project has but this conversation was not started with. */
  const grantToConversation = useCallback(
    (folder: string) => {
      if (!project || !current) return;
      writeRef.current[current.sessionId]?.(addDirCommand(folder));
      store.grantFolder(project.id, current.sessionId, folder);
      setSentNotes((notes) => ({ ...notes, [current.sessionId]: folder }));
    },
    [project, current, store]
  );

  /**
   * A file handed over from the editor's tree — "Ask Claude about this".
   *
   * Arrives as a prop rather than an event, the way the editor takes a clicked
   * path: the window may never have been mounted when the request is made, and
   * an event fired at a component that does not exist yet is simply lost.
   * `AppShell` opens the window and hands the request down, so mounting and
   * delivery can't race.
   *
   * Typed in as an `@` mention and left there, unsent — what to ask about the
   * file is the user's to write, and a prompt we composed would be a guess.
   */
  const lastMention = useRef(mentionRequest?.token);
  useEffect(() => {
    if (!mentionRequest || mentionRequest.token === lastMention.current) return;
    lastMention.current = mentionRequest.token;

    const sessionId = currentSessionId;
    if (!sessionId || !project) return;

    const relative = relativeToRoot(project.root, mentionRequest.path);
    writeRef.current[sessionId]?.(`@${relative} `);
    focusRef.current[sessionId]?.();
  }, [mentionRequest, currentSessionId, project]);

  // ─── Window chrome ────────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) {
      setFullscreen(false);
      reset();
      return;
    }
    setFullscreen(true);
    const rect = fullscreenRect();
    place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
  }, [fullscreen, place, reset]);

  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen, place]);

  // ─── The navigator ────────────────────────────────────────────────────────

  /**
   * Whether the sidebar is on screen.
   *
   */
  const navVisible = chrome.navOpen;

  const toggleNav = useCallback(
    () => setChrome((current) => ({ ...current, navOpen: !current.navOpen })),
    []
  );

  const toggleBench = useCallback(
    () => setChrome((current) => ({ ...current, benchOpen: !current.benchOpen })),
    []
  );

  /**
   * Puts the project section back when something has to appear in it.
   *
   * Opening a project from the picker, or making one, while the section is
   * collapsed would otherwise land it somewhere the user cannot see, and the
   * click would read as having failed. Deliberately *not* wired into
   * `surfaceProject`, which ⌘1–⌘9 also goes through: switching conversation is
   * not a reason to reopen a list you put away.
   */
  const revealBench = useCallback(
    () => setChrome((current) => (current.benchOpen ? current : { ...current, benchOpen: true })),
    []
  );

  const toggleProjectExpanded = useCallback((id: string) => {
    setExpandedProjects((flags) => ({ ...flags, [id]: !flags[id] }));
  }, []);

  /**
   * Dragging the divider between the navigator and the terminal.
   *
   * Pointer capture rather than window listeners, for the reason every other
   * drag in this app uses it: the pointer leaves a 4px strip immediately, and a
   * capture is what keeps the moves coming to the element that started it.
   */
  const onNavResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const handle = e.currentTarget as HTMLElement;
      const startX = e.clientX;
      const startWidth = chrome.navWidth;
      handle.setPointerCapture(e.pointerId);

      const move = (event: PointerEvent) => {
        const next = Math.round(
          Math.min(
            NAV_WIDTH.max,
            Math.max(NAV_WIDTH.min, startWidth + event.clientX - startX)
          )
        );
        setChrome((current) =>
          current.navWidth === next ? current : { ...current, navWidth: next }
        );
      };
      const finish = () => {
        handle.releasePointerCapture?.(e.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    },
    [chrome.navWidth]
  );

  const liveCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of opened) {
      const owner = projects.find((p) => p.id === entry.projectId);
      const conversation = owner?.conversations.find((c) => c.sessionId === entry.sessionId);
      if (conversation && conversation.endedAt === null) {
        counts[entry.projectId] = (counts[entry.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [opened, projects]);

  /**
   * The bench, resolved to projects and in the order they were opened.
   *
   * A project forgotten from the Projects modal disappears from here too, which
   * is why this filters rather than assuming every id still resolves.
   */
  const workingProjects = useMemo(
    () =>
      working
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is ClaudeProject => p !== undefined),
    [working, projects]
  );

  /** Pinned first, then by how recently they were used. */
  const recentProjects = useMemo(
    () =>
      [...projects].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsedAt - a.lastUsedAt
      ),
    [projects]
  );

  const liveTotal = useMemo(
    () => Object.values(liveCounts).reduce((total, count) => total + count, 0),
    [liveCounts]
  );

  useEffect(() => {
    onLiveCountChange?.(liveTotal);
  }, [liveTotal, onLiveCountChange]);

  const attentionTotal = Object.keys(attention).length;

  useEffect(() => {
    onAttentionCountChange?.(attentionTotal);
  }, [attentionTotal, onAttentionCountChange]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Everything the CLI binds belongs to the CLI — Escape above all, which is
    // how a turn is interrupted. Only chords that are unambiguously the
    // window's are taken here.
    const mod = e.metaKey || e.ctrlKey;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (mod && e.key.toLowerCase() === "t" && !e.shiftKey) {
      take();
      if (project) startNewConversation(project);
    } else if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
      take();
      setPickerOpen(true);
    } else if (mod && e.key.toLowerCase() === "b" && e.shiftKey === !isMac) {
      /*
        The navigator, spelled the way the editor spells its file tree — ⌘B.

        Off macOS it asks for Shift as well, and that is not a style choice:
        `mod` is Ctrl there, and **Ctrl+B is Claude Code's own binding** for
        running a command in the background. Taking it would break the CLI this
        window exists to host, which is the one thing the design does not do.
        Ctrl+Shift+B opens the browser from the shell, and shadowing *that*
        while this window has the keyboard costs nothing — the browser is a
        chord away once you leave.
      */
      take();
      toggleNav();
    } else if (mod && !e.shiftKey && e.key >= "1" && e.key <= "9") {
      // The nth conversation of this project, which is the only way to switch
      // while the navigator is hidden — in picture-in-picture, above all.
      take();
      const target = conversations[Number(e.key) - 1];
      if (project && target) showConversation(project, target);
    }
  };

  const notInstalled = probe && !probe.found;
  const brokenInstall = probe?.found && !probe.version;

  return (
    <OverlayPortal>
      <div
        className={`overlay-layer fixed inset-0 ${
          docked
            ? "flex"
            : `z-[240] items-start justify-center pt-[4vh] ${visible ? "flex" : "hidden"}`
        }`}
        style={{ zIndex: docked ? BASE_SLOT_Z : (frontZ ?? undefined) }}
        onPointerDownCapture={raise}
        /*
          A click beside a window does not close it.

          These windows hold work in progress — a request in flight, a buffer
          with unsaved edits, a conversation mid-turn — and a backdrop that
          dismisses on a stray click is how that gets lost by reaching for the
          thing behind it. They close by their own button, by Escape, or not at
          all. FigyCode never did dismiss this way; now none of them do.

          The layer still has to swallow the click rather than let it fall
          through to whatever is underneath.
        */
        onMouseDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div
          ref={modalRef}
          tabIndex={-1}
          /*
            A window, and now it says so. Its own four dialogs have carried
            `role="dialog"` since they were written; the thing they open over
            was the one surface a screen reader was handed as an unlabelled
            div. The label names the project as well, because several of these
            states look alike from the outside.
          */
          role="dialog"
          aria-modal={false}
          aria-label={project ? `Claude Code — ${projectName(project)}` : "Claude Code"}
          className={`editor-modal claude-window overflow-hidden flex flex-col focus:outline-none ${
            fullscreen || docked ? "editor-fullscreen" : "rounded-xl"
          }`}
          style={modalStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          {/*
            The title bar.

            Three zones, each with one job: what this window is, where you are
            in it, and what the window itself can do. The middle one used to be
            a dropdown holding the whole project switcher, which made the title
            bar a control panel and left "where am I" to be inferred from it.
            The navigator took the switching; what is left here is a label —
            project › conversation, the way a breadcrumb reads — and the one
            button that reveals the thing that replaced it.
          */}
          <header
            className={`claude-header flex items-center gap-2 px-2 select-none ${
              docked ? "" : "cursor-grab active:cursor-grabbing"
            }`}
            onPointerDown={docked ? undefined : onDragStart}
          >
            <div
              className="flex items-center gap-1.5 shrink-0"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {docked && <PrimaryHome />}
              <button
                className={`claude-iconbtn ${navVisible ? "on" : ""}`}
                onClick={toggleNav}
                title={`${navVisible ? "Hide" : "Show"} the sidebar (${navChord})`}
                aria-label="Toggle sidebar"
                aria-pressed={navVisible}
              >
                <PanelLeft size={13} />
              </button>
              <span className="claude-mark">
                <img src="/claude-code.png" alt="" />
              </span>
              <span className="claude-brand-title">Claude Code</span>
            </div>

            <span className="claude-sep" />

            {/*
              Where you are: the project, then the conversation inside it.

              A label, not a menu — but the project half is still a button,
              because "take me to the list of these" is the one thing anyone
              tries to click on a breadcrumb, and a dead crumb that ignores the
              click is worse than no crumb.
            */}
            <div className="claude-locator flex items-center gap-1.5 flex-1 min-w-0">
              {project ? (
                <>
                  <button
                    className="claude-locator-project flex items-center gap-1.5 min-w-0"
                    onClick={() => setPickerOpen(true)}
                    onPointerDown={(e) => e.stopPropagation()}
                    title={`${project.root}\nAll projects (${modKey}P)`}
                  >
                    <FolderOpen size={11} className="shrink-0 opacity-70" />
                    <span className="truncate">{projectName(project)}</span>
                  </button>
                  <ChevronRight size={11} className="claude-locator-sep shrink-0" />
                  <span
                    className={`claude-locator-conv truncate ${current ? "" : "idle"}`}
                    title={current ? conversationTitle(current, currentIndex) : undefined}
                  >
                    {current ? conversationTitle(current, currentIndex) : "No conversation"}
                  </span>
                </>
              ) : (
                <span className="claude-locator-conv idle truncate">No project open</span>
              )}
            </div>

            <div
              className="flex items-center gap-0.5 shrink-0"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/*
                How much is running, everywhere — the one fact from the old
                dropdown that belongs on the title bar, because it is the only
                one that is still true when the navigator is hidden.
              */}
              {liveTotal > 0 && (
                <span
                  className="claude-live-count mr-1.5"
                  title={`${liveTotal} running ${
                    liveTotal === 1 ? "conversation" : "conversations"
                  }, across every open project`}
                >
                  <span className="claude-dot live" />
                  {liveTotal}
                </span>
              )}

              {/*
                No window controls on the base. Every one of these is an answer
                to "put this away", and the base is what is left when
                everything is put away. Changing it is a settings decision.
              */}
              {!docked && (
                <>
                  <span className="claude-sep" />

                  <MakePrimary id="claude-code" />
                  <button
                    className={`claude-iconbtn ${fullscreen ? "on" : ""}`}
                    onClick={toggleFullscreen}
                    title={fullscreen ? "Restore" : "Maximize"}
                    aria-label={fullscreen ? "Restore" : "Maximize"}
                    aria-pressed={fullscreen}
                  >
                    {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  </button>
                  <button
                    className="claude-iconbtn danger"
                    onClick={onClose}
                    title="Close — conversations keep running"
                    aria-label="Close"
                  >
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
          </header>

          {/*
            The navigator, and the terminal it sits beside.

            The split is the whole redesign: everything that is a *list* lives
            on the left, and the right-hand side is nothing but Claude Code's
            own screen — which is the division `docs/CLAUDE-CODE.md` argues for
            and which the old chrome kept breaking, a strip at a time.
          */}
          <div className="claude-main flex-1 min-h-0 flex">
            {navVisible && (
              <>
                <ClaudeNavigator
                  width={chrome.navWidth}
                  workingProjects={workingProjects}
                  recentProjects={recentProjects}
                  activeProjectId={activeProjectId}
                  activeConversation={activeConversation}
                  liveCounts={liveCounts}
                  attention={attention}
                  isLive={isLive}
                  expanded={expandedProjects}
                  onToggleExpanded={toggleProjectExpanded}
                  benchOpen={chrome.benchOpen}
                  onToggleBench={toggleBench}
                  history={history}
                  historyOpen={historySectionOpen}
                  onToggleHistory={() => setHistorySectionOpen((open) => !open)}
                  onAdopt={adoptConversation}
                  onOpenProject={openProject}
                  onCloseProject={closeWorkingProject}
                  onNewProject={() => {
                    revealBench();
                    setSetupOpen(true);
                  }}
                  onAllProjects={() =>
                    projects.length ? setPickerOpen(true) : setSetupOpen(true)
                  }
                  onShowConversation={showConversation}
                  onCloseConversation={closeConversation}
                  onNewConversation={startNewConversation}
                />
                <div
                  className="claude-nav-divider shrink-0"
                  onPointerDown={onNavResizeStart}
                  onDoubleClick={toggleNav}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the sidebar"
                  title="Drag to resize · double-click to hide"
                />
              </>
            )}

            {/* Body */}
            <div className="flex-1 min-w-0 relative claude-body">
              {probing && !probe && (
                <Centered>
                  <span className="claude-spinner" />
                  <span className="claude-empty-body">Looking for Claude Code…</span>
                </Centered>
              )}

              {notInstalled && (
                <Centered>
                  <span className="claude-medallion warn">
                    <AlertTriangle size={18} />
                  </span>
                  <span className="claude-empty-title">Claude Code isn’t installed</span>
                  <span className="claude-empty-body max-w-[460px] text-center">
                    Figylo runs the <code>claude</code> CLI; it doesn’t bundle one. Install it,
                    then check again — the search includes your login shell’s PATH, so a version
                    manager’s directory counts.
                  </span>
                  {probe?.error && <pre className="claude-error">{probe.error}</pre>}
                  <button
                    className="claude-btn primary"
                    onClick={() => void runProbe()}
                    disabled={probing}
                  >
                    <RotateCcw size={12} />
                    Check again
                  </button>
                </Centered>
              )}

              {brokenInstall && (
                <Centered>
                  <span className="claude-medallion warn">
                    <AlertTriangle size={18} />
                  </span>
                  <span className="claude-empty-title">Claude Code wouldn’t start</span>
                  <span className="claude-empty-body font-mono">{probe?.path}</span>
                  {probe?.error && <pre className="claude-error">{probe.error}</pre>}
                  <button className="claude-btn primary" onClick={() => void runProbe()}>
                    <RotateCcw size={12} />
                    Check again
                  </button>
                </Centered>
              )}

              {/*
                Nothing on the bench.

                Two quite different situations wearing one screen: there are no
                projects at all yet, or there are and none is open — which is
                where closing the last one lands, and it is a perfectly good place
                to be rather than an error. Both get the recent list, because in
                both cases the next thing to do is pick something.
              */}
              {probe?.found && probe.version && !project && !setupOpen && (
                <Centered>
                  <span className="claude-medallion">
                    <FolderOpen size={18} />
                  </span>
                  <span className="claude-empty-title">
                    {projects.length ? "Nothing open" : "No project yet"}
                  </span>
                  <span className="claude-empty-body max-w-[420px] text-center">
                    {projects.length
                      ? navVisible
                        ? "Pick one from the sidebar to carry on where you left off. Several can be open at once, and each keeps its own conversations running."
                        : "Open one to carry on where you left off. Several can be open at once, and each keeps its own conversations running."
                      : "A project is a folder Claude works in, plus any other folders it may reach. It takes the folder’s name."}
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {projects.length > 0 && (
                      <button className="claude-btn" onClick={() => setPickerOpen(true)}>
                        <FolderOpen size={12} />
                        All projects…
                      </button>
                    )}
                    <button
                      className="claude-btn primary"
                      onClick={() => {
                        revealBench();
                        setSetupOpen(true);
                      }}
                    >
                      <FolderPlus size={12} />
                      New project…
                    </button>
                  </div>
                </Centered>
              )}

              {/*
                A project with nothing open. Reached by closing the last tab, by
                switching to a project whose conversations all ended, and on the
                first launch after a restart — when the tabs are remembered but
                none of them has a process yet.
              */}
              {probe?.found && probe.version && project && !setupOpen && !currentIsMounted && (
                <Centered>
                  <span className="claude-medallion">
                    <img src="/claude-code.png" alt="" />
                  </span>
                  <span className="claude-empty-title">
                    {conversations.length ? "Nothing open" : "No conversation yet"}
                  </span>
                  <span className="claude-empty-body max-w-[420px] text-center">
                    {conversations.length
                      ? "Pick up where you left off, or start something new."
                      : `Claude will run in ${projectName(project)}, and can reach ${
                          project.extraDirs.length
                            ? `${project.extraDirs.length} other ${
                                project.extraDirs.length === 1 ? "folder" : "folders"
                              }`
                            : "nothing outside it"
                        }.`}
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {/*
                      The folder's history is in the navigator now, under the
                      project it belongs to — but it is worth one button here as
                      well. Opening a project with nothing running is exactly the
                      moment "what was I doing here last time" is the question,
                      and a section the user has not expanded is not an answer.
                    */}
                    <button className="claude-btn" onClick={() => setHistoryOpen(true)}>
                      <History size={12} />
                      Earlier conversations…
                    </button>
                    {current && (
                      <button
                        className="claude-btn"
                        onClick={() => resumeConversation(project, current)}
                      >
                        <RotateCcw size={12} />
                        Resume “{conversationTitle(current, currentIndex)}”
                      </button>
                    )}
                    <button
                      className="claude-btn primary"
                      onClick={() => startNewConversation(project)}
                    >
                      <Plus size={12} />
                      New conversation
                    </button>
                  </div>
                </Centered>
              )}

              {/*
                Every conversation opened this session, whichever project it
                belongs to. Mounted is running; only the current one is shown.
              */}
              {probe?.found &&
                probe.version &&
                opened.map((entry) => {
                  const owner = projects.find((p) => p.id === entry.projectId);
                  const conversation = owner?.conversations.find(
                    (c) => c.sessionId === entry.sessionId
                  );
                  if (!owner || !conversation) return null;
                  return (
                    <ClaudeSurface
                      key={`${entry.sessionId}#${entry.generation}`}
                      project={owner}
                      conversation={conversation}
                      visible={
                        visible &&
                        entry.projectId === activeProjectId &&
                        entry.sessionId === currentSessionId
                      }
                      program={probe.path as string}
                      onStarted={onStarted}
                      onExited={onExited}
                      onFailed={onFailed}
                      onAttention={onAttention}
                      writeRef={writeRef}
                      focusRef={focusRef}
                    />
                  );
                })}
            </div>
          </div>

          {/*
            The status bar: what this conversation can reach, and nothing else
            that competes with it. It reads left to right as one sentence —
            the folder it runs in, then every other folder it was granted.
          */}
          <div className="claude-folders flex items-center gap-2 px-3 shrink-0">
            {project ? (
              <>
                <FolderOpen size={10} className="claude-folder-icon shrink-0" />
                <span className="claude-folder-primary truncate" title={project.root}>
                  {collapseHome(project.root)}
                </span>

                {current?.launchedWith.extraDirs.map((dir) => (
                  <span
                    key={dir}
                    className="claude-chip shrink-0"
                    title={`${dir} — this conversation can reach it`}
                  >
                    {collapseHome(dir)}
                  </span>
                ))}

                {/*
                  Folders the project has but this conversation was never
                  granted: added while it was already running, or added from
                  another conversation.
                */}
                {current &&
                  ungrantedDirs(project, current).map((dir) => (
                    <button
                      key={dir}
                      className="claude-chip pending shrink-0"
                      onClick={() => grantToConversation(dir)}
                      title={`${dir} — not in this conversation yet. Sends /add-dir.`}
                    >
                      + {collapseHome(dir)}
                    </button>
                  ))}

                {current && sentNotes[current.sessionId] && (
                  <span className="claude-sent-note truncate">
                    sent <code>/add-dir {collapseHome(sentNotes[current.sessionId])}</code>
                  </span>
                )}

                {/*
                  Adding a folder, beside the folders it adds to.

                  It was an icon on the title bar, three zones away from the
                  only line in the window that says what Claude can reach. A
                  control belongs with the thing it changes, and here it also
                  gets to be a word rather than a glyph nobody could place.
                */}
                <button
                  className="claude-chip add shrink-0"
                  onClick={() => void addFolder()}
                  title="Add a folder Claude may also read and edit"
                >
                  <FolderPlus size={10} />
                  Add folder
                </button>
              </>
            ) : (
              <span className="claude-folder-primary">No folder</span>
            )}

            <div className="flex-1" />

            {/*
              A conversation whose process ended while you were watching it.
              Offered here rather than as a banner over the output, which would
              cover the last thing Claude said — and only while its dead buffer
              is still on screen, since the empty state offers the same thing
              when there is nothing to cover.
            */}
            {project && current && current.endedAt !== null && currentIsMounted && (
              <button
                className="claude-resume flex items-center gap-1.5 shrink-0"
                onClick={() => resumeConversation(project, current)}
                title="Start a new process and continue this conversation"
              >
                <RotateCcw size={10} />
                Resume
              </button>
            )}

            {/*
              The grip lives down here for the reason the editor's does: it
              needs somewhere nothing else is competing for the pointer — and
              it is a window's, so the primary has none: it is the size of the
              slot and there is nothing to resize it against.
            */}
            <div
              className={`editor-resize-handle ${docked ? "hidden" : ""}`}
              onPointerDown={onResizeStart}
              title="Resize"
              role="separator"
              aria-orientation="horizontal"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" className="editor-resize-icon">
                <path
                  d="M9 1L1 9M9 5L5 9"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          {/*
            Dialogs, over the whole window rather than over the terminal.

            They used to live inside the body, which was the only thing in the
            window with a positioning context. Now that the navigator takes a
            column of its own, a backdrop confined to the body would dim the
            terminal and leave a lit sidebar beside it — a modal you could still
            click behind. Here they cover everything, which is what "modal"
            means, and `.editor-modal` is `position: relative` so `inset-0`
            lands on the window's own edges.
          */}
          {setupOpen && (
            <ClaudeSetup
              suggestedRoot={cwd}
              onCancel={() => setSetupOpen(false)}
              onCreate={({ root, extraDirs, model, permissionMode }) => {
                setSetupOpen(false);
                const created = store.createProject(root, extraDirs, { model, permissionMode });
                setWorking((ids) => [...ids, created.id]);
              }}
            />
          )}

          {historyOpen && project && (
            <HistoryPicker
              root={project.root}
              known={project.conversations.map((c) => c.sessionId)}
              onResume={adoptConversation}
              onClose={() => setHistoryOpen(false)}
            />
          )}

          {pendingClose && (
            <ConfirmDialog
              question={`Close the project “${
                projects.find((p) => p.id === pendingClose.id)
                  ? projectName(projects.find((p) => p.id === pendingClose.id)!)
                  : "this project"
              }”?`}
              body={`${pendingClose.live} ${
                pendingClose.live === 1 ? "conversation is" : "conversations are"
              } still running. Closing asks ${
                pendingClose.live === 1 ? "it" : "them"
              } to exit. The project is kept, and every conversation resumes with its full history.`}
              confirmLabel="Close project"
              onConfirm={confirmClose}
              onCancel={() => setPendingClose(null)}
            />
          )}

          {pickerOpen && (
            <ProjectPicker
              projects={projects}
              activeProjectId={activeProjectId}
              liveCounts={liveCounts}
              onOpen={(id) => {
                revealBench();
                openProject(id);
              }}
              onNew={() => {
                revealBench();
                setSetupOpen(true);
              }}
              onForget={forgetProject}
              onTogglePinned={(id) => store.togglePinned(id)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}

/**
 * A path as the CLI would rather see it: relative to the folder it is running
 * in, since that is what its own `@` completion offers. Anything outside the
 * project stays absolute, which still works and is honest about where it is.
 */
function relativeToRoot(root: string | undefined, path: string): string {
  if (!root) return path;
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 px-6">
      {children}
    </div>
  );
}
