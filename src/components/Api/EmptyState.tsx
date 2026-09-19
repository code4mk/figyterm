/**
 * What fills the window when nothing is open.
 *
 * Reachable now that closing the last tab no longer spawns a replacement, and
 * therefore worth building properly: it is the first thing a new workspace
 * shows and the last thing anybody sees after clearing their tabs.
 *
 * Actions first, keys second, and a line of recent work when there is any. A
 * blank pane with "open a request" in grey text is an instruction, not a
 * starting point — it tells somebody what they already know and gives them
 * nowhere to press.
 */

import { FileUp, History, Layers, Plus } from "lucide-react";
import { HistoryEntry } from "../../types/api";
import { formatDuration, statusTone, timeAgo, toneClass } from "../../services/api/format";

interface EmptyStateProps {
  /** False while the database is still opening. */
  ready: boolean;
  /** Whether there is anything in the workspace at all. */
  hasCollections: boolean;
  history: HistoryEntry[];
  onNew: () => void;
  onImport: () => void;
  onNewCollection: () => void;
  onOpenHistory: (id: string) => void;
}

/** Enough to recognise something without turning this into the history panel,
 * which is one click away in the sidebar. */
const RECENT = 5;

export function EmptyState({
  ready,
  hasCollections,
  history,
  onNew,
  onImport,
  onNewCollection,
  onOpenHistory,
}: EmptyStateProps) {
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-ft-text-muted">
        Opening…
      </div>
    );
  }

  const recent = history.slice(0, RECENT);

  return (
    <div className="flex flex-1 min-h-0 items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-[460px]">
        <div className="mb-4 flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-7 w-auto shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight text-ft-text">
            Figy API
          </span>
        </div>

        <h2 className="text-[15px] font-semibold text-ft-text">
          {hasCollections ? "Nothing open" : "Nothing here yet"}
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ft-text-muted">
          {hasCollections
            ? "Pick a request from the sidebar, or start a new one."
            : "Start a request and send it, or bring a collection you already have."}
        </p>

        <div className="mt-4 flex flex-col gap-1.5">
          <button className="api-empty-action" onClick={onNew}>
            <Plus size={14} />
            <span className="flex-1 text-left">
              New request
              <span className="block text-[10px] text-ft-text-muted">
                A blank one, not saved anywhere until you ask
              </span>
            </span>
            <span className="api-empty-key">⌘T</span>
          </button>

          <button className="api-empty-action" onClick={onImport}>
            <FileUp size={14} />
            <span className="flex-1 text-left">
              Import a collection
              <span className="block text-[10px] text-ft-text-muted">
                A v2.1.0 or v2.0.0 file, an environment, or a folder of them
              </span>
            </span>
          </button>

          <button className="api-empty-action" onClick={onNewCollection}>
            <Layers size={14} />
            <span className="flex-1 text-left">
              New collection
              <span className="block text-[10px] text-ft-text-muted">
                Somewhere to keep requests, with shared auth and variables
              </span>
            </span>
          </button>
        </div>

        {recent.length > 0 && (
          <div className="mt-6">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ft-text-muted">
              <History size={11} />
              Recently sent
            </div>
            {recent.map((entry) => (
              <button
                key={entry.id}
                className="api-empty-recent"
                onClick={() => onOpenHistory(entry.id)}
                title={entry.url}
              >
                <span className="api-method-chip text-ft-accent">{entry.method}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ft-text">
                  {entry.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")}
                </span>
                {entry.status !== null ? (
                  <span
                    className={`shrink-0 text-[10px] tabular-nums ${toneClass(
                      statusTone(entry.status)
                    )}`}
                  >
                    {entry.status}
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] text-ft-error">failed</span>
                )}
                <span className="w-12 shrink-0 text-right text-[9px] tabular-nums text-ft-text-muted">
                  {entry.durationMs === null
                    ? timeAgo(entry.sentAt, Date.now())
                    : formatDuration(entry.durationMs)}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* The keys worth knowing, once, where there is room to say them. */}
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ft-text-muted">
          <span>
            <kbd className="api-kbd">⌘↵</kbd> send
          </span>
          <span>
            <kbd className="api-kbd">⌘S</kbd> save
          </span>
          <span>
            <kbd className="api-kbd">⌘B</kbd> sidebar
          </span>
          <span>
            <kbd className="api-kbd">⌘J</kbd> console
          </span>
          <span>
            <kbd className="api-kbd">⌘W</kbd> close tab
          </span>
        </div>
      </div>
    </div>
  );
}
