import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitGraph,
  GitMerge,
  GitMergeConflict,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  changeBadge,
  changeLabel,
  effectiveChange,
  gitStashList,
  GitCommit,
  GitCommitFile,
  GitFile,
  GitRepo,
  tally,
  tallyParts,
} from "../../services/git";
import { Remote } from "../../services/git-forge";
import { isMac } from "../../services/platform";
import { BranchPicker } from "./BranchPicker";
import { ChangeTally } from "./ChangeTally";
import { ConflictReport } from "./ConflictReport";
import { ConflictSection } from "./ConflictSection";
import { CommitHistory } from "./CommitHistory";
import { FileIcon } from "./fileIcons";
import { RemoteLink } from "./RemoteLink";
import { StashList } from "./StashList";

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

/** The three things that talk to the remote. */
type SyncKind = "fetch" | "pull" | "push";

/**
 * How long the busy state is held, however fast git was.
 *
 * A fetch against a warm connection returns in 200ms, and a spinner that
 * appears and vanishes inside a quarter of a second reads as a flicker rather
 * than as work — you are left unsure whether the click registered at all. So
 * the animation is given a floor: it runs smoothly for this long, then the
 * result appears. It costs nothing but patience, and the answer is already in
 * hand when the button settles.
 */
const SETTLE_MS = 5000;

/** What to say when git itself said nothing, per operation. */
const DONE_NOTE: Record<SyncKind, string> = {
  fetch: "Already up to date.",
  pull: "Already up to date.",
  push: "Nothing to push.",
};

/** Minimum gap between two counts of the stash stack; see the effect below. */
const STASH_COUNT_GAP_MS = 5_000;

/** Waits out the rest of [`SETTLE_MS`], if any of it is left. */
function settle(startedAt: number): Promise<void> {
  const left = SETTLE_MS - (Date.now() - startedAt);
  return left > 0 ? new Promise((resolve) => setTimeout(resolve, left)) : Promise.resolve();
}

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
  /** `line` is 1-based, and is how the conflict report jumps to a marker. */
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (file: GitFile) => void;
  onOpenCommitDiff: (commit: GitCommit, file: GitCommitFile) => void;
  /** Confirmed by the caller: this throws away work. */
  onDiscard: (files: GitFile[]) => void;
  /** Stages exactly `include`, unstages the rest, then commits. */
  onCommit: (message: string, include: GitFile[]) => Promise<void>;
  /** All three resolve with git's own output, which is worth showing either way. */
  onFetch: () => Promise<string>;
  onPull: () => Promise<string>;
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
  onPull,
  onPush,
  onError,
  onClose,
}: SourceControlProps) {
  const [tab, setTab] = useState<"changes" | "history" | "stashes">("changes");
  /** Open while a branch is being picked. */
  const [picking, setPicking] = useState(false);
  /** Open when a commit was attempted with conflicts still in the way. */
  const [reporting, setReporting] = useState(false);
  /**
   * How many stashes there are, for the tab's badge.
   *
   * Counted here rather than inside the tab, because the number is the reason
   * to open it: a stash nobody remembers making is exactly the work that gets
   * lost, and the tab is the only place it is ever mentioned.
   */
  const [stashCount, setStashCount] = useState(0);
  const [syncing, setSyncing] = useState<SyncKind | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  /**
   * Keeps the tab's badge roughly right without a process per keystroke.
   *
   * `revision` moves on every watcher burst — every save, every build touching
   * a file — and `git stash list` is a process. The stash stack changes when
   * somebody stashes, which is rare, so this is throttled hard and the tab
   * itself reports the exact number whenever it is open.
   */
  const countedAt = useRef(0);
  /** The branch the last count was for; a switch re-counts at once. */
  const branchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!repo.isRepo) {
      setStashCount(0);
      return;
    }
    // Not throttled on a change of branch: the tab lists this branch's stashes,
    // so switching changes the answer immediately and a stale badge would be
    // counting somewhere you no longer are.
    if (branchRef.current === repo.branch && Date.now() - countedAt.current < STASH_COUNT_GAP_MS) {
      return;
    }
    branchRef.current = repo.branch;
    countedAt.current = Date.now();

    let cancelled = false;
    void gitStashList(dir)
      .then((all) => {
        // Counting what the tab will show, not what the repository holds.
        const mine = all.filter((stash) => (stash.branch ?? null) === repo.branch);
        if (!cancelled) setStashCount(mine.length);
      })
      // A repository with no stashes and one that failed to answer look the
      // same from here, and neither is worth a message: the tab says nothing
      // instead of a wrong number.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dir, repo.isRepo, repo.branch, revision]);

  /*
    Conflicts are lifted out of the changes list entirely. A conflicted file is
    not a change waiting to be ticked — it cannot be committed at all until it
    is resolved — so leaving it among the checkboxes would offer an action that
    git is going to refuse.
  */
  const conflicted = useMemo(
    () => repo.files.filter((file) => effectiveChange(file) === "conflicted"),
    [repo.files]
  );
  const changes = useMemo(
    () => repo.files.filter((file) => effectiveChange(file) !== "conflicted"),
    [repo.files]
  );

  const included = useMemo(
    () => changes.filter((file) => !excluded.has(file.relative)),
    [changes, excluded]
  );

  const allIncluded = changes.length > 0 && included.length === changes.length;
  const noneIncluded = included.length === 0;

  /*
    Counted over every changed file, not only the ticked ones. The tally is
    describing the working tree — "this is what you have done" — while the
    checkboxes are about the next commit; recounting on every tick would make
    the two answer the same question twice.
  */
  const counted = useMemo(() => tally(changes.map(effectiveChange)), [changes]);

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
      prev.size > 0 ? new Set() : new Set(changes.map((file) => file.relative))
    );
  }, [changes]);

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

  /*
    Nothing is committed while a conflict is open. Git refuses it outright —
    "Committing is not possible because you have unmerged files" — so the
    button says so first, rather than the error bar saying it afterwards.
  */
  const canCommit = !!summary.trim() && included.length > 0 && !committing;

  /**
   * What the commit button does while a merge is open.
   *
   * Not disabled. A disabled button says no without saying why, and "why" —
   * which files, how many, where — is the only thing worth knowing at that
   * moment. So it stays pressable and answers the question; see
   * `ConflictReport`.
   */
  const blocked = conflicted.length > 0;

  const commit = useCallback(async () => {
    if (blocked) {
      setReporting(true);
      return;
    }
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
  }, [blocked, canCommit, message, included, onCommit]);

  /**
   * Fetch, pull and push, sharing one busy flag and one message line.
   *
   * The result is shown rather than swallowed: `git push` reports success on
   * stderr — "3b11460..a1b2c3d main -> main" — and "Everything up-to-date" is
   * an answer, not a non-event. A failure is git's own words, which for these
   * three is usually the only actionable thing there is (a rejected non-fast
   * forward, a missing credential helper, a conflicted merge).
   */
  const sync = useCallback(
    async (which: SyncKind) => {
      if (syncing) return;
      setSyncing(which);
      setSyncNote(null);
      const started = Date.now();
      try {
        const run = which === "fetch" ? onFetch : which === "pull" ? onPull : onPush;
        const reply = await run();
        await settle(started);
        setSyncNote(reply.trim() || DONE_NOTE[which]);
      } catch (e) {
        await settle(started);
        setSyncNote(String(e));
      } finally {
        setSyncing(null);
      }
    },
    [syncing, onFetch, onPull, onPush]
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

  /**
   * Whether the remote has commits this branch hasn't got.
   *
   * While that is true a push is going to be rejected, so the button says so
   * instead of spending a round trip to find out.
   */
  const blockedByBehind = repo.behind > 0 && !!repo.upstream;

  return (
    <div className="editor-explorer flex flex-col h-full min-h-0">
      <Header onRefresh={onRefresh} busy={busy} onClose={onClose} />

      <div className="editor-scm-branch flex items-center gap-1.5 px-2 py-1 shrink-0">
        {/*
          The branch name is the switcher. It is where the eye already goes to
          answer "where am I", which makes it the one place somebody looks when
          the answer is wrong — and a separate button for it would sit next to
          the name saying the same word twice.

          The link to the forge moves to a following icon when there is one:
          the name has to be a button, and a button that is also a link opens a
          browser when you meant to switch branch.
        */}
        <button
          className="editor-scm-branchbtn flex items-center gap-1.5 min-w-0 flex-1 text-left rounded px-1 py-0.5"
          onClick={() => setPicking(true)}
          title="Switch branch"
        >
          <GitBranch size={11} className="shrink-0 opacity-70" />
          <span className="text-[11px] truncate">{branch}</span>
          <ChevronDown size={10} className="shrink-0 opacity-60" />
        </button>
        {!repo.detached && repo.branch && (
          <RemoteLink remote={remote} branch={repo.branch} iconOnly className="shrink-0" />
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
            className="editor-scm-count behind flex items-center text-[10px] tabular-nums"
            title={`${repo.behind} commit${repo.behind === 1 ? "" : "s"} to pull — push is held until you do`}
          >
            <ArrowDown size={9} />
            {repo.behind}
          </span>
        )}
      </div>

      {/*
        Three buttons, not "sync". They do different things — fetch reads, pull
        writes the working tree, push writes the remote — and a single button
        that guesses which you meant is a button that occasionally pushes when
        you wanted to look.

        The icons are the operations' own: a cloud for the two that only move
        refs over the network, and a *merge* glyph for pull, because that is
        what makes pull different from fetch — it changes the branch you are
        standing on.

        Nothing spins. A rotating cloud says "a thing is turning", which is not
        what is happening; the button instead carries a progress line along its
        bottom edge and names what it is doing. See `.editor-scm-syncbtn.busy`.
      */}
      <div className="editor-scm-sync flex items-center gap-1 px-2 py-1 shrink-0">
        <button
          className={`editor-scm-syncbtn flex items-center justify-center gap-1.5 flex-1 py-1 rounded text-[10px] ${
            syncing === "fetch" ? "busy" : ""
          }`}
          onClick={() => void sync("fetch")}
          disabled={!!syncing}
          title="Update the remote-tracking branches. Changes nothing here."
        >
          <CloudDownload size={12} className="shrink-0" />
          {syncing === "fetch" ? "Fetching…" : "Fetch"}
        </button>

        {/*
          Accented once there is something to pull: the number is the reason to
          press it, and while it is there, Push is not available.
        */}
        <button
          className={`editor-scm-syncbtn flex items-center justify-center gap-1.5 flex-1 py-1 rounded text-[10px] ${
            syncing === "pull" ? "busy" : ""
          } ${!syncing && repo.behind > 0 ? "pending" : ""}`}
          onClick={() => void sync("pull")}
          disabled={!!syncing || repo.detached || !repo.upstream}
          title={
            repo.detached
              ? "HEAD is detached, so there is no branch to pull into"
              : !repo.upstream
                ? "This branch has no upstream to pull from — publish it first"
                : `Merge ${repo.behind || "nothing new"} from ${repo.upstream} into this branch`
          }
        >
          <GitMerge size={12} className="shrink-0" />
          {syncing === "pull" ? "Pulling…" : repo.behind > 0 ? `Pull ${repo.behind}` : "Pull"}
        </button>

        {/*
          Held back while the branch is behind.

          Git would refuse the push anyway — a non-fast-forward is rejected by
          the remote — so the choice is between finding that out from a wall of
          hint text after a round trip, or from a button that says what to do
          first. The Pull beside it is already lit amber, so the answer is one
          inch to the left.
        */}
        <button
          className={`editor-scm-syncbtn flex items-center justify-center gap-1.5 flex-1 py-1 rounded text-[10px] ${
            syncing === "push" ? "busy" : ""
          } ${!syncing && !blockedByBehind && (repo.ahead > 0 || !repo.upstream) ? "pending" : ""}`}
          onClick={() => void sync("push")}
          disabled={!!syncing || repo.detached || blockedByBehind}
          title={
            repo.detached
              ? "HEAD is detached, so there is no branch to push"
              : blockedByBehind
                ? `Pull the ${repo.behind} commit${repo.behind === 1 ? "" : "s"} from ${
                    repo.upstream
                  } first — the remote will reject a push that isn't a fast-forward`
                : repo.upstream
                  ? `Push ${repo.ahead || "nothing new"} to ${repo.upstream}`
                  : "Publish this branch, setting its upstream"
          }
        >
          <CloudUpload size={12} className="shrink-0" />
          {syncing === "push"
            ? "Pushing…"
            : !repo.upstream
              ? "Publish"
              : repo.ahead > 0
                ? `Push ${repo.ahead}`
                : "Push"}
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
          className={`editor-scm-tab flex items-center justify-center gap-1.5 flex-1 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            tab === "changes" ? "on" : ""
          }`}
          onClick={() => setTab("changes")}
        >
          Changes
          {conflicted.length > 0 ? (
            <TabCount value={conflicted.length} on={tab === "changes"} kind="conflict" />
          ) : (
            changes.length > 0 && <TabCount value={changes.length} on={tab === "changes"} />
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`editor-scm-tab flex items-center justify-center gap-1.5 flex-1 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            tab === "history" ? "on" : ""
          }`}
          onClick={() => setTab("history")}
        >
          History
        </button>
        <button
          role="tab"
          aria-selected={tab === "stashes"}
          className={`editor-scm-tab flex items-center justify-center gap-1.5 flex-1 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            tab === "stashes" ? "on" : ""
          }`}
          onClick={() => setTab("stashes")}
          title="Changes put aside, and how to get them back"
        >
          Stashes
          {stashCount > 0 && <TabCount value={stashCount} on={tab === "stashes"} />}
        </button>
      </div>

      {tab === "stashes" ? (
        <StashList
          dir={dir}
          branch={repo.branch}
          revision={revision}
          onCount={setStashCount}
          onDone={onRefresh}
          onError={onError}
        />
      ) : tab === "history" ? (
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
          <ConflictSection
            dir={dir}
            files={conflicted}
            merging={repo.merging}
            mergeHead={repo.mergeHead}
            onOpenFile={onOpenFile}
            onRefresh={onRefresh}
            onError={onError}
          />

          {changes.length > 0 && (
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
                  {changes.length} changed {changes.length === 1 ? "file" : "files"}
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
            {changes.length === 0 ? (
              <div className="editor-explorer-empty px-3 py-4 text-[11px]">
                {conflicted.length > 0
                  ? "Nothing else has changed — resolve the conflicts above."
                  : "Nothing has changed since the last commit."}
              </div>
            ) : (
              changes.map((file) => (
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
              className={`editor-scm-button flex items-center justify-center gap-1.5 w-full mt-1.5 py-1.5 rounded text-[11px] ${
                blocked ? "blocked" : ""
              }`}
              onClick={() => void commit()}
              disabled={!blocked && !canCommit}
              title={
                blocked
                  ? `Resolve ${conflicted.length} conflicted file${
                      conflicted.length === 1 ? "" : "s"
                    } first — press to see where they are`
                  : included.length === 0
                    ? "Select at least one file"
                    : !summary.trim()
                      ? "A commit needs a summary"
                      : `Commit ${included.length} file${
                          included.length === 1 ? "" : "s"
                        } to ${branch}`
              }
            >
              {blocked ? <GitMergeConflict size={12} /> : <Check size={12} />}
              <span className="truncate">
                {committing
                  ? "Committing…"
                  : blocked
                    ? `Resolve ${conflicted.length} file${
                        conflicted.length === 1 ? "" : "s"
                      } to commit`
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

      {reporting && (
        <ConflictReport
          dir={dir}
          files={conflicted}
          onOpen={(path, line) => onOpenFile(path, line)}
          onClose={() => setReporting(false)}
          onError={onError}
        />
      )}

      {picking && (
        <BranchPicker
          dir={dir}
          current={repo.detached ? null : repo.branch}
          /*
            Any change at all counts as dirty, staged or not: a checkout has to
            deal with both, and "you have uncommitted changes" is the same
            sentence either way.
          */
          dirty={repo.files.length > 0}
          onDone={onRefresh}
          onClose={() => setPicking(false)}
          onError={onError}
        />
      )}
    </div>
  );
}

/**
 * The number on a tab.
 *
 * A chip rather than a bare digit: "Stashes 2" reads as a phrase, and at this
 * size the 2 was being taken for part of the word. The background also gives
 * the count somewhere to live that doesn't move as the label changes width.
 */
function TabCount({
  value,
  on,
  kind,
}: {
  value: number;
  on: boolean;
  /** `conflict` colours it red: the number means "blocked", not "waiting". */
  kind?: "conflict";
}) {
  return (
    <span className={`editor-scm-tabcount tabular-nums ${on ? "on" : ""} ${kind ?? ""}`}>
      {value}
    </span>
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
      <GitGraph size={12} className="editor-explorer-title shrink-0" />
      <span className="editor-explorer-title text-[10px] font-semibold uppercase tracking-wide truncate flex-1">
        Source Control
      </span>
      {/*
        Not spun while busy. `busy` is only ever true during a fetch, pull or
        push, and each of those already draws its own progress on the button
        that started it — a second animation up here, on a *refresh* icon, said
        the status was reloading when it wasn't. It goes unavailable instead,
        which is the true statement: git is occupied.
      */}
      <button
        className="editor-icon-btn p-0.5 rounded"
        onClick={onRefresh}
        disabled={busy}
        title={busy ? "Waiting for git…" : "Refresh"}
        aria-label="Refresh"
      >
        <RefreshCw size={12} />
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
