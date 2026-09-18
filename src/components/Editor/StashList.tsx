import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  changeBadge,
  changeLabel,
  gitStashDrop,
  gitStashFiles,
  gitStashList,
  gitStashRestore,
  GitCommitFile,
  GitStash,
  relativeDate,
} from "../../services/git";
import { EditorDialog } from "./EditorDialog";
import { FileIcon } from "./fileIcons";

/**
 * The Stashes tab: what has been put aside, and how to get it back.
 *
 * Stashes belong to the repository, not to a branch, but each one records the
 * branch it was made on — and that is how people think of them ("the thing I
 * put down when I jumped onto the hotfix"). So this lists only the stashes made
 * on the branch currently checked out. A repository that has been worked in for
 * a month accumulates stashes from every branch in it, and a list mixing them
 * is a list nobody trusts enough to restore from.
 *
 * What that costs is worth saying: a stash made on another branch is not shown
 * here, though git would happily apply it. It is not lost — switch to that
 * branch, or `git stash list` — and the trade is a short list that is always
 * about the work in front of you.
 *
 * Restore comes in two strengths and both are offered, because the difference
 * matters and neither is safe to guess at. **Restore** applies and keeps the
 * stash, which is what you want when it might not apply cleanly, or when the
 * same work is wanted on two branches. **Pop** applies and removes it, which
 * is the ordinary "I'm back, carry on". Git drops a popped stash only when it
 * applied without conflict, so pop cannot lose work to a collision.
 */

interface StashListProps {
  dir: string;
  /** The branch HEAD is on, for marking the rows made here. */
  branch: string | null;
  /** Changes when the repository might have, so the list reloads. */
  revision: string;
  /** The exact count, for the tab's badge — free while this is on screen. */
  onCount: (count: number) => void;
  /** Re-reads the repository after something is applied or dropped. */
  onDone: () => void;
  onError: (message: string) => void;
}

export function StashList({
  dir,
  branch,
  revision,
  onCount,
  onDone,
  onError,
}: StashListProps) {
  const [all, setAll] = useState<GitStash[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The stash a "drop" is waiting to be confirmed for. */
  const [pendingDrop, setPendingDrop] = useState<GitStash | null>(null);
  /** The stash whose file list is open, and what it holds. */
  const [opened, setOpened] = useState<string | null>(null);
  const [files, setFiles] = useState<Map<string, GitCommitFile[] | "loading">>(new Map());

  /*
    Only this branch's. A stash from a detached HEAD records no branch, and
    shows when HEAD is detached — `null === null` — which is the same rule
    rather than an exception to it.
  */
  const stashes = useMemo(
    () => all?.filter((stash) => (stash.branch ?? null) === branch) ?? null,
    [all, branch]
  );

  /**
   * Re-reads the stack.
   *
   * Called after this component's own actions as well as on `revision`. A drop
   * writes nothing but `.git/logs/refs/stash`, so waiting for the watcher to
   * notice would leave a row on screen that no longer exists — and the next
   * click on it would act on whatever had taken its place. Keyed by SHA, that
   * click fails safely rather than dropping the wrong stash, but the row
   * should not be there to click.
   */
  const reload = useCallback(async () => {
    try {
      const listed = await gitStashList(dir);
      setAll(listed);
      // The badge counts what this tab will show, not what the repository
      // holds: a number that doesn't match the list underneath it is worse
      // than no number.
      onCount(listed.filter((stash) => (stash.branch ?? null) === branch).length);
      return listed;
    } catch (e) {
      setAll([]);
      onCount(0);
      onError(String(e));
      return [];
    }
  }, [dir, branch, onCount, onError]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  /**
   * Opens a stash to show what is in it, reading the files the first time.
   *
   * Cached per stash and never refetched: a stash is a commit, so its contents
   * cannot change while it sits there. Restoring one does not alter it either
   * — only dropping it does, and then the row is gone.
   */
  const toggle = useCallback(
    (stash: GitStash) => {
      if (opened === stash.sha) {
        setOpened(null);
        return;
      }
      setOpened(stash.sha);
      if (files.has(stash.sha)) return;

      setFiles((prev) => new Map(prev).set(stash.sha, "loading"));
      void gitStashFiles(dir, stash.sha)
        .then((found) => setFiles((prev) => new Map(prev).set(stash.sha, found)))
        .catch((e) => {
          setFiles((prev) => {
            const next = new Map(prev);
            next.delete(stash.sha);
            return next;
          });
          onError(String(e));
        });
    },
    [dir, opened, files, onError]
  );

  const act = useCallback(
    async (stash: GitStash, what: "apply" | "pop" | "drop") => {
      setBusy(stash.sha);
      setNote(null);
      try {
        const reply =
          what === "drop"
            ? await gitStashDrop(dir, stash.sha)
            : await gitStashRestore(dir, stash.sha, what === "pop");
        // Git's own summary of what landed in the working tree, which is the
        // one thing worth reading after a restore.
        setNote(reply.trim() || null);
        await reload();
        onDone();
      } catch (e) {
        // A conflicting apply leaves the files marked and the stash intact;
        // git says which, and the changes list shows them a moment later.
        setNote(String(e));
        await reload();
      } finally {
        setBusy(null);
        setPendingDrop(null);
      }
    },
    [dir, reload, onDone]
  );

  if (stashes && stashes.length === 0) {
    return (
      <div className="editor-explorer-empty px-3 py-4 text-[11px]">
        Nothing stashed on {branch ?? "this checkout"}. Switching branch with uncommitted
        changes offers to put them here.
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="editor-scm-list flex-1 min-h-0 overflow-y-auto">
        {stashes?.map((stash) => {
          return (
            <div
              key={stash.sha}
              className={`editor-stash-row px-2 py-1.5 ${busy === stash.sha ? "busy" : ""}`}
            >
              {/* The title is the disclosure: "what is in this one" is the
                  question the title raises, so it answers where it was asked. */}
              <button
                className="editor-stash-head flex items-center gap-1.5 w-full text-left rounded"
                onClick={() => toggle(stash)}
                aria-expanded={opened === stash.sha}
                title="Show the files in this stash"
              >
                {opened === stash.sha ? (
                  <ChevronDown size={11} className="shrink-0 opacity-70" />
                ) : (
                  <ChevronRight size={11} className="shrink-0 opacity-70" />
                )}
                <Archive size={11} className="shrink-0 opacity-70" />
                <span
                  className="editor-stash-msg flex-1 min-w-0 truncate text-[11px]"
                  title={stash.message}
                >
                  {stash.message}
                </span>
                <span className="editor-stash-when text-[10px] shrink-0">
                  {stash.date ? relativeDate(stash.date) : ""}
                </span>
              </button>

              {opened === stash.sha && <StashFiles files={files.get(stash.sha)} />}

              <div className="flex items-center gap-1.5 mt-1">
                <span className="flex-1" />

                <button
                  className="editor-btn-text px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1"
                  disabled={!!busy}
                  onClick={() => void act(stash, "apply")}
                  title="Apply these changes and keep the stash"
                >
                  <ArchiveRestore size={9} />
                  Restore
                </button>
                <button
                  className="editor-btn-text px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1"
                  disabled={!!busy}
                  onClick={() => void act(stash, "pop")}
                  title="Apply these changes and remove the stash"
                >
                  <Undo2 size={9} />
                  Pop
                </button>
                <button
                  className="editor-btn-text editor-stash-drop px-1.5 py-0.5 rounded text-[10px]"
                  disabled={!!busy}
                  onClick={() => setPendingDrop(stash)}
                  title="Throw this stash away"
                  aria-label="Drop this stash"
                >
                  <Trash2 size={9} />
                </button>
              </div>
            </div>
          );
        })}

        {!stashes && (
          <div className="editor-explorer-empty px-3 py-4 text-[11px]">Reading stashes…</div>
        )}
      </div>

      {note && (
        <div className="editor-scm-note flex items-start gap-1.5 mx-2 mb-1 px-1.5 py-1 rounded text-[10px]">
          <span className="flex-1 min-w-0 break-words whitespace-pre-wrap">{note}</span>
          <button
            className="editor-btn p-0.5 rounded shrink-0"
            onClick={() => setNote(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {pendingDrop && (
        <EditorDialog
          title="Throw this stash away?"
          message="The changes in it are not on any branch and cannot be recovered from the panel."
          detail={pendingDrop.message}
          onCancel={() => setPendingDrop(null)}
          actions={[
            {
              label: "Drop",
              onClick: () => void act(pendingDrop, "drop"),
              primary: true,
              danger: true,
            },
            { label: "Cancel", onClick: () => setPendingDrop(null) },
          ]}
        />
      )}
    </div>
  );
}

/**
 * What a stash holds, under its row.
 *
 * Names and a letter each, with the line counts — the same vocabulary the
 * changes list uses, because it is the same question asked of a different
 * place. Not clickable: there is no file on disk to open, and the diff viewer
 * takes a working-tree path or a commit, neither of which a stash is.
 */
function StashFiles({ files }: { files: GitCommitFile[] | "loading" | undefined }) {
  if (files === undefined || files === "loading") {
    return <div className="editor-stash-files px-1 py-1 text-[10px]">Reading…</div>;
  }

  if (files.length === 0) {
    return <div className="editor-stash-files px-1 py-1 text-[10px]">No files in it.</div>;
  }

  return (
    <div className="editor-stash-files py-0.5">
      {files.map((file) => (
        <div
          key={`${file.change}:${file.relative}`}
          className={`editor-stash-file flex items-center gap-1.5 px-1 py-0.5 git-${file.change}`}
          title={`${changeLabel(file.change)} — ${file.relative}`}
        >
          <FileIcon path={file.relative} size={11} />
          <span className="flex-1 min-w-0 truncate text-[10px]">{file.relative}</span>
          {(file.added > 0 || file.removed > 0) && (
            <span className="text-[9px] shrink-0 tabular-nums">
              {file.added > 0 && <span className="editor-stash-add">+{file.added}</span>}
              {file.removed > 0 && <span className="editor-stash-del"> −{file.removed}</span>}
            </span>
          )}
          <span className="editor-row-git text-[9px] shrink-0">{changeBadge(file.change)}</span>
        </div>
      ))}
    </div>
  );
}
