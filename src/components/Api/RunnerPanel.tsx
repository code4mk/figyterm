/**
 * Running a collection, and watching it happen.
 *
 * The results fill in as the run goes rather than appearing at the end: a run
 * of two hundred requests that shows nothing for a minute is one nobody
 * believes is working, and the first failure is usually the interesting one.
 *
 * Stop is checked between requests, so it takes effect within one request
 * rather than at the end of the run — which is the difference between a button
 * that works and a button that is a suggestion.
 */

import { useEffect, useRef } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Download, Loader, Play, Square, X } from "lucide-react";
import { RunState } from "../../stores/apiStore";
import { formatDuration, statusTone, toneClass } from "../../services/api/format";

interface RunnerPanelProps {
  run: RunState;
  onClose: () => void;
  onOptions: (options: Partial<Pick<RunState, "iterations" | "delayMs" | "stopOnFailure">>) => void;
  onStart: () => void;
  onStop: () => void;
  onLoadData: (path: string) => void;
  onClearData: () => void;
  onExport: (path: string) => void;
}

export function RunnerPanel({
  run,
  onClose,
  onOptions,
  onStart,
  onStop,
  onLoadData,
  onClearData,
  onExport,
}: RunnerPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Follows the run down the list. Only while it is running: scrolling back to
  // read a failure should not be undone by the next result arriving.
  useEffect(() => {
    if (run.running && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [run.entries.length, run.running]);

  const pickData = async () => {
    const picked = await openDialog({
      multiple: false,
      title: "Choose a data file",
      filters: [{ name: "Data", extensions: ["csv", "json"] }],
    });
    if (picked && !Array.isArray(picked)) onLoadData(picked);
  };

  const saveReport = async () => {
    const path = await saveDialog({
      defaultPath: `${run.target?.name ?? "run"}-report.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "Save the run report",
    });
    if (path) onExport(path);
  };

  const iterations = run.data?.rows.length ? run.data.rows.length : run.iterations;
  const failedSoFar = run.entries.reduce((total, entry) => total + entry.failed, 0);
  const passedSoFar = run.entries.reduce((total, entry) => total + entry.passed, 0);
  const erroredSoFar = run.entries.filter((entry) => entry.error).length;

  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center pt-[5%]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />

      <div className="relative w-[min(760px,94%)] max-h-[86%] flex flex-col rounded-xl border border-ft-border bg-ft-elevated shadow-2xl">
        <div className="flex items-center gap-2 px-4 h-9 shrink-0 border-b border-ft-border">
          <span className="text-[12px] font-semibold text-ft-text">
            Run {run.target?.name ?? ""}
          </span>
          <div className="flex-1" />
          <button
            className="p-1 rounded text-ft-text-muted hover:bg-ft-surface hover:text-ft-text"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* ─── How ──────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 shrink-0 border-b border-ft-border-subtle text-[11px]">
          <label className="flex items-center gap-2">
            <span className="text-ft-text-muted">Iterations</span>
            <input
              className="api-url w-16"
              inputMode="numeric"
              value={run.data?.rows.length ? run.data.rows.length : run.iterations}
              disabled={Boolean(run.data?.rows.length) || run.running}
              onChange={(e) => onOptions({ iterations: Math.max(1, Number(e.target.value) || 1) })}
              title={
                run.data?.rows.length
                  ? "Set by the data file: one iteration per row"
                  : "How many times to go round"
              }
            />
          </label>

          <label className="flex items-center gap-2">
            <span className="text-ft-text-muted">Delay</span>
            <input
              className="api-url w-20"
              inputMode="numeric"
              value={run.delayMs}
              disabled={run.running}
              onChange={(e) => onOptions({ delayMs: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="text-ft-text-muted">ms between requests</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
              checked={run.stopOnFailure}
              disabled={run.running}
              onChange={(e) => onOptions({ stopOnFailure: e.target.checked })}
            />
            <span className="text-ft-text">Stop at the first failure</span>
          </label>

          <div className="flex items-center gap-2">
            <button className="api-button-quiet" onClick={() => void pickData()} disabled={run.running}>
              {run.dataName ? run.dataName : "Data file…"}
            </button>
            {run.data && (
              <>
                <span className="text-ft-text-muted">
                  {run.data.rows.length} row{run.data.rows.length === 1 ? "" : "s"} ·{" "}
                  {run.data.columns.join(", ") || "no columns"}
                </span>
                <button className="api-button-quiet" onClick={onClearData} disabled={run.running}>
                  Clear
                </button>
              </>
            )}
          </div>

          {run.data?.notes.map((note, index) => (
            <span key={index} className="text-ft-warning">
              {note}
            </span>
          ))}
        </div>

        {/* ─── Go ───────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-2 shrink-0 border-b border-ft-border-subtle text-[11px]">
          {run.running ? (
            <button className="api-button api-button-cancel flex items-center gap-1.5" onClick={onStop}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className="api-button flex items-center gap-1.5" onClick={onStart}>
              <Play size={11} /> Run
            </button>
          )}

          {run.running && <Loader size={12} className="animate-spin text-ft-text-muted" />}

          <span className="text-ft-text-muted">
            {run.total > 0
              ? `${run.done} of ${run.total}`
              : `${iterations} iteration${iterations === 1 ? "" : "s"}`}
          </span>

          {run.entries.length > 0 && (
            <>
              <span className="text-ft-success">{passedSoFar} passed</span>
              {failedSoFar > 0 && <span className="text-ft-error">{failedSoFar} failed</span>}
              {erroredSoFar > 0 && <span className="text-ft-warning">{erroredSoFar} errored</span>}
            </>
          )}

          <div className="flex-1" />

          {run.report && (
            <button
              className="api-button-quiet flex items-center gap-1.5"
              onClick={() => void saveReport()}
            >
              <Download size={11} /> Save report
            </button>
          )}
        </div>

        {/* ─── What happened ────────────────────────────────────────────── */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-auto">
          {run.entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-ft-text-muted">
              Every request under {run.target?.name ?? "this"} runs in the order the rail shows
              them, with the environment that is selected.
            </div>
          ) : (
            run.entries.map((entry, index) => (
              <div
                key={`${entry.itemId}-${entry.iteration}-${index}`}
                className="flex items-start gap-2 px-4 py-1.5 border-b border-ft-border-subtle text-[11px]"
              >
                <span className="w-6 shrink-0 text-ft-text-muted">
                  {run.data?.rows.length || run.iterations > 1 ? entry.iteration + 1 : ""}
                </span>

                <span className="w-10 shrink-0 text-[9px] font-semibold text-ft-text-muted">
                  {entry.method}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="truncate text-ft-text">{entry.name}</div>
                  {entry.error ? (
                    <div className="text-ft-error break-all">{entry.error}</div>
                  ) : (
                    entry.tests
                      .filter((test) => !test.passed)
                      .map((test, at) => (
                        <div key={at} className="text-ft-error break-all">
                          {test.name} — {test.error}
                        </div>
                      ))
                  )}
                </div>

                {entry.tests.length > 0 && (
                  <span
                    className={`shrink-0 ${entry.failed > 0 ? "text-ft-error" : "text-ft-success"}`}
                  >
                    {entry.failed > 0 ? `${entry.failed}/${entry.tests.length}` : (
                      <Check size={11} />
                    )}
                  </span>
                )}

                <span
                  className={`w-10 shrink-0 text-right ${
                    entry.status === null ? "text-ft-error" : toneClass(statusTone(entry.status))
                  }`}
                >
                  {entry.status ?? "—"}
                </span>
                <span className="w-14 shrink-0 text-right text-ft-text-muted">
                  {formatDuration(entry.durationMs)}
                </span>
              </div>
            ))
          )}
        </div>

        {run.report?.stoppedBecause && (
          <div className="px-4 py-2 shrink-0 border-t border-ft-border-subtle text-[11px] text-ft-warning">
            {run.report.stoppedBecause}
          </div>
        )}
      </div>
    </div>
  );
}
