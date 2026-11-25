/**
 * The agent, in the column beside the buffer.
 *
 * The same chatbox as the FigyCode window, in a sidebar. Everything
 * between the event stream and the screen — the reducer, `@` and `/`
 * completion, attachments, what Enter means while a permission card is
 * up — comes from `useAgentSurface`, which is the window's own code
 * moved rather than copied. Two chatboxes that are *almost* the same
 * is how the window's `@` grows a fix the panel's never gets.
 *
 * What is different is this file: a 320px column, and screens that fit
 * in one. `/context` is a dialog in the window and seven rows here;
 * `/resume` is a dialog there and a short list here. Same commands,
 * same answers, drawn for the space there is.
 *
 * ## What it still does not have, on purpose
 *
 * No shell. The backend offers this surface read, grep, edit and the
 * three language-server tools — no `bash`, no git, nothing on the
 * network — so a `!` prompt here would be a box that takes a command
 * and then reports that the tool does not exist. When the answer needs
 * one of those, the preamble tells it to say so and point at the
 * window.
 *
 * ## The one thing only this surface knows
 *
 * It is *in* the editor, so it knows what file is open and what is
 * selected, and it hands both over in the message rather than spending
 * a round trip asking. See `services/figycode-panel.ts`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Eraser, X } from "lucide-react";

import {
  agentTestRouter,
  settingsFrom,
  type AgentSettings,
} from "../../services/figycode-agent";
import {
  MODE_LABEL,
  cycleMode,
  formatCost,
  formatElapsed,
  formatTokens,
} from "../../services/figycode-blocks";
import {
  PANEL_SYSTEM,
  seedContext,
  withContext,
  type EditorContext,
} from "../../services/figycode-panel";
import { screenFor, type Screen } from "../../services/figycode-views";
import { BlockView } from "../FigyCode/FigyBlocks";
import { PromptCard } from "../FigyCode/FigyPrompt";
import {
  BackgroundBar,
  Composer,
  CompletionPopup,
  RunningLine,
} from "../FigyCode/FigyComposer";
import { ModelPicker } from "../FigyCode/FigyModelPicker";
import { useAgentSurface } from "../FigyCode/useAgentSurface";
import { PanelSheet, type Sheet } from "./AgentPanelSheets";

/** This is the `panel` surface; the FigyCode window is the other. */
const SURFACE = "panel" as const;

export interface AgentPanelProps {
  /** The project. Null means no folder is open, and the panel says so. */
  root: string | null;
  /**
   * What the editor can see *right now*, read fresh on every send.
   *
   * A function rather than a value because the selection changes on
   * every click and a prop would re-render the whole transcript each
   * time. What matters is what was on screen when enter was pressed.
   */
  look: () => EditorContext;
  onClose: () => void;
}

export function AgentPanel({ root, look, onClose }: AgentPanelProps) {
  const scroll = useRef<HTMLDivElement>(null);
  /** Which compact screen is over the transcript, if any. */
  const [sheet, setSheet] = useState<Sheet>(null);

  /*
    The commands that open one of this column's screens.

    Through a ref because they reach for the hook's loaders and the
    hook is constructed below them. They cannot live in the hook
    itself: what each one opens is a surface's own, and the window
    opens dialogs where this opens a sheet eight rows tall.
  */
  const commandRef = useRef<(name: string) => boolean>(() => false);

  const {
    session,
    shell,
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
    tools,
    loadContext,
    loadUsage,
    loadPast,
    loadTools,
    saveSettings,
    inputRef,
    text,
    setText,
    setCaret,
    attachments,
    addFiles,
    removeFile,
    queued,
    unqueue,
    completion,
    index,
    rules,
    setPopupIndex,
    complete,
    insert,
    notice,
    running,
    stopJob,
    openJob,
    setOpenJob,
    log,
    send,
    answer,
    interrupt,
    newConversation,
    resume,
    forgetConversation,
  } = useAgentSurface({
    surface: SURFACE,
    system: PANEL_SYSTEM,
    root,
    // The panel is only mounted while the column is in agent mode, so
    // being mounted *is* being on screen.
    active: true,
    // It has `bash` now, so it has a `!` prompt.
    shell: true,
    onCommand: useCallback((name: string) => commandRef.current(name), []),
    commandHint: "Try /model, /project, /context, /usage, /tools, /resume or /clear.",
    noFolder: {
      short: "No folder open",
      long: "Open a folder in the editor first — every tool resolves against one.",
    },
  });

  /**
   * What the last message already told the model.
   *
   * Null until the first one is sent, which is what makes that message
   * the one carrying the whole context. A ref rather than state:
   * nothing on screen depends on it, and a re-render per send would be
   * a re-render of the transcript.
   */
  const told = useRef<EditorContext | null>(null);

  /**
   * Opens a view, having loaded what it needs.
   *
   * One function for both ways in — the `/` commands and the switcher
   * — because otherwise a tab would show the last answer it happened
   * to have while the command showed a fresh one, and the two would
   * disagree about the same number.
   *
   * `context` is loaded for the tools view as well as its own: the two
   * halves of that screen come from different calls, and the tool
   * picker's narrowing is only in the breakdown.
   */
  const show = useCallback(
    (screen: Screen) => {
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
      // Shown either way: a view that fails to load says so in its own
      // empty state, which is better than a command that does nothing.
      void Promise.resolve(ready)
        .catch(() => null)
        .then(() => setSheet(screen));
    },
    [loadContext, loadPast, loadTools, loadUsage]
  );

  /*
    A new conversation forgets what the panel has told the model, so
    the next message seeds the whole context again — a fresh
    conversation knows nothing about the open file, whatever this
    component remembers.
  */
  const clear = useCallback(() => {
    told.current = null;
    newConversation();
    setSheet(null);
  }, [newConversation]);

  /*
    Which command opens which screen is `COMMAND_SCREEN`, shared with
    the FigyCode window — this used to be a switch of its own, and the
    one entry it was missing was `/project`: offered by the composer's
    popup here exactly as it is there, completed from the list, and
    then answered "No command /project".
  */
  useEffect(() => {
    commandRef.current = (name: string) => {
      const screen = screenFor(name);
      if (screen === null) return false;
      /*
        Intercepted rather than left to the hook, which would end the
        conversation without forgetting what this component has already
        told the model — so the next message would seed nothing and the
        new conversation would never learn which file is open.
      */
      if (screen === "clear") {
        clear();
        return true;
      }
      show(screen);
      return true;
    };
  });

  /* ─── Sending ──────────────────────────────────────────────────────────── */

  /**
   * Sends, with what the editor can see in front of it.
   *
   * The context goes to the *model* and not to the transcript: showing
   * somebody four lines of their own selection quoted back at them is
   * noise in a column this narrow. `decorate` is the hook's hook for
   * exactly this.
   */
  const ask = useCallback(
    (value: string) => {
      /*
        A command or a shell line is not a message, and must not drag
        the open file into the conversation ahead of one. `shell` is
        checked as well as `/` now that the panel has a `!` prompt:
        `!npm test` runs one tool with no model at all, so there is
        nothing for a context seed to be read by.
      */
      if (shell || value.trim().startsWith("/")) {
        send(value);
        return;
      }
      const now = look();
      const context = seedContext(now, told.current);
      told.current = now;
      send(value, (prompt) => withContext(prompt, context));
    },
    [look, send, shell]
  );

  /* ─── Keys ─────────────────────────────────────────────────────────────── */

  /*
    On this subtree only, which is the difference from the window.

    The window binds its keys to the whole modal because nothing else
    is in it. Here CodeMirror is one tab away and has a keymap of its
    own, so everything below is bound to the panel's own element and
    nothing globally — a sidebar that claimed the arrow keys would be
    breaking the buffer to run itself.

    `stopPropagation` as well as `preventDefault`: the editor modal is
    an ancestor and claims Escape for closing, which would shut the
    whole editor on the keystroke meant to stop a turn.
  */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
      const options = session.live?.prompt.options ?? [];
      const items = completion.items;

      // A text field owns its own keys — the sheets have one, and
      // Enter in it meant "send" until this was here.
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && e.key !== "Escape") return;

      if (e.key === "Escape") {
        /*
          The closest thing first, and Escape only stays ours while
          there is one. With nothing open and nothing running it
          belongs to the editor, which is what this is inside.
        */
        if (sheet) {
          stop();
          setSheet(null);
        } else if (items.length || completion.empty) {
          stop();
          setText((t) => `${t} `);
        } else if (session.live) {
          stop();
          answer(session.live.prompt.denyIndex);
        } else if (session.running) {
          stop();
          interrupt();
        }
        return;
      }

      if (e.key === "Tab" && e.shiftKey && bare) {
        stop();
        const chord = options.findIndex((o) => o.chord === "shift+tab");
        if (session.live && chord >= 0) answer(chord);
        // All three modes, because the panel has the `plan` tool now.
        else setMode(cycleMode);
        return;
      }

      if (e.key === "Tab" && bare && items.length) {
        stop();
        complete(completion.at);
        return;
      }

      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare) {
        const delta = e.key === "ArrowDown" ? 1 : -1;
        if (items.length) {
          stop();
          setPopupIndex((i) => (items.length + Math.min(i, items.length - 1) + delta) % items.length);
          return;
        }
        if (options.length) {
          stop();
          setChoice((i) => (options.length + i + delta) % options.length);
        }
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && bare) {
        stop();
        if (items.length) complete(completion.at);
        else if (session.live) answer(choice);
        else ask(text);
        return;
      }

      // The numbered options, as the card draws them. Only with
      // nothing typed: "1" is a digit in a sentence long before it is
      // a choice.
      if (session.live && !text && bare && /^[1-9]$/.test(e.key)) {
        const option = Number(e.key) - 1;
        if (option < options.length) {
          stop();
          answer(option);
        }
      }
    },
    [
      answer,
      ask,
      choice,
      complete,
      completion.at,
      completion.empty,
      completion.items,
      interrupt,
      session.live,
      session.running,
      setChoice,
      setMode,
      setPopupIndex,
      setText,
      sheet,
      text,
    ]
  );

  /* ─── Following the tail ───────────────────────────────────────────────── */

  /*
    Follow the answer down, but only if the reader is at it.

    Pinning unconditionally is the bug every streaming transcript
    ships with: scroll up to read what a tool returned and the next
    token drags you back. A narrow column fills fast, which makes this
    matter more here than in the window.
  */
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scroll.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [atBottom, session.blocks, session.live, session.running, session.status]);

  const toBottom = useCallback(() => {
    const el = scroll.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }, []);

  /* ─── Render ───────────────────────────────────────────────────────────── */

  const model = status.models.find((m) => m.id === status.active);
  /* The same ladder the window uses, in fewer words — the box is a
     third of the width and a sentence would not fit in it. */
  const placeholder = shell
    ? "Run a command — shown here, not sent to the model"
    : !root
      ? "Open a folder first"
      : !configured
        ? "No model set up"
        : session.live
          ? "Answer above, or say something else"
          : "Ask about this file";

  return (
    <div className="figy-panel" onKeyDown={onKeyDown}>
      <div className="figy-panel-head">
        <Bot size={12} className="shrink-0" />
        <span className="figy-panel-title">Agent</span>
        <span className="figy-panel-spacer" />
        {/*
          What this turn cost, where the window puts it in a status bar.

          A column this narrow has no room for a bar, and the number
          worth watching is the one that climbs — so it rides in the
          header and opens the same breakdown the window's does.
        */}
        {session.spent > 0 && (
          <button
            type="button"
            className="figy-panel-spend"
            onClick={() => show("usage")}
            title="This session's tokens and spend"
          >
            {formatCost(session.spent)}
          </button>
        )}
        {session.usage?.contextPercent != null && (
          <button
            type="button"
            className="figy-panel-spend"
            onClick={() => show("context")}
            title="What is filling the context window"
          >
            {session.usage.contextPercent}%
          </button>
        )}
        {session.blocks.length > 0 && (
          <button
            type="button"
            className="figy-panel-act"
            onClick={clear}
            title="Start a new conversation"
            aria-label="Start a new conversation"
          >
            <Eraser size={12} />
          </button>
        )}
        <button
          type="button"
          className="figy-panel-act"
          onClick={onClose}
          title="Close the agent panel"
          aria-label="Close the agent panel"
        >
          <X size={12} />
        </button>
      </div>

      <div
        className="figy-panel-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {session.blocks.length === 0 ? (
          <PanelWelcome root={root} configured={configured} earlier={past.length} />
        ) : (
          <div className="figy-transcript figy-panel-transcript">
            {session.blocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                /* A notice's chip is a sentence the user is sending, so
                   it goes through `ask` like any other. */
                onAction={ask}
              />
            ))}
          </div>
        )}
      </div>

      {/*
        One screen at a time, over the transcript rather than beside it.

        The window can afford a dialog in front of a 960px transcript.
        Here the sheet *is* the column while it is open, and Escape
        closes it — which is why Escape checks for it first.
      */}
      {sheet && (
        <PanelSheet
          sheet={sheet}
          onView={show}
          context={context}
          totals={totals}
          past={past}
          status={status}
          tools={tools}
          root={root}
          index={index}
          rules={rules}
          onResume={(id) => void resume(id).then(() => setSheet(null))}
          onForget={forgetConversation}
          /*
            Picking a model leaves the sheet open.

            It used to close, which was right when this was five
            one-shot screens and wrong now it is a place: the save is
            quiet, so closing left somebody looking at a transcript
            with no sign anything had happened. Staying put, the row
            lights and that *is* the confirmation.
          */
          onPick={(next: AgentSettings) => void saveSettings(next, true)}
          onTest={() => agentTestRouter(SURFACE)}
          /*
            A notice lands in the transcript, which is *behind* the
            sheet — so anything that answers with one has to put the
            transcript back first. Otherwise the router check is a
            button that visibly does nothing.
          */
          onNotice={(one) => {
            setSheet(null);
            notice(one);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      <div className="figy-panel-bottom">
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

        {/* Not while it is waiting on you: nothing is running, and the
            seconds would be counting the time spent reading the card. */}
        {session.running && !session.live && (
          <RunningLine
            label={session.status}
            elapsed={formatElapsed(elapsed)}
            tokens={formatTokens(session.usage?.output ?? session.streamed / 4)}
          />
        )}

        <CompletionPopup
          items={completion.items}
          selected={completion.at}
          hint={completion.slashing ? "a command" : "a file"}
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
          modelPicker={
            <ModelPicker
              models={status.models}
              active={status.active}
              onPick={(id) => void saveSettings(settingsFrom(status, { active: id }), true)}
              /*
                Models are *set up* in the window: the form is a table
                of providers, prices and keys, and it does not go in a
                column. This picks between ones that already exist,
                which is what a picker is for.
              */
              onManage={() => show("settings")}
            />
          }
          attachments={attachments}
          onFiles={addFiles}
          onRemoveFile={removeFile}
          onChange={(value) => {
            setText(value);
            setCaret(inputRef.current?.caret() ?? value.length);
            setPopupIndex(0);
          }}
          onCaret={() => setCaret(inputRef.current?.caret() ?? 0)}
          onInsert={insert}
          onCycleMode={() => setMode(cycleMode)}
          onSend={() => ask(text)}
          onStop={interrupt}
        />
      </div>

      {/* The model, under the box rather than in a bar there is no room
          for. Mono, because it is a name to check and not prose. */}
      <div className="figy-panel-foot">
        <span className="figy-panel-model">{model?.label ?? "No model"}</span>
        {model && <span className="figy-panel-foot-dim">{model.model}</span>}
      </div>
    </div>
  );
}

/**
 * The empty state.
 *
 * Three lines, because the column is 320px wide and the window's
 * welcome screen — projects, rules, recent conversations — is a page.
 * What somebody needs to know here is that this one is about the file
 * they are looking at, and that it cannot run anything.
 */
function PanelWelcome({
  root,
  configured,
  earlier,
}: {
  root: string | null;
  configured: boolean;
  earlier: number;
}) {
  return (
    <div className="figy-panel-welcome">
      <Bot size={18} className="opacity-40" />
      {!root ? (
        <p>Open a folder and this will answer questions about the files in it.</p>
      ) : !configured ? (
        <p>
          No model is set up yet. Open the FigyCode window and add one in Settings — the panel
          uses the same one.
        </p>
      ) : (
        <>
          <p>Ask about the file you have open. What is selected comes with the question.</p>
          <p className="figy-panel-welcome-note">
            The same tools as the FigyCode window — the shell, git and the rest. The open
            file and your selection come with the question, which the window has to go
            looking for.
          </p>
          <p className="figy-panel-welcome-note">
            <code>@</code> names a file · <code>/</code> a command
            {earlier > 0 && <> · {earlier} earlier here, under /resume</>}
          </p>
        </>
      )}
    </div>
  );
}
