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
 * Escape, in order: close a completion popup, answer "no" to a question,
 * come back from a screen, leave shell mode, interrupt the turn, close the
 * window. One meaning at a time, the innermost first.
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
  Settings2,
  X,
} from "lucide-react";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import { claimFront, isFront, releaseFront } from "../../services/overlay-stack";
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
  MODE_LABEL,
  cycleMode,
  modeAfterPlan,
  filterCommands,
  formatCost,
  formatElapsed,
  formatTokens,
  mentionAt,
  type Block,
  type Notice,
  type PermissionMode,
} from "../../services/figycode-blocks";
import {
  agentAnswer,
  agentApprove,
  agentCallTool,
  agentCancel,
  agentClear,
  agentConfigure,
  agentConversations,
  agentForgetConversation,
  agentResume,
  agentRules,
  agentSend,
  agentStatus,
  agentTools,
  agentUsage,
  onAgentEvent,
  type AgentSettings,
  type AgentStatus,
  type Conversation,
  type ProjectRules,
  type Totals,
} from "../../services/figycode-agent";
import {
  answerOf,
  applyEvent,
  emptySession,
  NONE_OF_THESE,
  pushUser,
  resumeSession,
  type SessionState,
} from "../../services/figycode-session";
import { BlockView } from "./FigyBlocks";
import { PromptCard } from "./FigyPrompt";
import {
  Composer,
  CompletionPopup,
  RunningLine,
  type ComposerHandle,
  type PopupItem,
} from "./FigyComposer";
import { ResumeDialog, UsageDialog, Welcome } from "./FigyScreens";
import { FigyProjects } from "./FigyProjects";
import { SettingsDialog } from "./FigySettings";
import { ModelPicker } from "./FigyModelPicker";

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

/**
 * Which dialog is over the transcript, if any.
 *
 * One at a time, by construction. They were a mixture of a dialog and
 * two body screens, which meant two different ways to be somewhere
 * else and two different ways back.
 */
type Dialog = "settings" | "resume" | "usage" | null;

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
  "You are FigyCode, a coding agent inside the FigyTerm terminal.",
  "",
  "You work in one project folder. Read before you edit: `edit` replaces exact text,",
  "so copy the lines from a `read` rather than retyping them. Prefer `grep` to find",
  "where something is and then `read` the range, rather than reading whole files.",
  "",
  "Be brief. The person is watching you work and will read one or two sentences",
  "between tool calls, not a report. Say what you are about to do when it is not",
  "obvious, and say what you found when it is surprising.",
  "",
  "Tool results are re-sent on every later turn, so ask for what you need and not",
  "more. Do not re-read a range you have already been given.",
  "",
  // The list is the only thing that keeps the model's own intent in the
  // prefix without restating it in prose every turn — but only if it
  // reaches for it, and a tool description alone is read once and
  // forgotten by turn nine.
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
const NOTHING_YET: AgentStatus = {
  hasKey: false,
  hasExaKey: false,
  active: null,
  model: "",
  models: [],
  path: "",
};

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

  /*
    One piece of state, reduced from the event stream. The reducer is pure
    and tested in `figycode-session.test.ts` — which is where the awkward
    parts live, because text arriving in forty pieces and a tool row filled
    in two seconds after it appears are not things anybody can click.
  */
  const [session, setSession] = useState<SessionState>(emptySession);
  const [choice, setChoice] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  /* ─── Session settings ─────────────────────────────────────────────────── */

  const [mode, setMode] = useState<PermissionMode>("ask");
  /*
    What the *backend* says it is set up with, not what this side believes.
    The window asks rather than deducing: a guess assembled from a key
    check and a local copy of the settings is a second source of truth for
    "can I send a message", and the one that refuses.
  */
  const [status, setStatus] = useState<AgentStatus>(NOTHING_YET);
  const [totals, setTotals] = useState<Totals | null>(null);
  /** The conversations this folder has had, for `/resume`. */
  const [past, setPast] = useState<Conversation[]>([]);
  /** What this project tells the agent, from its own `FIGY.md`. */
  const [rules, setRules] = useState<ProjectRules | null>(null);
  const configured = status.hasKey && !!status.model.trim();

  /* ─── The composer ─────────────────────────────────────────────────────── */

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [shell, setShell] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);

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

  /* ─── The file index behind @ ──────────────────────────────────────────── */

  const [index, setIndex] = useState<ProjectInfo | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [hits, setHits] = useState<FileHit[]>([]);

  /**
   * Index the folder once, when it is adopted.
   *
   * This is also what tells the backend which folder every tool resolves
   * against — `figy_open_project` sets the agent's root. The walk is the
   * slow part and it happens here rather than on the first `@`, so the
   * first mention is as quick as the twentieth.
   */
  useEffect(() => {
    if (!activeRoot) return;
    let alive = true;
    setIndex(null);
    setIndexError(null);
    setHits([]);
    openProjectIndex(activeRoot)
      .then((info) => {
        if (alive) setIndex(info);
      })
      .catch((error: unknown) => {
        if (alive) setIndexError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [activeRoot]);

  /* ─── The agent ────────────────────────────────────────────────────────── */

  /**
   * One subscription for the window's whole life.
   *
   * Not per turn: the backend emits to the window, and a listener added on
   * send and removed on finish would miss the events of a turn that is
   * still arriving when the next one starts.
   */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    onAgentEvent((event) => setSession((state) => applyEvent(state, event))).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  /*
    Asked, not remembered. The settings live in one file owned by the
    backend; a copy on this side would be a second answer to "which model"
    and the two would disagree the first time one of them failed to save.
  */
  useEffect(() => {
    if (!visible) return;
    void agentStatus()
      .then(setStatus)
      .catch(() => {});
  }, [visible]);

  /*
    What this folder was working on before.

    Loaded when the window opens on a project rather than when `/resume`
    is typed, because the count is wanted on the first screen: a command
    nobody knows about is a feature nobody has. The list itself is
    refreshed by `/resume`, so opening the screen never shows a stale one.
  */
  useEffect(() => {
    if (!visible || !activeRoot) return;
    let alive = true;
    agentConversations(SURFACE)
      .then((conversations) => {
        if (alive) setPast(conversations);
      })
      .catch(() => {});
    // Read live rather than from the session: this says what the *next*
    // conversation will be given, and a running one keeps what it
    // started with.
    agentRules()
      .then((found) => {
        if (alive) setRules(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, activeRoot]);

  /*
    A new question starts on its first option.

    The cursor is window state and the question is the backend's, so
    without this the second prompt of a turn opens with the cursor
    wherever the first one left it — which on an edit card is "No".
  */
  useEffect(() => setChoice(0), [session.live?.id]);

  // The elapsed counter, which only has to tick while something is running.
  useEffect(() => {
    if (!session.running) return;
    const tick = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(tick);
  }, [session.running, startedAt]);

  const notice = useCallback((notice: Notice) => {
    setSession((state) => ({
      ...state,
      blocks: [...state.blocks, { id: state.nextId, kind: "notice", notice }],
      nextId: state.nextId + 1,
    }));
  }, []);

  /* ─── Commands ─────────────────────────────────────────────────────────── */

  const newConversation = useCallback(() => {
    void agentCancel(SURFACE);
    void agentClear(SURFACE);
    setSession(emptySession());
    setDialog(null);
    setText("");
    setShell(false);
  }, []);

  /**
   * Picks a past conversation back up.
   *
   * The backend puts the session back under this window's key and hands
   * back the transcript; this side redraws it. What does not come back is
   * the diff on an edit row — the structured half of a tool's answer never
   * entered the conversation and is not stored, so a resumed edit shows
   * what it reported rather than the tinted before-and-after.
   */
  const resume = useCallback(
    (sessionId: string) => {
      void agentResume(SURFACE, sessionId)
        .then((conversation) => {
          setSession(resumeSession(conversation.messages, conversation.spentUsd));
          setDialog(null);
          setText("");
          setShell(false);
        })
        .catch((error: unknown) => {
          notice({
            tone: "error",
            title: "That conversation could not be opened",
            body: String(error),
          });
        });
    },
    [notice]
  );

  const forgetConversation = useCallback((sessionId: string) => {
    void agentForgetConversation(sessionId).then(() => {
      setPast((list) => list.filter((one) => one.sessionId !== sessionId));
    });
  }, []);

  const command = useCallback(
    (name: string) => {
      switch (name) {
        // `/settings` is unlisted and accepted, because it is what the
        // dialog is now and half of everybody will try it.
        case "/model":
        case "/settings":
          setDialog("settings");
          return;
        case "/usage":
          void agentUsage(SURFACE).then((totals) => {
            setTotals(totals);
            setDialog("usage");
          });
          return;
        case "/resume":
          void agentConversations(SURFACE).then((conversations) => {
            setPast(conversations);
            setDialog("resume");
          });
          return;
        case "/clear":
          newConversation();
          return;
        case "/tools":
          void agentTools().then((tools) => {
            /*
              The tokens matter more than the list. Every definition sits
              in the cached prefix of every request for the whole session,
              so "ten tools" is a fact about the window and "1.2k tokens
              before you have said anything" is a fact about the bill.
            */
            const json = JSON.stringify(tools.map((t) => t.schema));
            notice({
              tone: "info",
              title: `${tools.length} tools · ~${formatTokens(json.length / 4)} tokens of definitions`,
              body: tools.map((t) => `${t.name} (${t.class})`).join(" · "),
            });
          });
          return;
        default:
          notice({
            tone: "info",
            title: `No command ${name}`,
            body: "Try /model, /usage, /tools, /resume or /clear.",
          });
      }
    },
    [newConversation, notice]
  );

  /* ─── Sending ──────────────────────────────────────────────────────────── */

  const send = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;

      /*
        `!` runs one tool with no model and no permission prompt — the user
        typed the command, so there is nobody to ask. Its output does not
        enter the conversation: `agent/session.rs` owns the history, and a
        window that could append to it would be a second writer of the one
        thing that must stay append-only.
      */
      if (shell) {
        setText("");
        // Minted before the state update rather than from it: an event
        // arriving in between would bump `nextId`, and the row this
        // promise later looks for would be a different one.
        const callId = `local_${Date.now()}`;
        setSession((state) => ({
          ...state,
          blocks: [
            ...state.blocks,
            {
              id: state.nextId,
              kind: "tool",
              callId,
              tool: { kind: "bash", name: "Bash", target: value, running: true },
            },
          ],
          nextId: state.nextId + 1,
        }));
        void agentCallTool("bash", { cmd: value })
          .then((result) =>
            setSession((state) =>
              patchLocal(state, callId, result.text.split("\n").slice(1), false)
            )
          )
          .catch((error: unknown) =>
            setSession((state) => patchLocal(state, callId, [String(error)], true))
          );
        return;
      }

      setText("");
      if (value.startsWith("/")) {
        command(value.split(/\s+/)[0]);
        return;
      }

      if (!activeRoot) {
        notice({
          tone: "warn",
          title: "No folder open",
          body: "Choose one from the title bar first — every tool resolves against it.",
        });
        return;
      }
      setSession((state) => pushUser(state, value));
      setStartedAt(Date.now());
      setElapsed(0);

      // The promise resolves when the turn is over; everything worth
      // showing has already arrived as events by then.
      void agentSend(value, mode, SYSTEM_PROMPT, SURFACE)
        .catch(() => {
          /* The `failed` event already said so, in the transcript. */
        })
        .finally(() => void agentUsage(SURFACE).then(setTotals));
    },
    [activeRoot, command, mode, notice, shell]
  );

  /* ─── Answering a permission question ──────────────────────────────────── */

  const answer = useCallback(
    (optionIndex: number) => {
      const live = session.live;
      if (!live) return;

      /*
        Two things stop a run and they are drawn by the same card on
        purpose — here is the situation, here are the few ways out. They
        go back by different routes: a permission question is yes or no
        to the policy, and a question of the model's own is a sentence
        that lands in the conversation.
      */
      if (live.kind === "question") {
        const picked = live.prompt.options[optionIndex]?.label ?? NONE_OF_THESE;
        /*
          An approved plan lifts plan mode in the turn that proposed it.

          Both sides are told: the backend so the next tool in this turn
          is not refused, and this side so the footer agrees with what
          is actually happening.
        */
        const next = modeAfterPlan(picked);
        if (next) setMode(next);
        void agentAnswer(live.id, picked, SURFACE, next ?? undefined);
      } else {
        const { allow, remember, acceptEdits } = answerOf(live, optionIndex);
        if (acceptEdits) setMode("acceptEdits");
        // The mode goes with the answer rather than with the next
        // message: "allow all edits this session" that still asks two
        // tool calls later reads as a button that did not work.
        void agentApprove(
          live.id,
          allow,
          SURFACE,
          remember,
          acceptEdits ? "acceptEdits" : undefined
        );
      }
      setSession((state) => ({ ...state, live: null }));
      setChoice(0);
    },
    [session.live]
  );

  const interrupt = useCallback(() => {
    void agentCancel(SURFACE);
  }, []);

  /* ─── Projects ─────────────────────────────────────────────────────────── */

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

  const popupAt = popup.length ? Math.min(popupIndex, popup.length - 1) : 0;

  const popupEmpty = !mention
    ? null
    : !activeRoot
      ? "No folder open — choose one from the title bar"
      : indexError
        ? `Could not read that folder: ${indexError}`
        : !index
          ? "Indexing the folder…"
          : `Nothing matches “${mention.query}”`;

  const focusAt = useCallback((at: number) => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setCaret(at);
    });
  }, []);

  const complete = useCallback(
    (itemIndex: number) => {
      const item = popup[itemIndex];
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

  const insert = useCallback(
    (token: "@" | "/" | "!") => {
      if (token === "!") {
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

  /* ─── Settings ─────────────────────────────────────────────────────────── */

  const saveSettings = useCallback(
    (next: AgentSettings, quiet?: boolean) => {
      const before = status.active;
      void agentConfigure(next)
        .then((saved) => {
          setStatus(saved);
          setDialog(null);

          /*
            Switching model mid-conversation is allowed and is not free.

            The next message re-sends the whole history to a provider
            that has never seen it, so the first turn after this has no
            cache behind it at all. Said once, where it happens, rather
            than left to be noticed on the bill.
          */
          if (before && saved.active && saved.active !== before && session.blocks.length > 0) {
            notice({
              tone: "info",
              title: `Now using ${saved.model}`,
              body: "The next message re-sends this conversation to a provider that has not seen it, so that turn will not be cached. /clear starts fresh.",
            });
            return;
          }

          /*
            Switching model from the footer, with nothing said yet,
            needs no announcement: the picker already shows the new
            name, and a notice in an empty transcript is the first
            thing in a conversation being about the window.
          */
          if (quiet) return;
          /*
            Said out loud, because the commonest way this goes wrong is
            silent: a write that fails leaves a window that looks
            configured and a backend with no key.
          */
          notice(
            saved.hasKey
              ? {
                  tone: "info",
                  title: `Using ${saved.model}`,
                  // The path, every time. A key kept in plain text in a
                  // place nobody mentioned is worse than one in a place
                  // everybody knows about.
                  body: `${saved.models.length} model${
                    saved.models.length === 1 ? "" : "s"
                  } · settings and keys saved in ${saved.path}`,
                }
              : {
                  tone: "warn",
                  title: "Saved, but there is no key stored",
                  body: "The model and URL are set. Add a key in /model — nothing can be sent without one.",
                }
          );
        })
        .catch((error: unknown) =>
          notice({
            tone: "error",
            title: "That could not be saved",
            body: String(error),
          })
        );
    },
    [notice, session.blocks.length, status.active]
  );

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
    if ((popup.length || popupEmpty) && (slashing || mention)) {
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
    mention,
    onClose,
    popup.length,
    popupEmpty,
    session.live,
    session.running,
    shell,
    slashing,
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
        const count = session.live?.prompt.options.length ?? 0;
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
      mention,
      onClose,
      popup.length,
      popupAt,
      popupEmpty,
      send,
      session.live,
      session.running,
      shell,
      slashing,
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

  const [frontZ, setFrontZ] = useState<number | null>(null);
  const raise = useCallback(() => setFrontZ(claimFront("figy-code")), []);
  useOverlayZSync("figy-code", setFrontZ);
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
    if (!visible) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modalRef.current?.contains(e.target as Node)) return;
      // Not ours if something else is on top: the rank alone does not
      // say, because every open overlay has one.
      if (!isFront("figy-code")) return;
      e.preventDefault();
      escape();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [visible, escape]);

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

  if (!visible) return null;

  /* ─── Strings the chrome needs ─────────────────────────────────────────── */

  const title = conversationTitle(session.blocks);
  const label = activeRoot ? projectLabel(activeRoot) : "No folder";
  const hint = mention
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
          <span
            className={`figy-locator-conv truncate ${title ? "" : "idle"}`}
            title={title ?? undefined}
          >
            {title ?? "New conversation"}
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          {session.running && (
            <span className="figy-live-count mr-1.5" title="A turn is in progress">
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
            onConfigure={() => setDialog("settings")}
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

        {session.live && (
          <PromptCard
            prompt={session.live.prompt}
            selected={choice}
            onSelect={setChoice}
            onChoose={answer}
          />
        )}

        {session.running && (
          <RunningLine
            label={session.status}
            elapsed={formatElapsed(elapsed)}
            /* The provider's figure once it lands, the rough one until
               then — a meter that reads zero while text is pouring in is
               worse than an estimate. */
            tokens={formatTokens(session.usage?.output ?? session.streamed / 4)}
            background={null}
            onBackground={() => {}}
          />
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
          modelPicker={
            <ModelPicker
              models={status.models}
              active={status.active}
              onPick={(id) =>
                saveSettings(
                  { models: status.models, active: id, budgetUsd: status.budgetUsd },
                  true
                )
              }
              onManage={() => setDialog("settings")}
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
            <FolderOpen size={10} className="figy-folder-icon shrink-0" />
            <span className="figy-folder-primary truncate" title={activeRoot}>
              {collapseHome(activeRoot)}
            </span>

            {extraDirs.map((dir) => (
              <span key={dir} className="figy-chip-sm shrink-0" title={`${dir} — also reachable`}>
                {collapseHome(dir)}
              </span>
            ))}

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
        <button
          className="figy-status-right shrink-0"
          onClick={() => void agentUsage(SURFACE).then((t) => (setTotals(t), setDialog("usage")))}
          title="This session's tokens and spend"
        >
          {session.usage?.contextPercent != null && `ctx ${session.usage.contextPercent}% · `}
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
          onClick={() => setDialog("settings")}
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
        className="fixed inset-0 flex items-start justify-center pt-[6vh] pointer-events-none"
        style={{ zIndex: frontZ ?? undefined }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}

/** A `!` command's row, once it has finished. */
function patchLocal(
  state: SessionState,
  callId: string,
  output: string[],
  failed: boolean
): SessionState {
  const at = state.blocks.findIndex((b) => b.kind === "tool" && b.callId === callId);
  if (at < 0) return state;
  const block = state.blocks[at];
  if (block.kind !== "tool") return state;

  const blocks = [...state.blocks];
  blocks[at] = {
    ...block,
    tool: {
      ...block.tool,
      running: false,
      failed,
      meta: output[0] ?? "",
      output: output.length > 1 ? output : undefined,
    },
  };
  return { ...state, blocks };
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
