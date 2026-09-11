import { useCallback, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  CloudUpload,
  GitBranch,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  changeBadge,
  changeLabel,
  effectiveChange,
  GitCommit,
  GitCommitFile,
  GitFile,
  GitRepo,
  tally,
  tallyParts,
} from "../../services/git";
import { Remote } from "../../services/git-forge";
import { isMac } from "../../services/platform";
import { ChangeTally } from "./ChangeTally";
import { CommitHistory } from "./CommitHistory";
import { FileIcon } from "./fileIcons";
import { RemoteLink } from "./RemoteLink";

/**
 * The changes panel, shaped like GitHub Desktop's.
 *
 * Which means: **the index is not on screen.** One flat list of what changed, a
 * checkbox per file saying whether it goes in the next commit, and a commit box
 * at the bottom. No "Staged Changes" group, no stage and unstage buttons.
 *
 * That is a real choice and it costs something. Git's index is a genuine third
 * state, and a file half-staged from the terminal cannot be represented here —
 * this panel will commit all of that file or none of it. What it buys is the
 * question most people actually have, which is "which of these am I committing
 * right now", answered without having to first learn what an index is. VS
 * Code's two-group layout answers a different question well; this one answers
 * the common one.
 *
 * So committing has to *make* the index match the checkboxes: stage everything
 * ticked, unstage everything not, then commit. `EditorModal` does that in one
 * go, which is why there is a single `onCommit` here and no staging callbacks.
 *
 * The checkbox state is tracked as the *excluded* set, not the included one.
 * With `included`, a file appearing while you type a commit message — a build
 * touching something, a save in another tab — would arrive unchecked and be
 * silently left out. Excluding by exception means anything new is in by
 * default, which is both what GitHub Desktop does and the safer direction to
 * be wrong in.
 */

interface SourceControlProps {
  repo: GitRepo;
  /** The workspace folder, for the history tab's own queries. */
  dir: string;
  /** The forge behind the tracked remote, or null when there is nowhere to link. */
  remote: Remote | null;
  /** A git-level failure — no `git` on PATH, a locked index — not "no repo". */
  error: string | null;
  busy: boolean;
  /** Changes when the repository might have, so the history reloads. */
  revision: string;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
  onOpenDiff: (file: GitFile) => void;
  onOpenCommitDiff: (commit: GitCommit, file: GitCommitFile) => void;
  /** Confirmed by the caller: this throws away work. */
  onDiscard: (files: GitFile[]) => void;
  /** Stages exactly `include`, unstages the rest, then commits. */
  onCommit: (message: string, include: GitFile[]) => Promise<void>;
  /** Both resolve with git's own output, which is worth showing either way. */
  onFetch: () => Promise<string>;
  onPush: () => Promise<string>;
  onError: (message: string) => void;
  onClose: () => void;
}

export function SourceControl({
  repo,
  dir,
  remote,
  error,
  busy,
  revision,
  onRefresh,
  onOpenFile,
  onOpenDiff,
  onOpenCommitDiff,
  onDiscard,
  onCommit,
  onFetch,
  onPush,
  onError,
  onClose,
}: SourceControlProps) {
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [syncing, setSyncing] = useState<"fetch" | "push" | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const included = useMemo(
    () => repo.files.filter((file) => !excluded.has(file.relative)),
    [repo.files, excluded]
  );

  const allIncluded = repo.files.length > 0 && included.length === repo.files.length;
  const noneIncluded = included.length === 0;

  /*
    Counted over every changed file, not only the ticked ones. The tally is
    describing the working tree — "this is what you have done" — while the
    checkboxes are about the next commit; recounting on every tick would make
    the two answer the same question twice.
  */
  const counted = useMemo(
    () => tally(repo.files.map(effectiveChange)),
    [repo.files]
  );

  const toggleFile = useCallback((relative: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(relative)) next.delete(relative);
      else next.add(relative);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExcluded((prev) =>
      prev.size > 0 ? new Set() : new Set(repo.files.map((file) => file.relative))
    );
  }, [repo.files]);

  /**
   * Summary and description, joined git's way.
   *
   * A blank line between them is not decoration: it is what makes the summary
   * the subject line for `git log --oneline`, every review tool and every
   * commit hook that reads one.
   */
  const message = useMemo(() => {
    const subject = summary.trim();
    const body = description.trim();
    return body ? `${subject}\n\n${body}` : subject;
  }, [summary, description]);

  const canCommit = !!summary.trim() && included.length > 0 && !committing;

  const commit = useCallback(async () => {
    if (!canCommit) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await onCommit(message, included);
      setSummary("");
      setDescription("");
      setExcluded(new Set());
    } catch (e) {
      // Git's own words: "Please tell me who you are", a failing pre-commit
      // hook, a merge in progress. All actionable, none improved by rewording.
      setCommitError(String(e));
    } finally {
      setCommitting(false);
    }
  }, [canCommit, message, included, onCommit]);

  /**
   * Fetch and push, sharing one busy flag and one message line.
   *
   * The result is shown rather than swallowed: `git push` reports success on
   * stderr — "3b11460..a1b2c3d main -> main" — and "Everything up-to-date" is
   * an answer, not a non-event. A failure is git's own words, which for these
   * two is usually the only actionable thing there is (a rejected non-fast
   * forward, a missing credential helper).
   */
  const sync = useCallback(
    async (which: "fetch" | "push") => {
      if (syncing) return;
      setSyncing(which);
      setSyncNote(null);
      try {
        const reply = await (which === "fetch" ? onFetch() : onPush());
        setSyncNote(
          reply.trim() ||
            (which === "fetch" ? "Already up to date." : "Nothing to push.")
        );
      } catch (e) {
        setSyncNote(String(e));
      } finally {
        setSyncing(null);
      }
    },
    [syncing, onFetch, onPush]
  );

  if (!repo.isRepo) {
    return (
      <div className="editor-explorer flex flex-col h-full min-h-0">
        <Header onRefresh={onRefresh} busy={busy} onClose={onClose} />
        <div className="editor-explorer-empty px-3 py-4 text-[11px]">
          {error ? (
            <span className="editor-explorer-error">{error}</span>
          ) : (
            "This folder is not in a git repository."
          )}
        </div>
      </div>
    );
  }

  const branch = repo.detached ? "detached HEAD" : repo.branch ?? "no branch";

  return (
    <div className="editor-explorer flex flex-col h-full min-h-0">
      <Header onRefresh={onRefresh} busy={busy} onClose={onClose} />

      <div className="editor-scm-branch flex items-center gap-1.5 px-2 py-1 shrink-0">
        <GitBranch size={11} className="shrink-0 opacity-70" />
        {repo.detached || !repo.branch ? (
          <span className="text-[11px] truncate flex-1">{branch}</span>
        ) : (
          <RemoteLink
            remote={remote}
            branch={repo.branch}
            className="text-[11px] min-w-0 flex-1"
          />
        )}
        {repo.ahead > 0 && (
          <span
            className="editor-scm-count pending flex items-center text-[10px] tabular-nums"
            title={`${repo.ahead} commit${repo.ahead === 1 ? "" : "s"} to push`}
          >
            <ArrowUp size={9} />
            {repo.ahead}
          </span>
        )}
        {repo.behind > 0 && (
          <span
            className="editor-scm-count flex items-center text-[10px] tabular-nums"
            title={`${repo.behind} commit${repo.behind === 1 ? "" : "s"} to pull`}
          >
            <ArrowDown size={9} />
            {repo.behind}
          </span>
        )}
      </div>

      {/*
        Fetch and push, not "sync". They do different things — one reads, one
        writes — and a single button that guesses which you meant is a button
        that occasionally pushes when you wanted to look.

        Pull is absent on purpose: it merges, a merge conflicts, and a conflict
        needs somewhere to be resolved. Fetch tells you that you are behind, and
        the shell is three inches away.
      */}
      <div className="editor-scm-sync flex items-center gap-1 px-2 py-1 shrink-0">
        {/*
          The label does not change while it runs, and the spinner does not
          take its place: a centred icon-plus-text group re-centres itself as
          "Fetch" becomes "Fetching…", so the icon slides sideways and the whole
          button appears to twitch. The spin, the dimming and the disabled
          state say it is working without moving anything.
        */}
        <button
          className={`editor-scm-syncbtn flex items-center justify-center gap-1.5 flex-1 py-1 rounded text-[10px] ${
            syncing === "fetch" ? "busy" : ""
          }`}
          onClick={() => void sync("fetch")}
          disabled={!!syncing}
          title="Update the remote-tracking branches. Changes nothing here."
        >
          <RefreshCw size={11} className={syncing === "fetch" ? "editor-spin" : undefined} />
          Fetch
        </button>
        {/*
          Accented once there is something to push. The button is otherwise
          identical to Fetch, and "you have work only on this machine" is worth
          more than a number nobody was looking for.
        */}
        <button
          className={`editor-scm-syncbtn flex items-center justify-center gap-1.5 flex-1 py-1 rounded text-[10px] ${
            syncing === "push" ? "busy" : ""
          } ${!syncing && (repo.ahead > 0 || !repo.upstream) ? "pending" : ""}`}
          onClick={() => void sync("push")}
          disabled={!!syncing || repo.detached}
          title={
            repo.detached
              ? "HEAD is detached, so there is no branch to push"
              : repo.upstream
                ? `Push ${repo.ahead || "nothing new"} to ${repo.upstream}`
                : "Publish this branch, setting its upstream"
          }
        >
          <CloudUpload size={11} className={syncing === "push" ? "editor-spin" : undefined} />
          {!repo.upstream ? "Publish" : repo.ahead > 0 ? `Push ${repo.ahead}` : "Push"}
        </button>
      </div>

      {/*
        Always mounted, animated open. Inserting it into the flow snapped the
        tabs and the whole file list down by its height the instant a fetch
        finished, which is the jump; a height transition on a row that is
        already there moves them at a speed the eye can follow.
      */}
      <div
        className={`editor-scm-notewrap shrink-0 ${syncNote ? "open" : ""}`}
        aria-live="polite"
      >
        <div className="editor-scm-note flex items-start gap-1.5 mx-2 mb-1 px-1.5 py-1 rounded text-[10px]">
          <span className="flex-1 min-w-0 break-words whitespace-pre-wrap">{syncNote}</span>
          <button
            className="editor-btn p-0.5 rounded shrink-0"
            onClick={() => setSyncNote(null)}
            aria-label="Dismiss"
            tabIndex={syncNote ? 0 : -1}
          >
            <X size={9} />
          </button>
        </div>
      </div>

      <div className="editor-scm-tabs flex shrink-0" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "changes"}
          className={`editor-scm-tab flex-1 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            tab === "changes" ? "on" : ""
          }`}
          onClick={() => setTab("changes")}
        >
          Changes{repo.files.length > 0 && ` ${repo.files.length}`}
        </button>
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`editor-scm-tab flex-1 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            tab === "history" ? "on" : ""
          }`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "history" ? (
        /*
          `overflow-hidden`, because the drawer inside slides in from the right
          and would otherwise widen the panel for the length of the animation.
          The scroll container is the history's own: it has two of them, one per
          pane, and they keep their positions independently.
        */
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Mounted only while the tab is open, so opening the panel on
              Changes costs no `git log` at all. */}
          <CommitHistory
            dir={dir}
            remote={remote}
            revision={revision}
            onOpenDiff={onOpenCommitDiff}
            onError={onError}
          />
        </div>
      ) : (
        <>
          {repo.files.length > 0 && (
            <div className="editor-scm-selectall px-2 py-1 shrink-0">
              <label className="flex items-center gap-2 text-[11px]">
                <Checkbox
                  checked={allIncluded}
                  /* Some but not all: drawn as a dash, so "12 of 20 files" is
                     distinguishable from "none" at a glance. */
                  indeterminate={!allIncluded && !noneIncluded}
                  onChange={toggleAll}
                  label={allIncluded ? "Deselect every file" : "Select every file"}
                />
                <span className="truncate">
                  {repo.files.length} changed {repo.files.length === 1 ? "file" : "files"}
                  {!allIncluded && (
                    <span className="editor-scm-count"> · {included.length} selected</span>
                  )}
                </span>
              </label>
              <div className="pl-[21px] text-[10px]">
                <ChangeTally parts={tallyParts(counted)} />
              </div>
            </div>
          )}

          <div className="editor-explorer-scroll flex-1 min-h-0 overflow-y-auto">
            {repo.files.length === 0 ? (
              <div className="editor-explorer-empty px-3 py-4 text-[11px]">
                Nothing has changed since the last commit.
              </div>
            ) : (
              repo.files.map((file) => (
                <Row
                  key={file.relative}
                  file={file}
                  included={!excluded.has(file.relative)}
                  onToggle={() => toggleFile(file.relative)}
                  onOpenDiff={() => onOpenDiff(file)}
                  onOpenFile={() => onOpenFile(file.path)}
                  onDiscard={() => onDiscard([file])}
                />
              ))
            )}

            {repo.truncated && (
              <div className="editor-explorer-empty px-3 py-2 text-[10px]">
                Only the first 5,000 changed files are listed.
              </div>
            )}
          </div>

          {/* Bottom, as in GitHub Desktop: the list is what you read, this is what
              you do about it. */}
          <div className="editor-scm-commit px-2 py-2 shrink-0">
            <input
              className="editor-scm-summary w-full text-[11px] px-2 py-1.5 rounded"
              placeholder="Summary (required)"
              spellCheck={false}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
              onKeyUp={(e) => e.stopPropagation()}
            />
            <textarea
              className="editor-scm-message w-full text-[11px] px-2 py-1.5 mt-1 rounded resize-none"
              rows={2}
              placeholder={`Description (${isMac ? "⌘↵" : "Ctrl+Enter"} to commit)`}
              spellCheck={false}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commit();
                }
              }}
              onKeyUp={(e) => e.stopPropagation()}
            />

            <button
              className="editor-scm-button flex items-center justify-center gap-1.5 w-full mt-1.5 py-1.5 rounded text-[11px]"
              onClick={() => void commit()}
              disabled={!canCommit}
              title={
                included.length === 0
                  ? "Select at least one file"
                  : !summary.trim()
                    ? "A commit needs a summary"
                    : `Commit ${included.length} file${included.length === 1 ? "" : "s"} to ${branch}`
              }
            >
              <Check size={12} />
              <span className="truncate">
                {committing
                  ? "Committing…"
                  : `Commit ${included.length || ""} ${
                      included.length === 1 ? "file" : "files"
                    } to ${branch}`.replace(/\s+/g, " ")}
              </span>
            </button>

            {commitError && (
              <div className="editor-scm-error flex items-start gap-1.5 mt-1.5 px-1.5 py-1 rounded text-[10px]">
                <CircleAlert size={11} className="shrink-0 mt-px" />
                <span className="flex-1 min-w-0 break-words">{commitError}</span>
                <button
                  className="editor-btn p-0.5 rounded shrink-0"
                  onClick={() => setCommitError(null)}
                  aria-label="Dismiss"
                >
                  <X size={9} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Header({
  onRefresh,
  busy,
  onClose,
}: {
  onRefresh: () => void;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div className="editor-explorer-header flex items-center gap-1 px-2 h-[26px] shrink-0">
      <span className="editor-explorer-title text-[10px] font-semibold uppercase tracking-wide truncate flex-1">
        Changes
      </span>
      <button
        className="editor-icon-btn p-0.5 rounded"
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshCw size={12} className={busy ? "editor-spin" : undefined} />
      </button>
      <button
        className="editor-icon-btn p-0.5 rounded"
        onClick={onClose}
        title="Back to the file tree"
        aria-label="Back to the file tree"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function Row({
  file,
  included,
  onToggle,
  onOpenDiff,
  onOpenFile,
  onDiscard,
}: {
  file: GitFile;
  included: boolean;
  onToggle: () => void;
  onOpenDiff: () => void;
  onOpenFile: () => void;
  onDiscard: () => void;
}) {
  const change = effectiveChange(file);
  const cut = file.relative.lastIndexOf("/");
  const name = cut < 0 ? file.relative : file.relative.slice(cut + 1);

  return (
    <div
      className={`editor-row editor-scm-row group flex items-center gap-1.5 px-2 git-${change} ${
        included ? "" : "excluded"
      }`}
      /* The folder is in the tooltip rather than the row. Two files called
         `mod.rs` are otherwise indistinguishable here, and the diff header
         above shows the full path once one is open. */
      title={
        file.from
          ? `${changeLabel(change)} from ${file.from}`
          : `${changeLabel(change)} — ${file.relative}`
      }
      /* Single click shows the diff, double click opens the file for editing.
         From this panel you are looking at what changed, not at the file. */
      onClick={onOpenDiff}
      onDoubleClick={onOpenFile}
    >
      <Checkbox
        checked={included}
        onChange={onToggle}
        label={included ? `Leave ${name} out of the commit` : `Include ${name} in the commit`}
      />
      <FileIcon path={file.relative} size={12} />
      <span className="editor-row-name text-[12px] truncate flex-1 min-w-0">{name}</span>

      <button
        className="editor-scm-action danger p-0.5 rounded shrink-0"
        title={
          change === "untracked"
            ? "Move this file to the trash"
            : "Discard these changes"
        }
        aria-label="Discard"
        onClick={(e) => {
          e.stopPropagation();
          onDiscard();
        }}
      >
        <RotateCcw size={11} />
      </button>

      <span
        className="editor-scm-status text-[10px] shrink-0"
        aria-label={changeLabel(change)}
      >
        {changeBadge(change)}
      </span>
    </div>
  );
}

/**
 * A real `<input type=checkbox>`, restyled.
 *
 * Not a styled `<button>`: this one is genuinely a checkbox — a screen reader
 * should say so, space should toggle it, and `indeterminate` is a DOM property
 * with no CSS or attribute equivalent, so it has to be set on the element.
 */
function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="editor-scm-checkbox shrink-0"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      title={label}
      aria-label={label}
    />
  );
}
