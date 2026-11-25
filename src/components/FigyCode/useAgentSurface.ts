/**
 * The agent chatbox, as a hook — everything both surfaces do.
 *
 * There are two front ends onto one backend: the FigyCode window and
 * the panel in the editor. They draw differently and they are offered
 * different tools, but the part in between — the reducer over the
 * event stream, what `@` and `/` complete to, how a picture becomes an
 * attachment, what Enter means while a permission card is up, which
 * notice a failed save produces — is one behaviour, and it was written
 * once for the window.
 *
 * This is that code, moved rather than rewritten. Copying it would
 * have been quicker by an afternoon and wrong by the first change to
 * either copy: two chatboxes that are *almost* the same is how the
 * window's `@` grows a fix the panel's never gets.
 *
 * ## What is not in here
 *
 * Anything that is about being a window or being a column. Dialogs,
 * dragging, fullscreen, the project list in `localStorage`, the title
 * bar, the welcome screen — those differ by surface and belong to the
 * component. The rule is that this file never decides how anything
 * looks; it decides what happens.
 *
 * ## Per surface, not per window
 *
 * Every backend call here carries `surface`, including the event
 * subscription. The editor is a modal inside the *same* Tauri window
 * as FigyCode, so both trees hear the same emitter — the surface in
 * the channel's name is what keeps the panel from drawing the
 * window's tool rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { attach, imageMentions, type Attachment } from "../../services/figycode-attach";
import {
  findFiles,
  hitMeta,
  openProjectIndex,
  readImage,
  type FileHit,
  type ProjectInfo,
} from "../../services/figycode-files";
import {
  filterCommands,
  mentionAt,
  modeAfterPlan,
  type Notice,
  type PermissionMode,
} from "../../services/figycode-blocks";
import {
  agentAnswer,
  agentApprove,
  agentBackground,
  agentBackgroundKill,
  agentBackgroundOutput,
  agentCallTool,
  agentCancel,
  agentClear,
  agentConfigure,
  agentContext,
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
  type ContextBreakdown,
  type Conversation,
  type ProjectRules,
  type BackgroundJob,
  type Surface,
  type ToolInfo,
  type Totals,
} from "../../services/figycode-agent";
import {
  backgroundLabel,
  finishedSince,
  mine,
  outcomeOf,
  reportOf,
  stillRunning,
} from "../../services/figycode-background";
import {
  answerOf,
  applyEvent,
  emptySession,
  NONE_OF_THESE,
  pushUser,
  resumeSession,
  type SessionState,
} from "../../services/figycode-session";
import type { ComposerHandle, PopupItem } from "./FigyComposer";

/** What the backend says before it has been asked. */
export const NOTHING_YET: AgentStatus = {
  hasKey: false,
  hasExaKey: false,
  router: false,
  hasRouterKey: false,
  active: null,
  model: "",
  models: [],
  path: "",
};

export interface AgentSurfaceOptions {
  surface: Surface;
  /**
   * The preamble. Frozen per surface: order on the wire is
   * `tools → system → messages` and caching is a prefix match, so a
   * preamble that varied would rewrite the cache on the turn it
   * varied.
   */
  system: string;
  /** The folder every tool resolves against. */
  root: string | null;
  /** Nothing is fetched while the surface is off screen. */
  active: boolean;
  /**
   * Whether `!` puts the box in shell mode.
   *
   * The panel is not offered `bash`, so a shell prompt there would be
   * a box that accepts a command and then reports that the tool does
   * not exist.
   */
  shell?: boolean;
  /**
   * Commands the surface handles itself — `/model` opens a dialog in
   * the window and a compact list in the panel. Return `true` when it
   * was handled; anything else falls through to the shared ones.
   */
  onCommand?: (name: string) => boolean;
  /** What an unknown command suggests instead. */
  commandHint: string;
  /**
   * What to say when there is no folder, which is not the same
   * sentence on both surfaces: the window has a title bar to choose
   * one from and the panel is told its folder by the editor. `short`
   * goes under an empty `@`, `long` in the notice a message gets
   * instead of being sent.
   */
  noFolder: { short: string; long: string };
}

/**
 * Where the caret is in a `/` or `@`, and what to offer.
 *
 * Returned together because the three are read together by every
 * caller: whether to draw the popup, what is in it, and what to say
 * when it is empty.
 */
export interface Completion {
  items: PopupItem[];
  /** Clamped, because the list shortens under a cursor that does not. */
  at: number;
  /** Why the list is empty, or null when there is no mention at all. */
  empty: string | null;
  /** Whether a `/` command is being typed. */
  slashing: boolean;
  /** The `@` under the caret, if there is one. */
  mention: { query: string; start: number } | null;
}

/**
 * How much of a background job's log the window keeps on screen.
 *
 * A Docker build writes a few thousand lines; the interesting one is
 * always the last. Past a few hundred, a `<pre>` is a layout the
 * browser re-measures every second for text nobody is reading.
 */
const LOG_LINES = 400;

export function useAgentSurface(options: AgentSurfaceOptions) {
  const { surface, system, root, active, shell: shellAllowed = false, onCommand } = options;
  const inputRef = useRef<ComposerHandle>(null);

  /* ─── The conversation ─────────────────────────────────────────────────── */

  /*
    One piece of state, reduced from the event stream. The reducer is
    pure and tested in `figycode-session.test.ts` — which is where the
    awkward parts live, because text arriving in forty pieces and a
    tool row filled in two seconds after it appears are not things
    anybody can click.
  */
  const [session, setSession] = useState<SessionState>(emptySession);
  /*
    The live session, for callbacks that must not be rebuilt on every
    event of it. `send` reads `running` and nothing else from here —
    through state it would be a new function per streamed fragment,
    and every consumer would re-render with it.
  */
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [choice, setChoice] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  /* ─── Session settings ─────────────────────────────────────────────────── */

  const [mode, setMode] = useState<PermissionMode>("ask");
  /*
    What the *backend* says it is set up with, not what this side
    believes. Asked rather than deduced: a guess assembled from a key
    check and a local copy of the settings is a second source of truth
    for "can I send a message", and the one that refuses.
  */
  const [status, setStatus] = useState<AgentStatus>(NOTHING_YET);
  const [totals, setTotals] = useState<Totals | null>(null);
  /** What `/context` last read. Fetched when it opens, not kept live. */
  const [context, setContext] = useState<ContextBreakdown | null>(null);
  /** The conversations this folder has had, for `/resume`. */
  const [past, setPast] = useState<Conversation[]>([]);
  /** What this project tells the agent, from its own `FIGY.md`. */
  const [rules, setRules] = useState<ProjectRules | null>(null);
  /** The registry, for `/tools`. Loaded when it is asked for. */
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const configured = status.hasKey && !!status.model.trim();

  /* ─── The composer ─────────────────────────────────────────────────────── */

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /**
   * What was typed while a turn was still running.
   *
   * One message, not a list. Typing ahead is normal now that a turn
   * can legitimately sit for five minutes waiting on a build, and the
   * alternative to holding it was worse in both directions: sending it
   * forks the conversation (the backend refuses that outright, and
   * before it did, the two turns erased each other), and refusing it
   * throws away something somebody just wrote.
   *
   * One rather than a queue because a second thought replaces a first
   * one far more often than it follows it — and a backlog of four
   * messages firing at a model that has since done the work is a
   * conversation nobody can follow.
   */
  const [queued, setQueued] = useState<{ text: string; images: Attachment[] } | null>(null);
  /**
   * Finished background jobs the model has not been told about yet.
   *
   * Kept apart from `queued`, which is what a *person* typed. Folding
   * them together would mean a build finishing overwrote the message
   * somebody was half way through composing, which is the sort of data
   * loss nobody reports because they assume they imagined it.
   *
   * A list rather than one, because two builds can finish during one
   * turn and both are facts the model needs. They go in a single
   * message.
   */
  const [reports, setReports] = useState<BackgroundJob[]>([]);
  const [caret, setCaret] = useState(0);
  const [shell, setShell] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);

  /* ─── The file index behind @ ──────────────────────────────────────────── */

  const [index, setIndex] = useState<ProjectInfo | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [hits, setHits] = useState<FileHit[]>([]);

  /* ─── Wiring ───────────────────────────────────────────────────────────── */

  /*
    One subscription for the surface's whole life.

    Not per turn: a listener added on send and removed on finish would
    miss the events of a turn still arriving when the next one starts.
  */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    onAgentEvent(surface, (event) => setSession((state) => applyEvent(state, event))).then(
      (off) => {
        if (alive) unlisten = off;
        else off();
      }
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [surface]);

  /**
   * Index the folder once, when it is adopted.
   *
   * This is also what tells the backend which folder every tool
   * resolves against — `figy_open_project` sets this surface's root.
   * The walk is the slow part and it happens here rather than on the
   * first `@`, so the first mention is as quick as the twentieth.
   */
  useEffect(() => {
    if (!root) return;
    let alive = true;
    setIndex(null);
    setIndexError(null);
    setHits([]);
    openProjectIndex(surface, root)
      .then((info) => {
        if (alive) setIndex(info);
      })
      .catch((error: unknown) => {
        if (alive) setIndexError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [root, surface]);

  /*
    Asked, not remembered. The settings live in one file owned by the
    backend; a copy on this side would be a second answer to "which
    model" and the two would disagree the first time one failed to
    save.
  */
  useEffect(() => {
    if (!active) return;
    void agentStatus()
      .then(setStatus)
      .catch(() => {});
  }, [active]);

  /*
    What this folder was working on before.

    Loaded when the surface opens on a project rather than when
    `/resume` is typed, because the count is wanted on the first
    screen: a command nobody knows about is a feature nobody has.
  */
  useEffect(() => {
    if (!active || !root) return;
    let alive = true;
    agentConversations(surface)
      .then((conversations) => {
        if (alive) setPast(conversations);
      })
      .catch(() => {});
    // Read live rather than from the session: this says what the
    // *next* conversation will be given, and a running one keeps what
    // it started with.
    agentRules(surface)
      .then((found) => {
        if (alive) setRules(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active, root, surface]);

  /*
    A new question starts on its first option.

    The cursor is this side's state and the question is the backend's,
    so without this the second prompt of a turn opens with the cursor
    wherever the first one left it — which on an edit card is "No".
  */
  useEffect(() => setChoice(0), [session.live?.id]);

  // The elapsed counter, which only has to tick while something runs.
  useEffect(() => {
    if (!session.running) return;
    const tick = window.setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => window.clearInterval(tick);
  }, [session.running, startedAt]);

  /* ─── Notices ──────────────────────────────────────────────────────────── */

  const notice = useCallback((notice: Notice) => {
    setSession((state) => ({
      ...state,
      blocks: [...state.blocks, { id: state.nextId, kind: "notice", notice }],
      nextId: state.nextId + 1,
    }));
  }, []);

  /*
    A pasted or dropped file, on its way to becoming an attachment.

    Refusals are notices rather than thrown errors, and partial: three
    files where one is a PDF attach the two and say so about the
    third. Failing the whole drop because one item was wrong is the
    kind of strictness that makes people stop using a feature.
  */
  const addFiles = useCallback(
    (files: File[]) => {
      void attach(files, attachments).then(({ added, refused }) => {
        if (added.length > 0) setAttachments((all) => [...all, ...added]);
        if (refused.length > 0) {
          notice({
            tone: "warn",
            title:
              refused.length === 1 ? "That file was not attached" : "Some files were not attached",
            body: refused.join(" · "),
          });
        }
      });
    },
    [attachments, notice]
  );

  const removeFile = useCallback((id: string) => {
    setAttachments((all) => all.filter((one) => one.id !== id));
  }, []);

  /* ─── Commands ─────────────────────────────────────────────────────────── */

  const newConversation = useCallback(() => {
    void agentCancel(surface);
    void agentClear(surface);
    setSession(emptySession());
    setText("");
    setShell(false);
  }, [surface]);

  /**
   * Picks a past conversation back up.
   *
   * The backend puts the session back under this surface's key and
   * hands back the transcript; this side redraws it. What does not
   * come back is the diff on an edit row — the structured half of a
   * tool's answer never entered the conversation and is not stored,
   * so a resumed edit shows what it reported rather than the tinted
   * before-and-after.
   */
  const resume = useCallback(
    (sessionId: string) =>
      agentResume(surface, sessionId)
        .then((conversation) => {
          setSession(resumeSession(conversation.messages, conversation.spentUsd));
          setText("");
          setShell(false);
        })
        .catch((error: unknown) => {
          notice({
            tone: "error",
            title: "That conversation could not be opened",
            body: String(error),
          });
        }),
    [notice, surface]
  );

  const forgetConversation = useCallback((sessionId: string) => {
    void agentForgetConversation(sessionId).then(() => {
      setPast((list) => list.filter((one) => one.sessionId !== sessionId));
    });
  }, []);

  const loadContext = useCallback(
    () => agentContext(surface).then((breakdown) => (setContext(breakdown), breakdown)),
    [surface]
  );

  const loadUsage = useCallback(
    () => agentUsage(surface).then((found) => (setTotals(found), found)),
    [surface]
  );

  const loadPast = useCallback(
    () => agentConversations(surface).then((found) => (setPast(found), found)),
    [surface]
  );

  /**
   * Every tool the model will be offered, in prefix order.
   *
   * Not per surface: `agent_tools` answers with the registry, and what
   * *this* surface is offered out of it is in `context.toolsOffered`
   * — which is why the screen wants both.
   */
  const loadTools = useCallback(
    () => agentTools().then((found) => (setTools(found), found)),
    []
  );

  /**
   * Commands, after the surface has had its turn.
   *
   * Which command opens which screen is `COMMAND_SCREEN`, shared; *how*
   * a screen is shown is the surface's own — a dialog in the window, a
   * tab in a sheet in the panel — so every screen comes in through
   * `onCommand`, and both surfaces also intercept `/clear` to tidy up
   * what only they know about.
   *
   * `/clear` is here as well, as a floor. Nothing reaches it today, and
   * a surface that forgot to handle it should still start a new
   * conversation rather than answer "No command /clear" — the one
   * command whose failure would look like the agent being broken.
   */
  const command = useCallback(
    (name: string) => {
      if (onCommand?.(name)) return;
      if (name === "/clear") {
        newConversation();
        return;
      }
      notice({
        tone: "info",
        title: `No command ${name}`,
        body: options.commandHint,
      });
    },
    [newConversation, notice, onCommand, options.commandHint]
  );

  /* ─── Sending ──────────────────────────────────────────────────────────── */

  /**
   * Pictures named with `@`, loaded at the moment of sending.
   *
   * `@shot.png summary this` has to work: the mention is how somebody
   * points at a file here, and otherwise it points the agent at a path
   * it can only call `read` on — which answers that the file is binary,
   * and the agent asks the person to paste the image they just
   * mentioned.
   *
   * Loaded here rather than when the mention is completed, because a
   * path can also be typed, pasted or edited after the fact. The path
   * stays in the text: it says *which* file, which the picture does
   * not.
   */
  const mentionedImages = useCallback(
    async (text: string): Promise<{ added: Attachment[]; refused: string[] }> => {
      const added: Attachment[] = [];
      const refused: string[] = [];
      for (const path of imageMentions(text)) {
        try {
          const image = await readImage(surface, path);
          added.push({
            id: `${path}-${Date.now()}`,
            name: image.name,
            mime: image.mime,
            data: image.data,
            bytes: image.bytes,
            url: `data:${image.mime};base64,${image.data}`,
          });
        } catch (error) {
          refused.push(String(error));
        }
      }
      return { added, refused };
    },
    [surface]
  );

  /**
   * Everything after the pictures are in hand.
   *
   * `decorate` is where a surface adds what only it knows — the editor
   * panel puts the open file and the selection in front of the first
   * message. It changes what the *model* reads, never what the
   * transcript shows.
   */
  const finishSend = useCallback(
    (
      value: string,
      sending: Attachment[],
      decorate?: (prompt: string) => string,
      /** False for a message the window sent on its own — see `pushUser`. */
      shown = true
    ) => {
      /*
        Said here rather than discovered by the provider.

        A model that cannot see answers a picture with a 400, which
        arrives as "the turn failed" after the screenshot has been
        attached, the question typed and the message sent. This is the
        same answer before any of that is spent, and the attachments
        survive it — so switching model and pressing enter again is the
        whole of the fix.
      */
      if (sending.length > 0 && !status.models.find((m) => m.id === status.active)?.vision) {
        notice({
          tone: "warn",
          title: `${status.model || "This model"} does not read images`,
          body: 'Tick "reads images" for it in Settings → Models if it can, or pick one that does. What you attached is still here.',
        });
        setText(value);
        return;
      }

      setAttachments([]);
      setSession((state) => pushUser(state, value, sending, shown));
      setStartedAt(Date.now());
      setElapsed(0);

      // The promise resolves when the turn is over; everything worth
      // showing has already arrived as events by then.
      void agentSend(decorate ? decorate(value) : value, mode, system, surface, sending)
        .catch(() => {
          /* The `failed` event already said so, in the transcript. */
        })
        .finally(() => void loadUsage().catch(() => {}));
    },
    [loadUsage, mode, notice, status, surface, system]
  );

  const send = useCallback(
    (
      raw: string,
      decorate?: (prompt: string) => string,
      /**
       * False for a message nobody typed.
       *
       * The window sends one when a background job finishes: the
       * notice above is the visible record, and drawing a user turn
       * saying "check bg_1" would be putting words in somebody's
       * mouth.
       */
      shown = true
    ) => {
      const value = raw.trim();
      // A picture on its own is a message: "what is wrong with this?"
      // is in the screenshot, not in the words.
      if (!value && attachments.length === 0) return;

      /*
        Held, not sent, while a turn is in flight.

        A conversation runs one turn at a time — the backend refuses a
        second, because the running turn owns the session and a
        concurrent one used to fork it and erase the loser's history.
        What the person typed is kept and goes the moment the turn
        ends, which is what they meant by typing it.

        Commands are the exception: `/clear` and the screens act on the
        window rather than on the conversation, and queueing "show me
        the context" until after a five-minute build is absurd.
      */
      if (sessionRef.current.running && !value.startsWith("/")) {
        setQueued({ text: value, images: attachments });
        setText("");
        setAttachments([]);
        return;
      }

      /*
        `!` runs one tool with no model and no permission prompt — the
        user typed the command, so there is nobody to ask. Its output
        does not enter the conversation: `agent/session.rs` owns the
        history, and a window that could append to it would be a second
        writer of the one thing that must stay append-only.
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
        void agentCallTool(surface, "bash", { cmd: value })
          .then((result) =>
            setSession((state) => patchLocal(state, callId, result.text.split("\n").slice(1), false))
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

      if (!root) {
        notice({
          tone: "warn",
          title: "No folder open",
          body: options.noFolder.long,
        });
        return;
      }

      /*
        Anything named with `@` joins what was pasted or dropped.

        Asynchronous, so the rest of sending happens in the `then` —
        the alternative is sending the message and attaching the
        pictures to the one after it.
      */
      void mentionedImages(value).then(({ added, refused }) => {
        if (refused.length > 0) {
          notice({
            tone: "warn",
            title: "Some mentioned images could not be read",
            body: refused.join(" · "),
          });
        }
        finishSend(value, [...attachments, ...added], decorate, shown);
      });
    },
    [attachments, command, finishSend, mentionedImages, notice, options.noFolder.long, root, shell, surface]
  );

  const answer = useCallback(
    (optionIndex: number) => {
      const live = session.live;
      if (!live) return;

      /*
        Two things stop a run and they are drawn by the same card on
        purpose — here is the situation, here are the few ways out.
        They go back by different routes: a permission question is yes
        or no to the policy, and a question of the model's own is a
        sentence that lands in the conversation.
      */
      if (live.kind === "question") {
        const picked = live.prompt.options[optionIndex]?.label ?? NONE_OF_THESE;
        /*
          An approved plan lifts plan mode in the turn that proposed
          it. Both sides are told: the backend so the next tool in this
          turn is not refused, and this side so the footer agrees with
          what is actually happening.
        */
        const next = modeAfterPlan(picked);
        if (next) setMode(next);
        void agentAnswer(live.id, picked, surface, next ?? undefined);
      } else {
        const { allow, remember, acceptEdits } = answerOf(live, optionIndex);
        if (acceptEdits) setMode("acceptEdits");
        // The mode goes with the answer rather than with the next
        // message: "allow all edits this session" that still asks two
        // tool calls later reads as a button that did not work.
        void agentApprove(live.id, allow, surface, remember, acceptEdits ? "acceptEdits" : undefined);
      }
      setSession((state) => ({ ...state, live: null }));
      setChoice(0);
    },
    [session.live, surface]
  );

  const interrupt = useCallback(() => {
    void agentCancel(surface);
  }, [surface]);

  /**
   * Whatever is waiting goes the moment the turn ends.
   *
   * Two things can be waiting and they are handled by **one** effect,
   * because two effects both firing on idle would race to start a turn
   * and the loser would be refused by the backend:
   *
   * - what somebody typed while the agent was working, and
   * - background jobs that finished while it was working.
   *
   * They go in a single message when both are waiting, which is one
   * turn instead of two and reads the way somebody would say it: the
   * request, then the news. What was typed goes first, because it is
   * the part with intent in it.
   *
   * Cleared *before* sending rather than after, because `send` sets
   * `running` on the next render and this effect would otherwise see
   * the queue still full and send it twice. The ref is what makes that
   * ordering reliable: state has not caught up yet.
   */
  const sending = useRef(false);
  useEffect(() => {
    if (session.running || sending.current) return;
    if (!queued && reports.length === 0) return;

    sending.current = true;
    const held = queued;
    const done = reports;
    setQueued(null);
    setReports([]);
    if (held) setAttachments(held.images);

    const parts: string[] = [];
    if (held) parts.push(held.text);
    for (const job of done) parts.push(reportOf(job));

    /*
      Drawn only if a person typed part of it.

      A turn that exists purely to tell the agent a build finished has
      no user message to show — the notice above it already said what
      happened, and a fabricated "check bg_1" in somebody's own voice
      would be the window putting words in their mouth.
    */
    const shown = held !== null;

    // A tick, so the turn that just ended has finished writing itself
    // into the transcript before the next one starts appending to it.
    const timer = window.setTimeout(() => {
      sending.current = false;
      send(parts.join("\n\n"), undefined, shown);
    }, 0);
    return () => window.clearTimeout(timer);
    // `send` is stable enough for this and listing it would re-run the
    // effect mid-send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.running, queued, reports]);

  /** Throws away what was typed ahead, without sending it. */
  const unqueue = useCallback(() => setQueued(null), []);

  /* ─── Background jobs ──────────────────────────────────────────────────── */

  /**
   * What is running in the background, polled while any of it is.
   *
   * The window polling is the opposite of the rule `bash_wait` exists
   * to enforce, and the difference is the whole point: a *model*
   * polling spends a request that re-sends the conversation, and this
   * spends an IPC call. The expensive loop is the one with a language
   * model in it.
   *
   * Per window rather than per surface, because the shell is — a build
   * started in the FigyCode window is visible in the editor's panel,
   * which is true and is what somebody would expect of one machine.
   */
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const lastJobs = useRef<BackgroundJob[]>([]);

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const look = async () => {
      let now: BackgroundJob[];
      try {
        now = await agentBackground();
      } catch {
        return;
      }
      if (!alive) return;

      /*
        What finished since the last look, said once each.

        Against the previous *reading* rather than against the current
        state, because a finished job stays in the list — without the
        diff, every poll would announce the same completed build again
        for as long as the window stayed open.
      */
      /*
        Every finished job is shown; only this surface's own are
        reported. Both surfaces watch one shell, so without the second
        filter the FigyCode window and the editor panel would each
        spend a request telling their model about the same build — and
        one of them never started it.
      */
      const done = finishedSince(lastJobs.current, now);
      lastJobs.current = now;
      setJobs(now);

      const ours = mine(done, surface);
      if (ours.length > 0) setReports((all) => [...all, ...ours]);

      for (const job of done) {
        const outcome = outcomeOf(job);
        // The facts, immediately and for nothing. The agent's reading
        // of them follows on its own — see the idle effect below.
        notice({ tone: outcome.tone, title: outcome.title, body: outcome.body });
      }
    };

    void look();
    /*
      A second. Fast enough that a build finishing feels immediate,
      slow enough to be invisible — and it only runs at all while
      something is in flight, so an idle window does no work.
    */
    const timer = window.setInterval(() => void look(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, notice, surface]);

  const stopJob = useCallback((id: string) => {
    void agentBackgroundKill(id).catch(() => {});
  }, []);

  /* ─── The open job's log ───────────────────────────────────────────────── */

  /**
   * Which job's output is showing, and what of it has arrived.
   *
   * One at a time: two open logs in a column above the composer is the
   * composer off the bottom of the window.
   *
   * Followed with a **cursor**, so each line crosses IPC once. The
   * alternative — asking for the whole buffer every second — is a
   * Docker build's few thousand lines serialised once a second for as
   * long as somebody leaves it open, to redraw text that has not
   * changed.
   */
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const cursor = useRef(0);

  /* A different job means a different log, from the beginning. */
  useEffect(() => {
    cursor.current = 0;
    setLog([]);
  }, [openJob]);

  useEffect(() => {
    if (!openJob) return;
    let alive = true;

    const pull = async () => {
      try {
        const out = await agentBackgroundOutput(openJob, cursor.current);
        if (!alive || out.lines.length === 0) return;
        cursor.current = out.total;
        /*
          The tail, not the whole thing. A build writes thousands of
          lines and the interesting one is always the last — and a
          `<pre>` holding all of them is a layout the browser
          re-measures every second.
        */
        setLog((all) => [...all, ...out.lines].slice(-LOG_LINES));
      } catch {
        /* The job may have been killed while this was in flight. */
      }
    };

    void pull();
    const timer = window.setInterval(() => void pull(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [openJob]);

  /* A job that ends while its log is open keeps the log: what it said
     at the end is exactly what somebody wants after it stops. */

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
      findFiles(surface, mentionQuery, 12)
        .then((found) => {
          if (askedRef.current === asked) setHits(found);
        })
        .catch(() => {
          if (askedRef.current === asked) setHits([]);
        });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [index, mentionQuery, surface]);

  const items: PopupItem[] = useMemo(() => {
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

  const completion: Completion = {
    items,
    at: items.length ? Math.min(popupIndex, items.length - 1) : 0,
    empty: !mention
      ? null
      : !root
        ? options.noFolder.short
        : indexError
          ? `Could not read that folder: ${indexError}`
          : !index
            ? "Indexing the folder…"
            : `Nothing matches “${mention.query}”`,
    slashing,
    mention,
  };

  const focusAt = useCallback((at: number) => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setCaret(at);
    });
  }, []);

  const complete = useCallback(
    (itemIndex: number) => {
      const item = items[itemIndex];
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
    [caret, focusAt, items, mention, text]
  );

  const insert = useCallback(
    (token: "@" | "/" | "!") => {
      if (token === "!") {
        if (!shellAllowed) return;
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
    [focusAt, shellAllowed, text]
  );

  /* ─── Settings ─────────────────────────────────────────────────────────── */

  /**
   * Saves, and says what that cost.
   *
   * `quiet` is for a change the surface has already shown — the model
   * picker renames itself, and a notice in an empty transcript is the
   * first thing in a conversation being about the window.
   */
  const saveSettings = useCallback(
    (next: AgentSettings, quiet?: boolean) => {
      const before = status.active;
      return agentConfigure(next)
        .then((saved) => {
          setStatus(saved);

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
            return saved;
          }

          if (quiet) return saved;
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
          return saved;
        })
        .catch((error: unknown) => {
          notice({ tone: "error", title: "That could not be saved", body: String(error) });
          return null;
        });
    },
    [notice, session.blocks.length, status.active]
  );

  return {
    /* The conversation */
    session,
    setSession,
    choice,
    setChoice,
    elapsed,
    /* Settings and accounting */
    mode,
    setMode,
    status,
    setStatus,
    configured,
    totals,
    context,
    past,
    setPast,
    rules,
    tools,
    loadContext,
    loadUsage,
    loadPast,
    loadTools,
    saveSettings,
    /* The composer */
    inputRef,
    text,
    setText,
    caret,
    setCaret,
    shell,
    setShell,
    attachments,
    addFiles,
    removeFile,
    /** What is waiting for the turn to end, if anything. */
    queued,
    unqueue,
    completion,
    setPopupIndex,
    complete,
    insert,
    /* The project */
    index,
    indexError,
    /* Doing things */
    notice,
    /** What is still going, and its one-line label for the chip. */
    running: stillRunning(jobs),
    runningLabel: backgroundLabel(jobs),
    stopJob,
    openJob,
    setOpenJob,
    log,
    command,
    send,
    answer,
    interrupt,
    newConversation,
    resume,
    forgetConversation,
  };
}

/**
 * A `!` command's row, once it has finished.
 *
 * Only the shell path produces one of these, so it lives beside the
 * shell path rather than in the reducer: `applyEvent` is for what the
 * *backend* says happened, and a `!` command is one this side ran and
 * has to write down itself.
 */
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
