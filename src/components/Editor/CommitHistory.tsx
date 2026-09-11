import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronRight, GitMerge } from "lucide-react";
import { GitCommit, GitCommitFile, gitLog, relativeDate } from "../../services/git";
import { Remote } from "../../services/git-forge";
import { CommitDetail } from "./CommitDetail";
import { RemoteLink } from "./RemoteLink";

/**
 * The history tab: a list of commits, and the drawer one opens into.
 *
 * Both live here rather than in `SourceControl` because they are one view with
 * two states, and which pane is on screen is the whole interaction. Splitting
 * it across two components would put the list's scroll position in one and the
 * thing that covers it in the other.
 *
 * A drawer rather than an expanding row, which is what this was first. Folding
 * a commit open in place looked cheaper and wasn't: a commit message is a
 * paragraph, so unfolding one pushes every commit below it off a 300px column
 * — the list you were reading is gone either way, but with none of the room the
 * message needs and no way back except finding the row again.
 *
 * Paged, not infinite. `git log` will hand over forty thousand commits and
 * nobody is scrolling to the end of them, so it is a page and a button.
 *
 * Its own fetching, unlike `git status`: nothing else needs the log, and the
 * detail is a request per click, which belongs next to the click.
 */

interface CommitHistoryProps {
  /** The workspace folder; the backend resolves the repository from it. */
  dir: string;
  /** The forge behind the tracked remote, for the links on a SHA. */
  remote: Remote | null;
  /**
   * Changes when the repository might have. A commit here, a fetch, or a
   * commit or rebase in the pane behind all change what the history is.
   *
   * A string of both counters rather than their sum: two counters added
   * together read like arithmetic that means something, and this only has to
   * be different when either moves.
   */
  revision: string;
  onOpenDiff: (commit: GitCommit, file: GitCommitFile) => void;
  onError: (message: string) => void;
}

export function CommitHistory({
  dir,
  remote,
  revision,
  onOpenDiff,
  onError,
}: CommitHistoryProps) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState<GitCommit | null>(null);

  /**
   * Reloads from the top.
   *
   * Everything already loaded is discarded rather than merged. A new commit
   * shifts the whole list down by one, so "fetch page 0 and splice" produces
   * duplicates at every page boundary — and the pages after the first are only
   * there because somebody scrolled, which they can do again.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void gitLog(dir, 0)
      .then((page) => {
        if (cancelled) return;
        setCommits(page);
        setDone(page.length === 0);
      })
      .catch((e) => {
        if (cancelled) return;
        setCommits([]);
        onError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dir, revision, onError]);

  /**
   * A rewrite can take the open commit with it — an amend, a rebase, a reset —
   * and a drawer describing an object that no longer exists is a dead end. The
   * list it came from is still there, so it goes back to it.
   */
  useEffect(() => {
    if (!open || !commits) return;
    if (!commits.some((commit) => commit.sha === open.sha)) setOpen(null);
  }, [commits, open]);

  const loadMore = useCallback(() => {
    if (loading || done || !commits) return;
    setLoading(true);
    void gitLog(dir, commits.length)
      .then((page) => {
        // A short page means the end: asking again would return nothing and
        // the button would sit there forever offering to.
        setDone(page.length === 0);
        if (page.length > 0) setCommits((prev) => [...(prev ?? []), ...page]);
      })
      .catch((e) => onError(String(e)))
      .finally(() => setLoading(false));
  }, [dir, commits, loading, done, onError]);

  if (open) {
    return (
      <CommitDetail
        // Keyed by commit, so opening a different one animates in as a new
        // drawer rather than swapping its contents underneath you.
        key={open.sha}
        dir={dir}
        remote={remote}
        commit={open}
        onBack={() => setOpen(null)}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  return (
    <div className="editor-explorer-scroll flex-1 min-h-0 overflow-y-auto">
      {!commits ? (
        <div className="editor-explorer-empty px-3 py-4 text-[11px]">
          Reading the history…
        </div>
      ) : commits.length === 0 ? (
        <div className="editor-explorer-empty px-3 py-4 text-[11px]">
          Nothing has been committed yet.
        </div>
      ) : (
        <>
          {commits.map((commit) => (
            <Row
              key={commit.sha}
              commit={commit}
              remote={remote}
              onOpen={() => setOpen(commit)}
            />
          ))}

          {!done && (
            <button
              className="editor-btn-text w-full py-1.5 text-[10px]"
              onClick={loadMore}
              disabled={loading}
            >
              {loading ? "Loading…" : "Load older commits"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  commit,
  remote,
  onOpen,
}: {
  commit: GitCommit;
  remote: Remote | null;
  onOpen: () => void;
}) {
  /**
   * `HEAD -> main, origin/main, tag: v1` as chips.
   *
   * `HEAD -> ` is dropped from the branch it points at: the arrow is git's way
   * of saying "this is checked out", and the panel says that in its header
   * already.
   */
  const refs = useMemo(
    () =>
      commit.refs
        .split(",")
        .map((ref) => ref.trim().replace(/^HEAD -> /, ""))
        .filter((ref) => ref && ref !== "HEAD"),
    [commit.refs]
  );

  return (
    <div
      className="editor-row editor-scm-commit-row flex items-center gap-1.5 pl-2 pr-1 py-1"
      onClick={onOpen}
      title={`${commit.subject}\n\n${commit.author} <${commit.email}>\n${new Date(
        commit.date
      ).toLocaleString()}\n${commit.sha}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          {commit.merge && (
            <span className="editor-scm-merge shrink-0 flex" title="Merge commit">
              <GitMerge size={10} />
            </span>
          )}
          {/* Committed here and nowhere else. The arrow is the same one the
              Push button and the branch counter use, so the three read as one
              fact rather than three. */}
          {commit.unpushed && (
            <span
              className="editor-scm-unpushed shrink-0 flex"
              title="Not pushed yet — this commit is only on this machine"
              aria-label="Not pushed"
            >
              <ArrowUp size={10} />
            </span>
          )}
          <span className="editor-scm-subject text-[11px] truncate">{commit.subject}</span>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          <span className="editor-scm-meta text-[10px] truncate">
            {commit.author} · {relativeDate(commit.date)}
          </span>
          <RemoteLink
            remote={remote}
            sha={{ full: commit.sha, short: commit.short }}
            className="editor-scm-sha text-[10px] shrink-0 tabular-nums"
          />
        </div>

        {refs.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap mt-0.5">
            {refs.map((ref) => (
              <span key={ref} className="editor-scm-ref text-[9px] px-1 rounded">
                {ref.replace(/^tag: /, "")}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Says the row goes somewhere, which is the difference between this and
          a row that only selects. */}
      <ChevronRight size={12} className="editor-row-chevron shrink-0" />
    </div>
  );
}
