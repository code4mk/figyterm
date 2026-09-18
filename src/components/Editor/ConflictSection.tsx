import { useCallback, useState } from "react";
import { GitMergeConflict, Check, CircleX, FileWarning } from "lucide-react";
import {
  gitMarkResolved,
  gitMergeAbort,
  gitResolveWith,
  GitFile,
} from "../../services/git";
import { EditorDialog } from "./EditorDialog";
import { FileIcon } from "./fileIcons";

/**
 * The conflicted files, above everything else in the changes list.
 *
 * A stopped merge is not one more thing in the list of changes — it is a state
 * the repository is in, and nothing else in the panel can be done until it is
 * over. So it gets the top of the panel, its own colour, and the commit box
 * below is held closed while it is there.
 *
 * **"Mine" and "incoming", not "ours" and "theirs".** Git's words are precise
 * and almost universally misread: during a rebase they swap over, because the
 * commits being replayed become "theirs". The two things a person actually
 * wants to say are "the version I had" and "the version that arrived", which
 * is what the buttons say; `--ours` and `--theirs` stay in the Rust, where the
 * distinction is unambiguous.
 *
 * Resolving by hand is the third button and the one most conflicts need: open
 * the file, use the accept actions the editor puts on each conflict block, and
 * press **Resolved** when the markers are gone. That is `git add`, named for
 * what it means here rather than for what it runs.
 */

interface ConflictSectionProps {
  dir: string;
  /** Only the conflicted ones; the caller has already split the list. */
  files: GitFile[];
  /** True while a merge is stopped, even with every file resolved. */
  merging: boolean;
  /** What is being merged in — a branch name, or a short SHA. */
  mergeHead: string | null;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
}

export function ConflictSection({
  dir,
  files,
  merging,
  mergeHead,
  onOpenFile,
  onRefresh,
  onError,
}: ConflictSectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);

  const act = useCallback(
    async (key: string, run: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await run();
        onRefresh();
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [onRefresh, onError]
  );

  // A merge that is over but not committed still needs saying: the commit box
  // below will be writing the merge commit, not an ordinary one.
  if (!merging && files.length === 0) return null;

  return (
    <div className="editor-conflict shrink-0">
      <div className="editor-conflict-head flex items-center gap-1.5 px-2 py-1.5">
        <GitMergeConflict size={12} className="shrink-0" />
        <span className="flex-1 min-w-0 text-[11px] font-semibold truncate">
          {files.length > 0
            ? `${files.length} conflicted ${files.length === 1 ? "file" : "files"}`
            : "Merge ready to commit"}
        </span>
        {merging && (
          <button
            className="editor-btn-text px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1"
            onClick={() => setConfirmAbort(true)}
            disabled={!!busy}
            title="Undo the merge and put the working tree back as it was"
          >
            <CircleX size={9} />
            Abort
          </button>
        )}
      </div>

      {mergeHead && (
        <div className="editor-conflict-what px-2 pb-1.5 text-[10px]">
          Merging <span className="editor-conflict-ref">{mergeHead}</span>
          {files.length > 0 && " — pick a side for each file, or resolve it in the editor"}
        </div>
      )}

      {files.map((file) => {
        const pending = busy?.startsWith(`${file.relative}:`);
        return (
          <div key={file.relative} className="editor-conflict-row px-2 py-1">
            <button
              className="editor-conflict-file flex items-center gap-1.5 w-full text-left rounded px-1 py-0.5"
              onClick={() => onOpenFile(file.path)}
              title={`Open ${file.relative} and resolve it line by line`}
            >
              <FileIcon path={file.relative} size={12} />
              <span className="flex-1 min-w-0 truncate text-[11px]">{file.relative}</span>
              <FileWarning size={10} className="shrink-0 opacity-70" />
            </button>

            <div className="flex items-center gap-1 mt-1 pl-5">
              <button
                className="editor-conflict-btn px-1.5 py-0.5 rounded text-[10px]"
                disabled={pending}
                onClick={() =>
                  void act(`${file.relative}:ours`, () =>
                    gitResolveWith(dir, [file.relative], "ours")
                  )
                }
                title="Keep this file as it was on your branch, and mark it resolved"
              >
                Keep mine
              </button>
              <button
                className="editor-conflict-btn px-1.5 py-0.5 rounded text-[10px]"
                disabled={pending}
                onClick={() =>
                  void act(`${file.relative}:theirs`, () =>
                    gitResolveWith(dir, [file.relative], "theirs")
                  )
                }
                title="Take the incoming version of this file, and mark it resolved"
              >
                Take incoming
              </button>
              <span className="flex-1" />
              <button
                className="editor-conflict-btn done px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1"
                disabled={pending}
                onClick={() =>
                  void act(`${file.relative}:resolved`, () =>
                    gitMarkResolved(dir, [file.relative])
                  )
                }
                title="I have edited this file — mark the conflict resolved"
              >
                <Check size={9} />
                Resolved
              </button>
            </div>
          </div>
        );
      })}

      {confirmAbort && (
        <EditorDialog
          title="Abort the merge?"
          message="The working tree goes back to how it was before the merge started. Anything you have already resolved in it is lost."
          detail={mergeHead ? `Merging ${mergeHead}` : undefined}
          onCancel={() => setConfirmAbort(false)}
          actions={[
            {
              label: "Abort merge",
              danger: true,
              primary: true,
              onClick: () => {
                setConfirmAbort(false);
                void act("abort", () => gitMergeAbort(dir));
              },
            },
            { label: "Keep merging", onClick: () => setConfirmAbort(false) },
          ]}
        />
      )}
    </div>
  );
}
