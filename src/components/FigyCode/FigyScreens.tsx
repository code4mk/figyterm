/**
 * The welcome screen, and the two dialogs that are views rather than
 * settings: what this folder has worked on, and what this session has
 * spent.
 *
 * Both used to take over the body, which was the same mistake the
 * settings screen made. Looking at what a session cost is not leaving
 * the conversation — it is looking at something *about* the
 * conversation — and coming back from it should not be an action. They
 * are dialogs now, over a transcript that stays where it was, and they
 * share the frame in `FigyDialog.tsx` with the settings.
 *
 * There used to be one more, `/rewind`, over an invented list of
 * checkpoints. Rewinding means a snapshot of the working tree per turn and
 * nothing here takes one, so the screen went with the rest of the fiction.
 */

import { FolderOpen, FolderSearch, MessageSquare, Trash2 } from "lucide-react";
import { collapseHome } from "../../services/recent-dirs";
import { Dialog } from "./FigyDialog";
import { projectLabel, type FigyProject } from "../../services/figycode-projects";
import { formatCost, formatTokens } from "../../services/figycode-blocks";
import type { Conversation, ProjectRules, Totals } from "../../services/figycode-agent";

/* ─── Start ───────────────────────────────────────────────────────────────── */

/**
 * The first screen, and the only one that has to say two true things at
 * once: which folder this is, and whether there is a model behind the box.
 *
 * Both are facts it can stand behind — the folder was chosen through the OS
 * dialog, and the backend either has a key or does not. Nothing
 * here is decorative, which is a change: it used to greet the user by an
 * invented name and list conversations that had never happened.
 */
export function Welcome({
  root,
  index,
  model,
  configured,
  rules,
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
  /** What this project tells the agent, and what it costs to tell it. */
  rules: ProjectRules | null;
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
            Rules the project wrote down, said out loud.

            The whole argument for reading them from a file rather than
            letting the agent keep notes to itself is that behaviour
            should be reviewable — which means the window has to admit
            when there are some, name the file, and say what carrying
            them costs on every turn.
          */}
          <div className="figy-welcome-check">
            <span className="figy-welcome-check-label">rules</span>
            <span className="figy-welcome-check-detail">
              {rules ? (
                <>
                  {rules.name}
                  <span className="figy-sub">
                    {" "}
                    · ~{formatTokens(rules.tokens)} tokens on every turn
                    {rules.truncated && " · cut at the limit"}
                  </span>
                </>
              ) : (
                <span className="dim">
                  none — add a FIGY.md and it is read into every conversation
                </span>
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
export function ResumeDialog({
  conversations,
  onResume,
  onForget,
  onClose,
}: {
  conversations: Conversation[];
  onResume: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="Earlier in this folder" onClose={onClose}>
      <div className="figy-dialog-body">
        <div className="figy-dialog-note">
          Carrying one on re-sends the whole conversation on the next message — the
          provider&rsquo;s cache does not survive the gap. The shorter the conversation,
          the cheaper it is to come back to.
        </div>

        {conversations.length === 0 ? (
          <div className="figy-empty">
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
    </Dialog>
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
export function UsageDialog({ totals, onClose }: { totals: Totals; onClose: () => void }) {
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
    <Dialog title="Tokens and spend" onClose={onClose}>
      <div className="figy-dialog-body">
        <div className="figy-dialog-note">
          Every turn re-sends the whole conversation, so input is nearly all of the cost
          and the cache is nearly all of the saving.
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
    </Dialog>
  );
}
