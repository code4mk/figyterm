/**
 * The screens that are not the transcript: the start, `/model`,
 * `/resume` and `/usage`.
 *
 * Both take over the body rather than opening a dialog over it. A modal
 * inside a modal is two Escape keys deep, and the window already has a rule
 * about Escape that the user has just learned; these borrow it instead. The
 * composer stays visible underneath for the same reason — typing is always
 * the way out, including out of a screen opened by mistake.
 *
 * There used to be a third, `/rewind`, over an invented list of
 * checkpoints. Rewinding means a snapshot of the working tree per turn and
 * nothing here takes one, so the screen went with the rest of the fiction.
 */

import { useState } from "react";
import { FolderOpen, FolderSearch, MessageSquare, Trash2 } from "lucide-react";
import { collapseHome } from "../../services/recent-dirs";
import { projectLabel, type FigyProject } from "../../services/figycode-projects";
import { formatCost, formatTokens } from "../../services/figycode-blocks";
import type { AgentSettings, Conversation, Totals } from "../../services/figycode-agent";

/* ─── Start ───────────────────────────────────────────────────────────────── */

/**
 * The first screen, and the only one that has to say two true things at
 * once: which folder this is, and whether there is a model behind the box.
 *
 * Both are facts it can stand behind — the folder was chosen through the OS
 * dialog, and the key either exists in the keychain or does not. Nothing
 * here is decorative, which is a change: it used to greet the user by an
 * invented name and list conversations that had never happened.
 */
export function Welcome({
  root,
  index,
  model,
  configured,
  others,
  earlier,
  onPick,
  onBrowse,
  onConfigure,
  onResume,
}: {
  root: string | null;
  index: { files: number; folders: number; truncated: boolean } | null;
  model: string;
  configured: boolean;
  others: FigyProject[];
  /** How many conversations this folder has had, for the one line about them. */
  earlier: number;
  onPick: (root: string) => void;
  onBrowse: () => void;
  onConfigure: () => void;
  onResume: () => void;
}) {
  return (
    <div className="figy-welcome">
      <div className="figy-card figy-welcome-card">
        <div className="figy-welcome-left">
          <div className="figy-welcome-mark">ƒ</div>
          <div className="figy-welcome-name">FigyCode</div>
          <div className="figy-welcome-version">0.1</div>
          <p className="figy-welcome-copy">
            Ask for a change, a fix, or an explanation. FigyCode reads the folder, edits
            files and runs commands — and asks before anything that changes or runs.
          </p>
        </div>

        <div className="figy-welcome-right">
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">folder</span>
            {root ? (
              <span className="figy-welcome-check-detail truncate" title={root}>
                {collapseHome(root)}
              </span>
            ) : (
              <button type="button" className="figy-link" onClick={onBrowse}>
                choose one…
              </button>
            )}
          </div>

          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">files</span>
            <span className="figy-welcome-check-detail">
              {index ? (
                <>
                  {index.files.toLocaleString()} files · {index.folders.toLocaleString()} folders
                  {index.truncated && " · indexed to the limit"}
                  <span className="figy-sub"> · mention them with @</span>
                </>
              ) : (
                <span className="dim">indexing…</span>
              )}
            </span>
          </div>

          {/*
            The one thing that stops the window working, said where it will
            be read rather than discovered on the first message.
          */}
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">model</span>
            <span className="figy-welcome-check-detail">
              {configured ? (
                model
              ) : (
                <button type="button" className="figy-link" onClick={onConfigure}>
                  not set up yet — add a provider
                </button>
              )}
            </span>
          </div>

          {/*
            A restart used to end a conversation, so there was nothing to
            say here. Now there is, and it is said on the screen somebody
            is already looking at rather than left behind a slash command.
          */}
          {earlier > 0 && (
            <>
              <div className="figy-welcome-resume-head">earlier here</div>
              <button type="button" className="figy-welcome-resume" onClick={onResume}>
                <MessageSquare size={11} className="figy-welcome-resume-icon" />
                <span className="figy-welcome-resume-title">
                  {earlier} {earlier === 1 ? "conversation" : "conversations"}
                </span>
                <span className="figy-welcome-resume-when">carry one on…</span>
              </button>
            </>
          )}

          {others.length > 0 && (
            <>
              <div className="figy-welcome-resume-head">switch to</div>
              {others.map((other) => (
                <button
                  key={other.root}
                  type="button"
                  className="figy-welcome-resume"
                  onClick={() => onPick(other.root)}
                  title={other.root}
                >
                  <FolderOpen size={11} className="figy-welcome-resume-icon" />
                  <span className="figy-welcome-resume-title">{projectLabel(other.root)}</span>
                  <span className="figy-welcome-resume-when truncate">
                    {collapseHome(other.root)}
                  </span>
                </button>
              ))}
            </>
          )}

          <button type="button" className="figy-welcome-resume" onClick={onBrowse}>
            <FolderSearch size={11} className="figy-welcome-resume-icon" />
            <span className="figy-welcome-resume-title">Open another folder…</span>
          </button>
        </div>
      </div>

      <div className="figy-welcome-hints">
        <span className="figy-key">@</span> mention files
        <span className="figy-sub">·</span>
        <span className="figy-key accent">/</span> commands
        <span className="figy-sub">·</span>
        <span className="figy-key accent">shift+tab</span> plan mode
        <span className="figy-sub">·</span>
        <span className="figy-key accent">esc</span> interrupt
      </div>
    </div>
  );
}

/* ─── /model ──────────────────────────────────────────────────────────────── */

/**
 * Where the model is, which one, and what it costs.
 *
 * A form rather than a list of three names, because the provider is a base
 * URL: anything that speaks OpenAI's `/chat/completions` works, and
 * pretending otherwise would mean a hard-coded list that is wrong the week
 * somebody ships a new one.
 *
 * The prices are fields for the same reason, and a sharper one — a price
 * baked into a release is out of date by the release after it. What is in
 * these boxes is what the status bar will claim; it is not what anybody is
 * charged.
 */
export function ModelScreen({
  settings,
  hasKey,
  hasExaKey,
  onSave,
}: {
  settings: AgentSettings;
  hasKey: boolean;
  hasExaKey: boolean;
  onSave: (settings: AgentSettings) => void;
}) {
  const [draft, setDraft] = useState<AgentSettings>(settings);
  const [key, setKey] = useState("");
  const [exa, setExa] = useState("");

  const ready = !!draft.baseUrl.trim() && !!draft.model.trim();
  // An empty field means "keep what is stored", on both keys — neither can
  // be shown, so a save after changing the model must not blank them.
  const save = () => {
    if (ready) {
      onSave({ ...draft, apiKey: key.trim() || undefined, exaKey: exa.trim() || undefined });
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    hint?: string
  ) => (
    <label className="figy-field" key={label}>
      <span className="figy-field-label">{label}</span>
      <input
        className="figy-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => e.stopPropagation()}
        /* Enter saves, because a form with one button and three fields is
           a form everybody submits from the keyboard. */
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      {hint && <span className="figy-field-hint">{hint}</span>}
    </label>
  );

  const price = (label: string, value: number | undefined, set: (n: number) => void) => (
    <label className="figy-field narrow" key={label}>
      <span className="figy-field-label">{label}</span>
      <input
        className="figy-input"
        value={value ?? ""}
        placeholder="0"
        inputMode="decimal"
        onChange={(e) => set(Number(e.target.value) || 0)}
        onPaste={(e) => e.stopPropagation()}
      />
    </label>
  );

  return (
    <div className="figy-screen">
      <div className="figy-screen-title">Model</div>
      <div className="figy-screen-copy">
        Anything that speaks the OpenAI chat API. The key goes to this machine&rsquo;s
        keychain and is never shown again.
      </div>

      <div className="figy-form">
        {field(
          "Base URL",
          draft.baseUrl,
          (baseUrl) => setDraft({ ...draft, baseUrl }),
          "https://api.openai.com/v1",
          "The part before /chat/completions"
        )}
        {field("Model", draft.model, (model) => setDraft({ ...draft, model }), "gpt-5.6")}
        {field(
          "API key",
          key,
          setKey,
          hasKey ? "•••••••• — stored. Type to replace it." : "sk-…",
          hasKey ? "A key is stored for this machine." : "Required before the first message."
        )}

        {field(
          "Exa API key",
          exa,
          setExa,
          hasExaKey ? "•••••••• — stored. Type to replace it." : "optional",
          hasExaKey
            ? "search_web and fetch_url are available."
            : "Without one the agent has no web search. Everything else works."
        )}

        <div className="figy-field-row">
          <span className="figy-field-label">Limits</span>
          <div className="figy-field-group">
            {price("context window", draft.contextWindow, (n) =>
              setDraft({ ...draft, contextWindow: n })
            )}
            {price("budget, $", draft.budgetUsd, (n) => setDraft({ ...draft, budgetUsd: n }))}
          </div>
          <span className="figy-field-hint">
            The window in tokens — nothing on the wire reports it, and without it nothing
            can say how close a conversation is to its limit. The budget stops a session
            that is looping rather than working.
          </span>
        </div>

        <div className="figy-field-row">
          <span className="figy-field-label">Price per million tokens</span>
          <div className="figy-field-group">
            {price("input", draft.inputPrice, (n) => setDraft({ ...draft, inputPrice: n }))}
            {price("cached", draft.cachedPrice, (n) => setDraft({ ...draft, cachedPrice: n }))}
            {price("output", draft.outputPrice, (n) => setDraft({ ...draft, outputPrice: n }))}
          </div>
          <span className="figy-field-hint">
            What the status bar will claim a turn cost. Nobody is charged from here.
          </span>
        </div>
      </div>

      <div className="figy-screen-foot">
        <button type="button" className="figy-button primary" onClick={save} disabled={!ready}>
          Save
        </button>
        <span className="figy-field-hint">
          {hasKey ? "A key is stored. Saving without typing one keeps it." : "↵ saves."}
        </span>
      </div>
    </div>
  );
}

/* ─── /resume ─────────────────────────────────────────────────────────────── */

/** `just now`, `14m ago`, `yesterday`, then the date. */
function when(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 18 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 42 * 3600) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The conversations this folder has had, to pick one back up.
 *
 * Two things each line has to say, because they are the two things the
 * choice turns on: what it was about, and how big it is. The second is not
 * trivia — resuming re-sends the whole conversation at full price, since
 * the provider's cache is keyed on a prefix it saw days ago.
 *
 * Filtered to this folder by the backend. A conversation about another
 * repository would be forty turns of confident, wrong context, and is
 * refused rather than listed.
 */
export function ResumeScreen({
  conversations,
  onResume,
  onForget,
}: {
  conversations: Conversation[];
  onResume: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
}) {
  return (
    <div className="figy-screen">
      <div className="figy-screen-title">Earlier in this folder</div>
      <div className="figy-screen-copy">
        Carrying one on re-sends the whole conversation on the next message — the
        provider&rsquo;s cache does not survive the gap. The shorter the conversation, the
        cheaper it is to come back to.
      </div>

      {conversations.length === 0 ? (
        <div className="figy-resume-empty">
          Nothing yet. A conversation is written down after its first answer.
        </div>
      ) : (
        <div className="figy-resume-list">
          {conversations.map((conversation) => (
            <div className="figy-resume-row" key={conversation.sessionId}>
              <button
                type="button"
                className="figy-resume-open"
                onClick={() => onResume(conversation.sessionId)}
                title={conversation.title}
              >
                <MessageSquare size={12} className="figy-resume-icon" />
                <span className="figy-resume-title truncate">{conversation.title}</span>
                <span className="figy-resume-meta">
                  {conversation.turns} {conversation.turns === 1 ? "message" : "messages"} ·{" "}
                  {formatCost(conversation.spentUsd)} · {when(conversation.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="figy-iconbtn"
                onClick={() => onForget(conversation.sessionId)}
                title="Forget this conversation"
                aria-label={`Forget ${conversation.title}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── /usage ──────────────────────────────────────────────────────────────── */

/**
 * What the session has spent, and the one number that says whether the
 * caching is working.
 *
 * A hit rate below ~70% over a long session is a bug to go and find, not a
 * figure to tune — so it is given a sentence rather than left as a
 * percentage nobody knows how to read.
 */
export function UsageScreen({ totals }: { totals: Totals }) {
  const healthy = totals.hitRate >= 70;
  const rows: [string, string][] = [
    ["turns", String(totals.turns)],
    ["input", `${formatTokens(totals.input)} tokens`],
    ["from cache", `${formatTokens(totals.cached)} tokens · ${totals.hitRate}%`],
    ["output", `${formatTokens(totals.output)} tokens`],
    ["spent on the model", formatCost(totals.costUsd)],
    // Kept apart from the model's own cost: folding them together makes a
    // search-heavy session look like an expensive model.
    ["spent on tools", formatCost(totals.toolCostUsd)],
    ["largest tool result", `${formatTokens(totals.largestToolResult)} tokens`],
  ];

  return (
    <div className="figy-screen">
      <div className="figy-screen-title">This session</div>
      <div className="figy-screen-copy">
        Every turn re-sends the whole conversation, so input is nearly all of the cost and
        the cache is nearly all of the saving.
      </div>

      <div className="figy-usage">
        {rows.map(([label, value]) => (
          <div className="figy-usage-row" key={label}>
            <span className="figy-usage-label">{label}</span>
            <span className="figy-usage-value">{value}</span>
          </div>
        ))}
      </div>

      {totals.turns > 2 && (
        <div className={`figy-card figy-notice ${healthy ? "info" : "warn"}`}>
          <div className="figy-notice-main">
            <div className="figy-notice-title">
              <span className="figy-notice-glyph">{healthy ? "◔" : "!"}</span>
              {healthy ? "The cache is working" : "The cache is not being hit"}
            </div>
            <div className="figy-notice-body">
              {healthy
                ? "Most of each turn's input is being read from cache rather than re-sent."
                : "Below about 70% over a long conversation means something is changing the start of the request between turns."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
