import { useEffect, useState } from "react";
import { GitBranch, History, X } from "lucide-react";
import { PastConversation, pastConversations } from "../../services/claude";

/**
 * Conversations this folder already has, that FigyTerm never started.
 *
 * The CLI writes every conversation to disk under the folder it ran in, so a
 * project has a history the moment it is created — work done in a plain shell,
 * in another editor, or before the project existed here. All of it resumes by
 * id, which FigyTerm has because the id *is* the transcript's filename.
 *
 * Two ways in, sharing one list. Inline under the empty state, where it is the
 * obvious thing to want — you opened a project with nothing running, and what
 * you did here last time is the answer more often than a blank conversation is.
 * And as a modal from the toolbar, for when something *is* open and you are
 * going looking.
 */

export function useFolderHistory(root: string | null, known: string[]) {
  const [rows, setRows] = useState<PastConversation[] | null>(null);

  // `known` is rebuilt on every render by the caller, so it is deliberately not
  // a dependency: depending on it would re-read the directory continuously. The
  // list is a snapshot of the folder either way.
  const knownKey = known.join(",");

  useEffect(() => {
    if (!root) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setRows(null);
    void pastConversations(root, knownKey ? knownKey.split(",") : []).then((found) => {
      if (!cancelled) setRows(found);
    });
    return () => {
      cancelled = true;
    };
  }, [root, knownKey]);

  return rows;
}

function when(epochMillis: number): string {
  if (!epochMillis) return "";
  const days = Math.floor((Date.now() - epochMillis) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(epochMillis).toLocaleDateString();
}

interface HistoryListProps {
  rows: PastConversation[] | null;
  onPick: (sessionId: string, title: string | null) => void;
  /** Shown when the folder has no history at all. */
  emptyLabel?: string;
}

/** The scrollable list itself, with no chrome of its own. */
export function HistoryList({ rows, onPick, emptyLabel }: HistoryListProps) {
  if (rows === null) {
    return (
      <div className="editor-workspace-empty px-3.5 py-6 text-center text-[11px]">
        Reading this folder’s history…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="editor-workspace-empty px-3.5 py-6 text-center text-[11px]">
        {emptyLabel ?? "Nothing else on disk for this folder."}
      </div>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <button
          key={row.sessionId}
          className="editor-workspace-item flex items-center gap-2.5 px-3.5 py-2 w-full text-left"
          onClick={() => onPick(row.sessionId, row.title)}
          title={`Resume ${row.sessionId}`}
        >
          <span className="claude-dot shrink-0" />
          <span className="flex flex-col min-w-0 flex-1">
            <span className="text-[12px] truncate">{row.title || "Untitled conversation"}</span>
            <span className="flex items-center gap-1.5 min-w-0">
              {/*
                The branch it was on, where there was one. Two conversations
                about the same repository are told apart by this more often
                than by their opening line — and a session id tells nobody
                anything, so it gives up its place when a branch exists.
              */}
              {row.branch ? (
                <span
                  className="claude-branch flex items-center gap-1 text-[10px] shrink-0"
                  title={`Started on ${row.branch}`}
                >
                  <GitBranch size={9} />
                  <span className="truncate max-w-[160px]">{row.branch}</span>
                </span>
              ) : (
                <span className="editor-workspace-path text-[10px] truncate">
                  {row.sessionId}
                </span>
              )}
            </span>
          </span>
          <span className="claude-field-hint shrink-0">{when(row.updatedAt)}</span>
        </button>
      ))}
    </>
  );
}

interface HistoryPickerProps {
  root: string;
  /** Session ids the project already tracks, so they aren't offered twice. */
  known: string[];
  onResume: (sessionId: string, title: string | null) => void;
  onClose: () => void;
}

export function HistoryPicker({ root, known, onResume, onClose }: HistoryPickerProps) {
  const rows = useFolderHistory(root, known);

  return (
    <div
      className="editor-dialog-backdrop absolute inset-0 z-[20] flex items-start justify-center pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="editor-workspace-modal w-[520px] max-w-[92vw] max-h-[70vh] rounded-xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Earlier conversations"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-workspace-header flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <History size={12} className="editor-palette-icon" />
          <span className="editor-dialog-title text-[13px] font-semibold flex-1">
            Earlier conversations
          </span>
          <button
            className="editor-icon-btn p-1 rounded"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          <HistoryList
            rows={rows}
            onPick={(sessionId, title) => {
              onResume(sessionId, title);
              onClose();
            }}
          />
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <span className="editor-workspace-hint text-[10px]">
            Opening one resumes it with its full history
          </span>
        </div>
      </div>
    </div>
  );
}
