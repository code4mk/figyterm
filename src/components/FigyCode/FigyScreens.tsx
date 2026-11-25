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

import { useState } from "react";
import { FolderOpen, FolderPlus, FolderSearch, MessageSquare, Trash2 } from "lucide-react";
import { collapseHome } from "../../services/recent-dirs";
import { Dialog } from "./FigyDialog";
import { projectLabel, type FigyProject } from "../../services/figycode-projects";
import { formatCost, formatTokens } from "../../services/figycode-blocks";
import type { Conversation, ProjectRules, Totals } from "../../services/figycode-agent";
import {
  RESUME_EMPTY,
  RESUME_NOTE,
  USAGE_EMPTY,
  cacheWord,
  conversationRow,
  usageView,
} from "../../services/figycode-views";
import type { DirCount } from "../../services/figycode-files";

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
  inDialog,
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
  /**
   * Inside the project dialog rather than on the empty transcript.
   *
   * The card is the same — that is the point of `/project`, which is
   * "show me what the window said when it opened" — but the keyboard
   * hints under it are not. They teach the composer, and in a dialog
   * the composer is behind you.
   */
  inDialog?: boolean;
  onPick: (root: string) => void;
  onBrowse: () => void;
  onConfigure: () => void;
  onResume: () => void;
}) {
  return (
    <div className={`figy-welcome ${inDialog ? "in-dialog" : ""}`}>
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

      {!inDialog && (
      <div className="figy-welcome-hints">
        <span className="figy-key">@</span> mention files
        <span className="figy-sub">·</span>
        <span className="figy-key accent">/</span> commands
        <span className="figy-sub">·</span>
        <span className="figy-key accent">shift+tab</span> plan mode
        <span className="figy-sub">·</span>
        <span className="figy-key accent">esc</span> interrupt
      </div>
      )}
    </div>
  );
}

/* ─── /project ────────────────────────────────────────────────────────────── */

/**
 * Everything about the folder, on demand.
 *
 * It is the first screen, reopened. That window said four true things
 * — which folder, how much of it is indexed, which model, what rules
 * it carries — and then the first message replaced it for ever. They
 * do not stop being the things you need to check; they stop being
 * visible.
 *
 * And one thing the first screen cannot say, because it is about a
 * decision made later: the folders this project may **also** reach.
 * Those were chips in the status bar, which is a bar for reporting
 * and not for granting — nine grey pixels to say "the agent may write
 * here too", with no room to explain it and no way to take it back.
 */
export function ProjectDialog({
  root,
  index,
  model,
  configured,
  rules,
  others,
  earlier,
  extraDirs,
  counts,
  onPick,
  onBrowse,
  onConfigure,
  onResume,
  onAddDir,
  onRemoveDir,
  onClose,
}: {
  root: string | null;
  index: { files: number; folders: number; truncated: boolean } | null;
  model: string;
  configured: boolean;
  rules: ProjectRules | null;
  others: FigyProject[];
  earlier: number;
  /** Folders this project may also reach. */
  extraDirs: string[];
  /**
   * How much is in each, by path. Absent while it is being counted,
   * which a large folder takes a second or two to do.
   */
  counts: Record<string, DirCount | null>;
  onPick: (root: string) => void;
  onBrowse: () => void;
  onConfigure: () => void;
  onResume: () => void;
  onAddDir: () => void;
  onRemoveDir: (dir: string) => void;
  onClose: () => void;
}) {
  /*
    Which folder is being asked about, if any.

    Removing one is not dangerous and it is not nothing: it takes away
    an access the agent currently has, and the row it lives on is two
    pixels from a count that changes under it. One click is how you
    revoke the wrong folder and only find out when the next turn says
    it cannot read something.

    Asked inline rather than in a dialog of its own. A modal inside a
    modal is two Escape keys deep, and this window already has a rule
    about Escape that somebody has just learned.
  */
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Dialog title="Project" onClose={onClose}>
      <div className="figy-dialog-body">
        <Welcome
          inDialog
          root={root}
          index={index}
          model={model}
          configured={configured}
          rules={rules}
          others={others}
          earlier={earlier}
          onPick={(picked) => {
            onClose();
            onPick(picked);
          }}
          onBrowse={() => {
            onClose();
            onBrowse();
          }}
          onConfigure={() => {
            onClose();
            onConfigure();
          }}
          onResume={() => {
            onClose();
            onResume();
          }}
        />

        {root && (
          <div className="figy-extra">
            <div className="figy-extra-head">
              <span>Also reachable</span>
              <button className="figy-extra-add" onClick={onAddDir}>
                <FolderPlus size={11} />
                Add a folder
              </button>
            </div>

            {extraDirs.length === 0 ? (
              <div className="figy-extra-empty">
                Only this folder. The agent cannot read or write outside it.
              </div>
            ) : (
              extraDirs.map((dir) => {
                const count = counts[dir];
                if (confirming === dir) {
                  return (
                    <div className="figy-extra-row confirming" key={dir}>
                      <span className="figy-extra-ask truncate">
                        {/*
                          What it does, and — just as important —
                          what it does not. "Remove folder" reads as
                          "delete folder" to anybody who has not
                          written this code.
                        */}
                        Stop the agent reading and writing{" "}
                        <strong>{collapseHome(dir)}</strong>? Nothing on disk is touched.
                      </span>
                      <button
                        type="button"
                        className="figy-extra-no"
                        onClick={() => setConfirming(null)}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className="figy-extra-yes"
                        onClick={() => {
                          setConfirming(null);
                          onRemoveDir(dir);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                }
                return (
                  <div className="figy-extra-row" key={dir}>
                    <FolderOpen size={11} className="figy-extra-icon" />
                    <span className="figy-extra-path truncate" title={dir}>
                      {collapseHome(dir)}
                    </span>
                    {/*
                      The same two numbers the project itself shows.
                      "The agent may also reach here" is a different
                      sentence when here is four files and when it is
                      forty thousand.
                    */}
                    <span className="figy-extra-count">
                      {count === undefined ? (
                        <span className="dim">counting…</span>
                      ) : count === null ? (
                        <span className="dim">unreadable</span>
                      ) : (
                        <>
                          {count.files.toLocaleString()} files ·{" "}
                          {count.folders.toLocaleString()} folders
                          {count.truncated && "+"}
                        </>
                      )}
                    </span>
                    <button
                      className="figy-iconbtn"
                      onClick={() => setConfirming(dir)}
                      title="Stop the agent reaching this folder"
                      aria-label={`Remove ${collapseHome(dir)}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ─── /resume ─────────────────────────────────────────────────────────────── */

/** `just now`, `14m ago`, `yesterday`, then the date. */
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
        <div className="figy-dialog-note">{RESUME_NOTE}</div>

        {conversations.length === 0 ? (
          <div className="figy-empty">{RESUME_EMPTY}</div>
        ) : (
          <div className="figy-resume-list">
            {conversations.map((conversation) => {
              /* The same title and the same meta line the editor
                 panel's list shows — it said "turns" where this said
                 "messages", about the same number. */
              const row = conversationRow(conversation);
              return (
                <div className="figy-resume-row" key={conversation.sessionId}>
                  <button
                    type="button"
                    className="figy-resume-open"
                    onClick={() => onResume(conversation.sessionId)}
                    title={row.title}
                  >
                    <MessageSquare size={12} className="figy-resume-icon" />
                    <span className="figy-resume-title truncate">{row.title}</span>
                    <span className="figy-resume-meta">{row.meta}</span>
                  </button>
                  <button
                    type="button"
                    className="figy-iconbtn"
                    onClick={() => onForget(conversation.sessionId)}
                    title="Forget this conversation"
                    aria-label={`Forget ${row.title}`}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
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
  /*
    Every figure, label, order and footnote comes from `usageView`,
    which the editor panel's spend view renders too. They used to
    compute their own and leave out different things — this one had the
    turn count and the spend total, that one did not, so the two
    screens about one session added up differently.
  */
  const view = usageView(totals);

  if (view.turns === 0) {
    return (
      <Dialog title="Tokens and spend" onClose={onClose}>
        <div className="figy-dialog-body">
          <div className="figy-empty">{USAGE_EMPTY}</div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Tokens and spend" onClose={onClose}>
      <div className="figy-dialog-body">
        {/*
          The two numbers somebody opened this for, before any of the
          detail: what it has cost, and whether the cache is working.
          Everything under them explains one or the other.
        */}
        <div className="figy-figures">
          <div className="figy-figure">
            <span className="figy-figure-value">{formatCost(view.total)}</span>
            <span className="figy-figure-label">this session</span>
            <span className="figy-figure-note">{formatCost(view.perTurn)} a turn</span>
          </div>
          <div className={`figy-figure ${view.healthy ? "good" : "warn"}`}>
            <span className="figy-figure-value">{view.hitRate}%</span>
            <span className="figy-figure-label">read from cache</span>
            <span className="figy-figure-note">{cacheWord(totals)}</span>
          </div>
          <div className="figy-figure">
            <span className="figy-figure-value">{view.turns}</span>
            <span className="figy-figure-label">turns</span>
            <span className="figy-figure-note">{formatTokens(totals.input)} in</span>
          </div>
        </div>

        {/*
          Input against output, to scale. The point it makes in one
          glance is the one the note used to make in a sentence: output
          is a rounding error, and almost all of what you pay for is the
          conversation being re-sent.
        */}
        <div className="figy-context-bar" role="img" aria-label="Where the tokens went">
          {view.flow
            .filter((one) => one.tokens > 0)
            .map((one) => (
              <span
                key={one.key}
                className={`figy-context-slice ${one.key}`}
                style={{ flexGrow: one.share }}
                title={`${formatTokens(one.tokens)} ${one.label.toLowerCase()}`}
              />
            ))}
        </div>

        <table className="figy-table figy-table-plain">
          <tbody>
            {view.flow.map((one) => (
              <tr key={one.key}>
                <td>
                  <span className={`figy-context-key ${one.key}`} /> {one.label}
                </td>
                <td className="num">{formatTokens(one.tokens)}</td>
                <td className="num figy-table-dim">{Math.round(one.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="figy-dialog-section">
          <div className="figy-dialog-section-head">Spend</div>
          <table className="figy-table figy-table-plain">
            <tbody>
              {view.spend.map((one) => (
                <tr key={one.key} className={one.total ? "figy-table-total" : ""}>
                  <td>
                    {one.label}
                    {one.note && <span className="figy-table-sub">{one.note}</span>}
                  </td>
                  <td className="num">{formatCost(one.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {view.largest && (
          <div className="figy-dialog-note muted">
            Largest single tool result: <strong>{formatTokens(view.largest.tokens)}</strong> tokens
            — {view.largest.note}.
          </div>
        )}

        {view.verdict && (
          <div className={`figy-card figy-notice ${view.verdict.healthy ? "info" : "warn"}`}>
            <div className="figy-notice-main">
              <div className="figy-notice-title">
                <span className="figy-notice-glyph">{view.verdict.healthy ? "◔" : "!"}</span>
                {view.verdict.value}{" "}
                {view.verdict.healthy ? "read from cache" : "read from cache — too low"}
              </div>
              <div className="figy-notice-body">{view.verdict.text}</div>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
