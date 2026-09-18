import { useEffect, useState } from "react";
import { CircleAlert, GitMergeConflict } from "lucide-react";
import { gitConflictMarks, GitConflictFile, GitFile } from "../../services/git";
import { FileIcon } from "./fileIcons";

/**
 * What the commit button says when a merge is still open.
 *
 * The button could simply be disabled — and was — but a disabled button is a
 * dead end: it says no without saying why, and the one question somebody has
 * at that moment is *where*. So it stays pressable, and pressing it answers:
 * which files, how many conflicts in each, and on which lines. Every line is a
 * link that opens the file there, with the editor's own accept actions already
 * sitting on that block.
 *
 * A file with no line numbers is not an error. Git calls a file unmerged when
 * the two sides disagree about whether it should exist at all — deleted here,
 * modified there — and there are no markers to go to, because there is no text
 * to merge. That row says so instead of showing an empty list.
 */

interface ConflictReportProps {
  dir: string;
  /** The conflicted files, from the panel's own status. */
  files: GitFile[];
  /** Opens a file, optionally at a line — the row and the line chips both do. */
  onOpen: (path: string, line?: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export function ConflictReport({
  dir,
  files,
  onOpen,
  onClose,
  onError,
}: ConflictReportProps) {
  const [marks, setMarks] = useState<GitConflictFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gitConflictMarks(
      dir,
      files.map((file) => file.relative)
    )
      .then((found) => {
        if (!cancelled) setMarks(found);
      })
      .catch((e) => {
        if (cancelled) return;
        // The list of files is still worth showing without the line numbers.
        setMarks(files.map((file) => ({ relative: file.relative, lines: [], truncated: false })));
        onError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dir, files, onError]);

  const total = marks?.reduce((sum, file) => sum + file.lines.length, 0) ?? 0;
  const first = marks?.find((file) => file.lines.length > 0);

  /** Absolute path for a repo-relative one, from the status we were handed. */
  const pathOf = (relative: string) =>
    files.find((file) => file.relative === relative)?.path ?? relative;

  return (
    <div
      className="editor-dialog-backdrop fixed inset-0 z-[300] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-dialog editor-report w-[460px] max-w-[92vw] rounded-xl outline-none overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Conflicts to resolve before committing"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-report-head flex items-center gap-2 px-4 py-3">
          <GitMergeConflict size={15} className="shrink-0" />
          <div className="min-w-0">
            <div className="editor-dialog-title text-[13px] font-semibold">
              Resolve the conflicts first
            </div>
            <div className="editor-report-sub text-[11px] mt-0.5">
              Git will not commit while {files.length} file
              {files.length === 1 ? " is" : "s are"} unmerged
              {total > 0 && `, with ${total} conflict${total === 1 ? "" : "s"} between them`}.
            </div>
          </div>
        </div>

        <div className="editor-report-list max-h-[320px] overflow-y-auto">
          {!marks && (
            <div className="editor-explorer-empty px-4 py-4 text-[11px]">Reading the files…</div>
          )}

          {marks?.map((file) => (
            <div key={file.relative} className="editor-report-row px-4 py-2">
              <button
                className="editor-report-file flex items-center gap-2 w-full text-left rounded px-1 py-0.5"
                onClick={() => onOpen(pathOf(file.relative), file.lines[0])}
                title={`Open ${file.relative}`}
              >
                <FileIcon path={file.relative} size={12} />
                <span className="flex-1 min-w-0 truncate text-[12px]">{file.relative}</span>
                <span className="editor-report-count text-[10px] shrink-0 tabular-nums">
                  {file.lines.length > 0
                    ? `${file.lines.length}${file.truncated ? "+" : ""} conflict${
                        file.lines.length === 1 && !file.truncated ? "" : "s"
                      }`
                    : "unmerged"}
                </span>
              </button>

              <div className="flex flex-wrap items-center gap-1 mt-1 pl-6">
                {file.lines.length > 0 ? (
                  file.lines.map((line) => (
                    <button
                      key={line}
                      className="editor-report-line px-1.5 py-0.5 rounded text-[10px] tabular-nums"
                      onClick={() => onOpen(pathOf(file.relative), line)}
                      title={`Open ${file.relative} at line ${line}`}
                    >
                      line {line}
                    </button>
                  ))
                ) : (
                  <span className="editor-report-note text-[10px]">
                    No markers in the file — the two sides disagree about whether it should
                    exist. Take a side from the panel.
                  </span>
                )}
                {file.truncated && (
                  <span className="editor-report-note text-[10px]">and more</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="editor-report-foot flex items-center gap-2 px-4 py-3">
          <CircleAlert size={11} className="editor-report-hint shrink-0" />
          <span className="editor-report-hint flex-1 min-w-0 text-[10px]">
            Each block carries Accept current / incoming / both in the editor.
          </span>
          <button
            className="editor-dialog-btn px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="editor-dialog-btn primary px-3 py-1.5 rounded-md text-[11px] font-medium"
            disabled={!marks}
            onClick={() => {
              // The first file with somewhere to go; failing that, the first
              // file, which will be one to take a side on.
              const target = first ?? marks?.[0];
              if (target) onOpen(pathOf(target.relative), target.lines[0]);
              onClose();
            }}
          >
            {first ? "Go to first conflict" : "Open first file"}
          </button>
        </div>
      </div>
    </div>
  );
}
