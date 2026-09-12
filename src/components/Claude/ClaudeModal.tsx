import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  History,
  Maximize2,
  Minimize2,
  PictureInPicture2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, releaseFront } from "../../services/overlay-stack";
import {
  fullscreenRect,
  pictureInPictureRect,
  useDraggableModal,
} from "../../hooks/useDraggableModal";
import { useOverlayRect } from "../../hooks/useOverlayRect";
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
import { ClaudeSetup } from "./ClaudeSetup";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryList, HistoryPicker, useFolderHistory } from "./HistoryPicker";
import { ClaudeSurface } from "./ClaudeSurface";
import { ProjectPicker } from "./ProjectPicker";

/**
 * The Claude Code window.
 *
 * A frame around the real CLI. FigyTerm draws the chrome — projects,
 * conversation tabs, the folders a conversation can reach — and everything
 * inside the body is Claude Code's own terminal interface, unmodified. See
 * `docs/CLAUDE-CODE.md` for why that division is the whole design.
 *
 * The one structural thing worth knowing before reading the code: **every
 * conversation opened in this session stays mounted**, whichever project is on
 * screen. `opened` is that list, `ClaudeSurface` hides itself when it is not
 * the current one, and a conversation's pty is closed only when its surface
 * unmounts — which happens when the conversation is ended, and at no other
 * time. Switching project, closing the window and quitting the app are three
 * different things, and only the last of them stops anything.
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
}: ClaudeModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [frontZ, setFrontZ] = useState<number | null>(null);
  const [pipMode, setPipMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const [probe, setProbe] = useState<ClaudeProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Project menu in the toolbar: the projects you are working in right now. */
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
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

  const raise = useCallback(() => setFrontZ(claimFront("claude")), []);

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
  useOverlayRect("claude", modalRef, visible && pipMode);

  useEffect(() => {
    if (visible) raise();
    else releaseFront("claude");
  }, [visible, raise]);

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

  const startNewConversation = useCallback(
    (target: ClaudeProject) => {
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
    [store]
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

  /** Shows a conversation, resuming its process if it had ended. */
  const showConversation = useCallback(
    (conversation: Conversation) => {
      if (!project) return;
      store.selectConversation(project.id, conversation.sessionId);
      if (!isOpen(conversation.sessionId)) {
        setOpened((entries) => [
          ...entries,
          { projectId: project.id, sessionId: conversation.sessionId, generation: 0 },
        ]);
      }
    },
    [project, store, isOpen]
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
    (conversation: Conversation) => {
      if (!project) return;
      // Unmounting the surface is what closes the pty — see `ClaudeSurface`.
      setOpened((entries) =>
        entries.filter((entry) => entry.sessionId !== conversation.sessionId)
      );
      store.forgetConversation(project.id, conversation.sessionId);
    },
    [project, store]
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
    (conversation: Conversation) => {
      if (!project) return;
      store.selectConversation(project.id, conversation.sessionId);
      setOpened((entries) => {
        const existing = entries.find((entry) => entry.sessionId === conversation.sessionId);
        if (!existing) {
          return [
            ...entries,
            { projectId: project.id, sessionId: conversation.sessionId, generation: 0 },
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
      store.restartConversation(project.id, conversation.sessionId);
    },
    [project, store]
  );

  /** Opens a project: onto the bench, and on screen. */
  const openProject = useCallback(
    (id: string) => {
      setWorking((ids) => (ids.includes(id) ? ids : [...ids, id]));
      store.switchProject(id);
    },
    [store]
  );

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
    if (current) closeConversation(current);
  }, [closeTabRequest, current, closeConversation]);

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

  const togglePip = useCallback(() => {
    if (pipMode) {
      setPipMode(false);
      reset();
      return;
    }
    setFullscreen(false);
    setPipMode(true);
    const rect = pictureInPictureRect();
    place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
  }, [pipMode, place, reset]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) {
      setFullscreen(false);
      reset();
      return;
    }
    setPipMode(false);
    setFullscreen(true);
    const rect = fullscreenRect();
    place({ x: rect.x, y: rect.y }, { w: rect.w, h: rect.h });
  }, [fullscreen, place, reset]);

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
    if (mod && e.key.toLowerCase() === "t" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (project) startNewConversation(project);
    } else if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setPickerOpen(true);
    }
  };

  const notInstalled = probe && !probe.found;
  const brokenInstall = probe?.found && !probe.version;

  return (
    <OverlayPortal>
      <div
        className={`fixed inset-0 z-[240] items-start justify-center pt-[4vh] ${
          visible ? "flex" : "hidden"
        } ${pipMode ? "editor-backdrop-pip" : ""}`}
        style={{ zIndex: frontZ ?? undefined }}
        onPointerDownCapture={raise}
        onMouseDown={(e) => {
          if (!pipMode && e.target === e.currentTarget) onClose();
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div
          ref={modalRef}
          tabIndex={-1}
          className={`editor-modal overflow-hidden shadow-2xl flex flex-col focus:outline-none ${
            pipMode ? "editor-pip" : ""
          } ${fullscreen ? "editor-fullscreen" : "rounded-xl"}`}
          style={modalStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          {/*
            Two rows, the way the browser's chrome is built: a tab strip that
            doubles as the title bar and drag handle, and a toolbar under it
            holding the thing the tabs belong to. Here that thing is the
            project — which is why the strip changes completely when you switch
            projects, and why the toolbar says which one you are in.
          */}
          <div
            className="browser-chrome browser-tabstrip claude-tabstrip flex items-center gap-1 px-2 pt-1.5 pb-0 select-none cursor-grab active:cursor-grabbing"
            onPointerDown={onDragStart}
          >
            <div className="browser-brand flex items-center gap-2 pl-1 pr-2.5 mr-1 pb-1.5 shrink-0">
              <img src="/logo.png" alt="" className="h-3.5 w-auto shrink-0" />
              <img src="/claude-code.png" alt="" className="claude-logo shrink-0" />
              <span className="browser-brand-title text-[11px] font-semibold whitespace-nowrap">
                Claude Code
              </span>
            </div>

            <div className="flex items-end gap-1 flex-1 min-w-0 overflow-x-auto browser-tabstrip-scroll">
              {conversations.map((conversation, index) => {
                const live = conversation.endedAt === null && isOpen(conversation.sessionId);
                const active = conversation.sessionId === currentSessionId;
                return (
                  <div
                    key={conversation.sessionId}
                    role="tab"
                    aria-selected={active}
                    className={`browser-tab claude-tab group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-t-lg shrink-0 max-w-[180px] ${
                      active ? "active" : ""
                    }`}
                    // The strip is the drag handle; a tab is not.
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <button
                      className="flex items-center gap-1.5 min-w-0 flex-1"
                      onClick={() => showConversation(conversation)}
                      title={
                        attention[conversation.sessionId]
                          ? "Waiting for you"
                          : live
                            ? "Running"
                            : "Not running — opening it resumes the conversation"
                      }
                    >
                      <span
                        className={`claude-dot shrink-0 ${live ? "live" : ""} ${
                          attention[conversation.sessionId] ? "wants-you" : ""
                        }`}
                      />
                      <span className="text-[11px] truncate">
                        {conversationTitle(conversation, index)}
                      </span>
                    </button>
                    <button
                      className="browser-tab-close editor-icon-btn p-0.5 rounded shrink-0"
                      onClick={() => closeConversation(conversation)}
                      title={live ? "Close — stops this conversation" : "Close"}
                      aria-label="Close conversation"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}

              {project && (
                <button
                  className="browser-btn editor-icon-btn p-1 rounded shrink-0 mb-1.5"
                  onClick={() => startNewConversation(project)}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="New conversation (⌘T)"
                  aria-label="New conversation"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>

            <div
              className="flex items-center gap-0.5 pl-1 pb-1.5 shrink-0"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                className="editor-icon-btn p-1 rounded"
                onClick={togglePip}
                title={pipMode ? "Leave picture-in-picture" : "Picture-in-picture"}
                aria-label="Picture in picture"
              >
                <PictureInPicture2 size={12} />
              </button>
              <button
                className="editor-icon-btn p-1 rounded"
                onClick={toggleFullscreen}
                title={fullscreen ? "Restore" : "Maximize"}
                aria-label={fullscreen ? "Restore" : "Maximize"}
              >
                {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button
                className="editor-icon-btn p-1 rounded"
                onClick={onClose}
                title="Close — conversations keep running"
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/*
            The toolbar. Where a browser puts the address of the page you are
            looking at, this puts the project the conversation is running in —
            it is the same question, and the same answer to "where am I?".
          */}
          <div className="browser-chrome browser-toolbar claude-toolbar relative flex items-center gap-1 px-2 py-1.5">
            <button
              className="claude-project-field flex items-center gap-2 min-w-0 flex-1 px-2.5 py-1 rounded-md"
              onClick={() => setProjectMenuOpen((open) => !open)}
              title={project ? project.root : "Choose a project"}
              aria-expanded={projectMenuOpen}
            >
              <FolderOpen size={12} className="shrink-0 opacity-60" />
              <span className="text-[11px] font-medium truncate">
                {project ? projectName(project) : "No project"}
              </span>
              {project && (
                <span className="claude-project-path text-[10px] truncate">
                  {collapseHome(project.root)}
                </span>
              )}
              <span className="flex-1" />
              <ChevronDown size={11} className="shrink-0 opacity-60" />
            </button>

            {/*
              What you are working on *right now*, and nothing else.

              The full list is a modal reached from "All projects…" and from the
              new-project button. This is the other question — you have three
              things on the go and want the one that is running — and answering
              both in one list would bury it. Every row here has a live
              conversation behind it; the current project is included even when
              it hasn't got one, because a switcher that can't show you where
              you are is disorienting.
            */}
            {projectMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-[15]"
                  onMouseDown={() => setProjectMenuOpen(false)}
                />
                <div className="claude-project-menu absolute left-2 right-2 top-full z-[16] mt-0.5 rounded-lg overflow-hidden">
                  <div className="claude-history-head flex items-center gap-2 px-3 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Working on
                    </span>
                    <span className="flex-1" />
                    <span className="text-[10px] claude-muted">
                      {workingProjects.length}{" "}
                      {workingProjects.length === 1 ? "project" : "projects"}
                    </span>
                  </div>
                  <div className="max-h-[240px] overflow-y-auto py-1">
                    {workingProjects.length === 0 && (
                      <div className="editor-workspace-empty px-3 py-4 text-center text-[11px]">
                        Nothing open. Pick one below.
                      </div>
                    )}
                    {workingProjects.map((row) => {
                      const live = liveCounts[row.id] ?? 0;
                      return (
                        <div
                          key={row.id}
                          className={`editor-workspace-item group flex items-center gap-2.5 px-3 py-1.5 ${
                            row.id === activeProjectId ? "current" : ""
                          }`}
                        >
                          <button
                            className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                            onClick={() => {
                              if (row.id !== activeProjectId) openProject(row.id);
                              setProjectMenuOpen(false);
                            }}
                            title={row.root}
                          >
                            <span className="w-3 shrink-0 flex items-center">
                              {row.id === activeProjectId && (
                                <Check size={11} className="editor-workspace-check" />
                              )}
                            </span>
                            <span className="flex flex-col min-w-0 flex-1">
                              <span className="text-[11px] truncate">{projectName(row)}</span>
                              <span className="editor-workspace-path text-[10px] truncate">
                                {collapseHome(row.root)}
                              </span>
                            </span>
                          </button>

                          {live > 0 && (
                            <span
                              className="claude-live-count text-[10px] shrink-0"
                              title={`${live} running ${
                                live === 1 ? "conversation" : "conversations"
                              }`}
                            >
                              <span className="claude-dot live" /> {live}
                            </span>
                          )}

                          {/*
                            Closes the project — takes it off the bench and
                            keeps it. Not a delete: it stays in Projects with
                            its folders and its history. What it does end is the
                            work in progress, which the title says outright
                            when there is any.
                          */}
                          <button
                            className="editor-workspace-remove p-1 rounded shrink-0"
                            onClick={() => closeWorkingProject(row.id)}
                            title={
                              live > 0
                                ? `Close — stops ${live} running ${
                                    live === 1 ? "conversation" : "conversations"
                                  }. The project is kept.`
                                : "Close — the project is kept in Projects"
                            }
                            aria-label={`Close ${projectName(row)}`}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    className="claude-menu-footer flex items-center gap-2 px-3 py-2 w-full text-left text-[11px]"
                    onClick={() => {
                      setProjectMenuOpen(false);
                      setPickerOpen(true);
                    }}
                  >
                    <FolderOpen size={11} className="opacity-60" />
                    All projects…
                  </button>
                </div>
              </>
            )}

            {project && (
              <>
                <button
                  className="browser-btn editor-icon-btn p-1.5 rounded shrink-0"
                  onClick={() => setHistoryOpen(true)}
                  title="Earlier conversations in this folder"
                  aria-label="Earlier conversations"
                >
                  <History size={13} />
                </button>
                <button
                  className="browser-btn editor-icon-btn p-1.5 rounded shrink-0"
                  onClick={() => void addFolder()}
                  title="Add a folder Claude may also reach"
                  aria-label="Add folder"
                >
                  <FolderPlus size={13} />
                </button>
              </>
            )}
            {/*
              Projects, not *new* project. The list is where both answers live:
              pick one you already have, or make one from its footer. Going
              straight to the setup dialog made "I want my other project" the
              long way round, which is the commoner of the two.

              With nothing to pick from yet there is no list to show, so the
              first project skips it.
            */}
            <button
              className="browser-btn editor-icon-btn p-1.5 rounded shrink-0"
              onClick={() => (projects.length ? setPickerOpen(true) : setSetupOpen(true))}
              title="Projects…"
              aria-label="Projects"
            >
              <Plus size={13} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 relative claude-body">
            {probing && !probe && (
              <Centered>
                <span className="text-[12px]">Looking for Claude Code…</span>
              </Centered>
            )}

            {notInstalled && (
              <Centered>
                <span className="text-[13px] font-semibold">Claude Code isn’t installed</span>
                <span className="text-[11px] claude-muted max-w-[520px] text-center">
                  FigyTerm runs the <code>claude</code> CLI; it doesn’t bundle one. Install it,
                  then check again — the search includes your login shell’s PATH, so a version
                  manager’s directory counts.
                </span>
                {probe?.error && <pre className="claude-error">{probe.error}</pre>}
                <button
                  className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px]"
                  onClick={() => void runProbe()}
                  disabled={probing}
                >
                  <RotateCcw size={11} className="inline mr-1.5 -mt-0.5" />
                  Check again
                </button>
              </Centered>
            )}

            {brokenInstall && (
              <Centered>
                <span className="text-[13px] font-semibold">Claude Code wouldn’t start</span>
                <span className="text-[11px] claude-muted">{probe?.path}</span>
                {probe?.error && <pre className="claude-error">{probe.error}</pre>}
                <button
                  className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px]"
                  onClick={() => void runProbe()}
                >
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
              <div className="absolute inset-0 flex flex-col items-center pt-[6vh] pb-5 px-6 gap-4 overflow-hidden">
                <div className="flex flex-col items-center gap-3 shrink-0">
                  <span className="text-[13px] font-semibold">
                    {projects.length ? "Nothing open" : "No project yet"}
                  </span>
                  <span className="text-[11px] claude-muted max-w-[460px] text-center">
                    {projects.length
                      ? "Open one to pick up where you left off — everything is where you left it. You can have several open at once."
                      : "A project is a folder Claude works in, plus any other folders it may reach. It takes the folder’s name."}
                  </span>
                  <button
                    className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px]"
                    onClick={() => setSetupOpen(true)}
                  >
                    <FolderPlus size={12} />
                    New project…
                  </button>
                </div>

                {projects.length > 0 && (
                  <div className="claude-history-panel flex flex-col flex-1 min-h-0 w-full max-w-[560px] rounded-lg overflow-hidden">
                    <div className="claude-history-head flex items-center gap-2 px-3.5 py-2 shrink-0">
                      <FolderOpen size={11} className="editor-palette-icon" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide">
                        Recent projects
                      </span>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto py-1">
                      {recentProjects.map((row) => (
                        <button
                          key={row.id}
                          className="editor-workspace-item flex items-center gap-2.5 px-3.5 py-2 w-full text-left"
                          onClick={() => openProject(row.id)}
                          title={row.root}
                        >
                          <span className="flex flex-col min-w-0 flex-1">
                            <span className="text-[12px] truncate">{projectName(row)}</span>
                            <span className="editor-workspace-path text-[10px] truncate">
                              {collapseHome(row.root)}
                            </span>
                          </span>
                          {row.conversations.length > 0 && (
                            <span className="claude-field-hint shrink-0">
                              {row.conversations.length}{" "}
                              {row.conversations.length === 1 ? "conversation" : "conversations"}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/*
              A project with nothing open. Reached by closing the last tab, by
              switching to a project whose conversations all ended, and on the
              first launch after a restart — when the tabs are remembered but
              none of them has a process yet.
            */}
            {probe?.found && probe.version && project && !setupOpen && !currentIsMounted && (
              <div className="absolute inset-0 flex flex-col items-center pt-[6vh] pb-5 px-6 gap-4 overflow-hidden">
                <div className="flex flex-col items-center gap-3 shrink-0">
                  <span className="text-[13px] font-semibold">
                    {conversations.length ? "Nothing open" : "No conversation yet"}
                  </span>
                  <span className="text-[11px] claude-muted max-w-[460px] text-center">
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
                  <div className="flex items-center gap-2">
                    {current && (
                      <button
                        className="editor-dialog-btn flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px]"
                        onClick={() => resumeConversation(current)}
                      >
                        <RotateCcw size={12} />
                        Resume “{conversationTitle(current, 0)}”
                      </button>
                    )}
                    <button
                      className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px]"
                      onClick={() => startNewConversation(project)}
                    >
                      <Plus size={12} />
                      New conversation
                    </button>
                  </div>
                </div>

                {/*
                  This folder's history, right here rather than behind a button.
                  Opening a project with nothing running is exactly the moment
                  "what was I doing here last time" is the question, and the
                  answer is more often one of these than a blank conversation.
                */}
                <div className="claude-history-panel flex flex-col flex-1 min-h-0 w-full max-w-[560px] rounded-lg overflow-hidden">
                  <div className="claude-history-head flex items-center gap-2 px-3.5 py-2 shrink-0">
                    <History size={11} className="editor-palette-icon" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">
                      Earlier in this folder
                    </span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto py-1">
                    <HistoryList
                      rows={history}
                      onPick={adoptConversation}
                      emptyLabel="No earlier conversations in this folder."
                    />
                  </div>
                </div>
              </div>
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
                onOpen={openProject}
                onNew={() => setSetupOpen(true)}
                onForget={forgetProject}
                onTogglePinned={(id) => store.togglePinned(id)}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </div>

          {/* Folders strip */}
          <div className="claude-folders flex items-center gap-2 px-3 shrink-0">
            {project ? (
              <>
                <span className="claude-folder-primary text-[10px] truncate" title={project.root}>
                  {collapseHome(project.root)}
                </span>

                {current?.launchedWith.extraDirs.map((dir) => (
                  <span
                    key={dir}
                    className="claude-chip text-[10px] shrink-0"
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
                      className="claude-chip pending text-[10px] shrink-0"
                      onClick={() => grantToConversation(dir)}
                      title={`${dir} — not in this conversation yet. Sends /add-dir.`}
                    >
                      + {collapseHome(dir)}
                    </button>
                  ))}

                {current && sentNotes[current.sessionId] && (
                  <span className="claude-sent-note text-[10px] truncate">
                    sent <code>/add-dir {collapseHome(sentNotes[current.sessionId])}</code>
                  </span>
                )}
              </>
            ) : (
              <span className="claude-folder-primary text-[10px]">No folder</span>
            )}

            <div className="flex-1" />

            {/*
              A conversation whose process ended while you were watching it.
              Offered here rather than as a banner over the output, which would
              cover the last thing Claude said — and only while its dead buffer
              is still on screen, since the empty state offers the same thing
              when there is nothing to cover.
            */}
            {current && current.endedAt !== null && currentIsMounted && (
              <button
                className="claude-resume flex items-center gap-1.5 text-[10px] shrink-0"
                onClick={() => resumeConversation(current)}
                title="Start a new process and continue this conversation"
              >
                <RotateCcw size={10} />
                Resume
              </button>
            )}

            {/*
              The grip lives down here for the reason the editor's does: it
              needs somewhere nothing else is competing for the pointer.
            */}
            <div
              className="editor-resize-handle"
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
      {children}
    </div>
  );
}
