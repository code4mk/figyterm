import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleAlert, GitMerge } from "lucide-react";
import {
  changeBadge,
  changeLabel,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  gitCommitDetail,
  relativeDate,
  tally,
  tallyParts,
} from "../../services/git";
import { FileIcon } from "./fileIcons";
import { ChangeTally } from "./ChangeTally";

/**
 * One commit, in the panel the list was in.
 *
 * A drawer rather than an expanding row. Expanding in place looked cheaper and
 * wasn't: a commit message is a paragraph, and unfolding one pushes every
 * commit below it off a 300px column, so the list you were reading is gone
 * anyway — with none of the room a message needs and no way back except finding
 * the row again. Replacing the pane admits what is happening and gives the
 * message the whole width.
 *
 * It slides in from the right, which is not decoration: two panes with no
 * transition between them look like the panel was replaced, and the animation
 * is what says the list is still behind this and Back will return to it.
 *
 * The commit's metadata comes from the same `git log` fields the row does, so
 * the drawer and the row it was opened from can never disagree about what a
 * commit says.
 */

interface CommitDetailProps {
  dir: string;
  /** The row that was clicked, so the header can draw before the load lands. */
  commit: GitCommit;
  onBack: () => void;
  onOpenDiff: (commit: GitCommit, file: GitCommitFile) => void;
}

export function CommitDetail({ dir, commit, onBack, onOpenDiff }: CommitDetailProps) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);

    void gitCommitDetail(dir, commit.sha)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [dir, commit.sha]);

  const totals = useMemo(() => {
    const files = detail?.files ?? [];
    return {
      counted: tally(files.map((file) => file.change)),
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
  }, [detail]);

  const refs = useMemo(
    () =>
      commit.refs
        .split(",")
        .map((ref) => ref.trim().replace(/^HEAD -> /, ""))
        .filter((ref) => ref && ref !== "HEAD"),
    [commit.refs]
  );

  return (
    <div className="editor-scm-drawer flex flex-col h-full min-h-0">
      <div className="editor-scm-drawer-bar flex items-center gap-1 px-1.5 h-[26px] shrink-0">
        <button
          className="editor-btn-text flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
          onClick={onBack}
          title="Back to the history"
          aria-label="Back to the history"
        >
          <ArrowLeft size={11} />
          Back
        </button>
        <div className="flex-1" />
        <span className="editor-scm-sha text-[10px] tabular-nums shrink-0">
          {commit.short}
        </span>
      </div>

      <div className="editor-explorer-scroll flex-1 min-h-0 overflow-y-auto">
        <div className="editor-scm-drawer-head px-2.5 py-2">
          <div className="flex items-start gap-1.5">
            {commit.merge && (
              <span className="editor-scm-merge shrink-0 flex mt-0.5" title="Merge commit">
                <GitMerge size={11} />
              </span>
            )}
            {/* Wrapped, not truncated: the subject is the one line of a commit
                that has to be readable, and this is the pane that has room. */}
            <h2 className="editor-scm-drawer-title text-[12px] font-semibold leading-snug">
              {commit.subject}
            </h2>
          </div>

          <div className="editor-scm-meta text-[10px] mt-1">
            {commit.author} &lt;{commit.email}&gt;
          </div>
          <div
            className="editor-scm-meta text-[10px]"
            title={new Date(commit.date).toLocaleString()}
          >
            {relativeDate(commit.date)}
          </div>

          {refs.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {refs.map((ref) => (
                <span key={ref} className="editor-scm-ref text-[9px] px-1 rounded">
                  {ref.replace(/^tag: /, "")}
                </span>
              ))}
            </div>
          )}
        </div>

        {detail?.body && <Body text={detail.body} />}

        {error ? (
          <div className="editor-scm-error flex items-start gap-1.5 mx-2 my-2 px-1.5 py-1 rounded text-[10px]">
            <CircleAlert size={11} className="shrink-0 mt-px" />
            <span className="flex-1 min-w-0 break-words">{error}</span>
          </div>
        ) : !detail ? (
          <div className="editor-explorer-empty px-3 py-3 text-[11px]">Reading…</div>
        ) : (
          <>
            <div className="editor-scm-drawer-stat px-2.5 py-1.5 text-[10px]">
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">
                  {totals.counted.total} {totals.counted.total === 1 ? "file" : "files"}{" "}
                  changed
                </span>
                <span className="editor-diff-plus tabular-nums">+{totals.added}</span>
                <span className="editor-diff-minus tabular-nums">−{totals.removed}</span>
              </div>
              <ChangeTally parts={tallyParts(totals.counted)} />
            </div>

            {detail.files.length === 0 ? (
              <div className="editor-explorer-empty px-3 py-2 text-[10px]">
                {/* An empty commit, or a merge that changed nothing against its
                    first parent — both real, and both worth saying. */}
                No file changes in this commit.
              </div>
            ) : (
              detail.files.map((file) => {
                const cut = file.relative.lastIndexOf("/");
                const name = cut < 0 ? file.relative : file.relative.slice(cut + 1);
                return (
                  <div
                    key={file.relative}
                    className={`editor-row editor-scm-row flex items-center gap-1.5 px-2.5 git-${file.change}`}
                    title={
                      file.from
                        ? `${changeLabel(file.change)} from ${file.from}`
                        : `${changeLabel(file.change)} — ${file.relative}`
                    }
                    onClick={() => onOpenDiff(commit, file)}
                  >
                    <FileIcon path={file.relative} size={12} />
                    <span className="editor-row-name text-[12px] truncate flex-1 min-w-0">
                      {name}
                    </span>
                    {(file.added > 0 || file.removed > 0) && (
                      <span className="editor-scm-filestat text-[9px] shrink-0 tabular-nums">
                        <span className="editor-diff-plus">+{file.added}</span>{" "}
                        <span className="editor-diff-minus">−{file.removed}</span>
                      </span>
                    )}
                    <span
                      className="editor-scm-status text-[10px] shrink-0"
                      aria-label={changeLabel(file.change)}
                    >
                      {changeBadge(file.change)}
                    </span>
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Above this many lines, or this many characters, the body is worth folding.
 *
 * Both, because either alone gets it wrong: six lines of prose that wrap three
 * times each is a wall of text by any measure, and one 900-character line is a
 * wall of text with one newline in it.
 */
const LONG_LINES = 6;
const LONG_CHARS = 400;

/**
 * The commit message below the subject.
 *
 * Pre-wrapped, in the editor's own monospace. A commit body is written against
 * a fixed width — its lists, its indentation and its wrapping are all
 * deliberate — and reflowing it as prose loses every one of those decisions.
 *
 * Folded when it is long, because a thorough message is the *reason* to open a
 * commit and also the thing that pushes its file list off the bottom of a
 * 300px column. Collapsed by height rather than by slicing the text: cutting a
 * string at 400 characters lands mid-word, mid-list and mid-code-fence, and
 * expanding it then reflows everything below. A `max-height` with a fade shows
 * a real partial line, which is what says there is more.
 */
function Body({ text }: { text: string }) {
  const long = useMemo(
    () => text.split("\n").length > LONG_LINES || text.length > LONG_CHARS,
    [text]
  );
  const [open, setOpen] = useState(false);

  if (!long) {
    return <pre className="editor-scm-body px-2.5 py-2 text-[11px]">{text}</pre>;
  }

  return (
    <div className="editor-scm-bodywrap">
      <pre
        className={`editor-scm-body px-2.5 pt-2 text-[11px] ${open ? "" : "clamped"}`}
      >
        {text}
      </pre>
      <button
        className="editor-scm-more w-full px-2.5 py-1 text-[10px] text-left"
        onClick={() => setOpen((on) => !on)}
        aria-expanded={open}
      >
        {open ? "Show less" : "Read more"}
      </button>
    </div>
  );
}
