/**
 * What an import did.
 *
 * Shown once, after the fact, and dismissed — not a progress dialog. Its
 * outcome comes first, in a line anybody can read at a glance, because most
 * imports work and the answer somebody wants is "yes, and here is what
 * arrived".
 *
 * The notes are the reason it exists at all: a multipart body that cannot be
 * sent yet, a v2.0.0 file upgraded on the way in, a file that was not a
 * collection. Those are things somebody needs to know about work they have
 * just moved across, and an import that says nothing leaves them to find out
 * when a request fails. Errors sort first — a list that buries the one failure
 * under nine "upgraded from v2.0.0" lines is a list nobody finishes.
 *
 * It sits inside the API window rather than over the whole app, because that is
 * where the thing it is talking about is.
 */

import { Check, CircleAlert, FileUp, Info, TriangleAlert, X } from "lucide-react";
import { ImportReport as Report } from "../../stores/apiStore";
import { ImportNote } from "../../services/api/interchange/import";

interface ImportReportProps {
  report: Report;
  onDismiss: () => void;
}

/** One number and its label, or nothing when there is none of it. */
function Tally({ value, label }: { value: number; label: string }) {
  if (value === 0) return null;
  return (
    <div className="api-report-tally">
      <span className="api-report-number">{value}</span>
      <span className="api-report-label">
        {label}
        {value === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/** Errors, then warnings, then the rest — each keeping its own order. */
function ordered(notes: ImportNote[]): ImportNote[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...notes].sort((a, b) => rank[a.level] - rank[b.level]);
}

export function ImportReport({ report, onDismiss }: ImportReportProps) {
  const failed = report.notes.filter((note) => note.level === "error").length;
  const warned = report.notes.filter((note) => note.level === "warning").length;
  const arrived = report.collections + report.environments + report.requests;
  const nothing = arrived === 0;

  return (
    <div className="api-report absolute inset-0 z-20 flex items-start justify-center pt-[10%]">
      <div className="absolute inset-0 bg-black/45" onClick={onDismiss} aria-hidden />

      <div
        className="relative w-[min(560px,90%)] max-h-[76%] flex flex-col rounded-xl border border-ft-border bg-ft-elevated shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Import"
      >
        {/* The outcome, in one line with a mark beside it. */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 shrink-0">
          <span
            className={`api-report-mark ${nothing ? "bad" : failed > 0 ? "warn" : "good"}`}
            aria-hidden
          >
            {nothing ? (
              <CircleAlert size={15} />
            ) : failed > 0 ? (
              <TriangleAlert size={15} />
            ) : (
              <Check size={15} />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ft-text">
              {nothing
                ? "Nothing was imported"
                : failed > 0
                  ? "Imported, with problems"
                  : "Imported"}
            </div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-ft-text-muted">
              {nothing
                ? failed > 0
                  ? "Nothing in those files could be read. What went wrong is below."
                  : "Those files held no collections or environments."
                : `From ${report.files} file${report.files === 1 ? "" : "s"}${
                    failed > 0 ? `, with ${failed} that could not be read` : ""
                  }${warned > 0 ? ` and ${warned} worth reading about` : ""}.`}
            </div>
          </div>

          <button
            className="api-rail-action"
            onClick={onDismiss}
            title="Close"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* What arrived, as numbers big enough to read across the room. */}
        {!nothing && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 px-4 pb-3 shrink-0 border-b border-ft-border-subtle">
            <Tally value={report.collections} label="collection" />
            <Tally value={report.folders} label="folder" />
            <Tally value={report.requests} label="request" />
            <Tally value={report.environments} label="environment" />
            <Tally value={report.variables} label="variable" />
          </div>
        )}

        {report.notes.length > 0 ? (
          <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-2">
            {ordered(report.notes).map((note, index) => (
              <div key={index} className="flex gap-2 items-start text-[11px] leading-relaxed">
                <span className="mt-[2px] shrink-0">
                  {note.level === "error" ? (
                    <CircleAlert size={12} className="text-ft-error" />
                  ) : note.level === "warning" ? (
                    <TriangleAlert size={12} className="text-ft-warning" />
                  ) : (
                    <Info size={12} className="text-ft-text-muted" />
                  )}
                </span>
                <span
                  className={
                    note.level === "error" ? "text-ft-error" : "text-ft-text-secondary"
                  }
                >
                  {note.message}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-4 text-[11px] text-ft-text-muted">
            <Check size={12} className="shrink-0 text-ft-success" />
            Everything came across with nothing to report.
          </div>
        )}

        <div className="flex items-center gap-2 px-4 py-2.5 shrink-0 border-t border-ft-border-subtle">
          <FileUp size={11} className="shrink-0 text-ft-text-muted" />
          <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-ft-text-muted">
            Anything this app does not understand is kept as it was, and written
            back out when the collection is exported.
          </span>
          <button className="api-button shrink-0" onClick={onDismiss} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
