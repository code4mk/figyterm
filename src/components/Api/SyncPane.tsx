/**
 * Syncing, as a tab you can watch.
 *
 * The connection panel answers "where is the database and can this machine
 * reach it". This answers the other question, which is the one people ask
 * while working: *what is it doing right now, and what went wrong.*
 *
 * A tab rather than a modal for exactly that reason. Watching a pass is
 * something you do while doing something else, and a modal over the whole
 * window is the one arrangement that makes that impossible — closing it to get
 * back to work is also closing the thing you were watching.
 *
 * **The bar counts tables, not rows.** Nothing knows how many rows are coming
 * until they stop coming, and a bar that invents a denominator is a bar that
 * sits at 90% for a minute. Seven tables is a number both sides agree on.
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Database,
  Loader,
  RefreshCw,
  Settings2,
  Square,
  Upload,
  Download,
  TriangleAlert,
} from "lucide-react";
import { SyncStatus, SyncStep } from "../../types/api";
import * as sync from "../../services/api/sync";
import { timeAgo } from "../../services/api/format";

interface SyncPaneProps {
  status: SyncStatus | null;
  syncing: boolean;
  /** A stop has been asked for and the pass has not reached a boundary yet. */
  stopping: boolean;
  onSyncNow: () => void;
  onStopSync: () => void;
  onOpenConnection: () => void;
  onRefresh: () => void;
}

/** One line of what happened, kept while the tab is open. */
interface Line {
  id: number;
  at: number;
  text: string;
  tone: "info" | "good" | "bad";
}

export function SyncPane({
  status,
  syncing,
  stopping,
  onSyncNow,
  onStopSync,
  onOpenConnection,
  onRefresh,
}: SyncPaneProps) {
  const [step, setStep] = useState<SyncStep | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const next = useRef(0);

  const say = (text: string, tone: Line["tone"]) =>
    setLines((kept) => {
      // Bounded: a pass every five minutes for a day is three hundred lines,
      // and nobody scrolls back that far.
      const line = { id: next.current++, at: Date.now(), text, tone };
      return [...kept, line].slice(-200);
    });

  useEffect(() => {
    let dropped = false;
    const unlisteners: (() => void)[] = [];

    void sync
      .onSyncStep((incoming) => {
        if (dropped) return;
        setStep(incoming.phase === "done" ? null : incoming);
      })
      .then((off) => {
        if (dropped) off();
        else unlisteners.push(off);
      });

    void sync
      .onSync((outcome) => {
        if (dropped) return;
        setStep(null);
        const moved =
          `sent ${outcome.pushed}, took ${outcome.pulled}` +
          (outcome.conflicts > 0 ? `, ${outcome.conflicts} conflicted` : "") +
          (outcome.pending > 0 ? `, ${outcome.pending} still queued` : "");

        if (outcome.error && !outcome.stopped) {
          say(outcome.error, "bad");
        } else if (outcome.stopped) {
          // Not "bad": everything it counted is committed, and the next pass
          // carries on from there. Reporting a stop somebody asked for in the
          // same red as a failure would make it look like one.
          say(`Stopped — ${moved}. The next pass carries on from here.`, "info");
        } else {
          say(
            moved.charAt(0).toUpperCase() + moved.slice(1),
            outcome.pending > 0 ? "info" : "good"
          );
        }
        onRefresh();
      })
      .then((off) => {
        if (dropped) off();
        else unlisteners.push(off);
      });

    return () => {
      dropped = true;
      for (const off of unlisteners) off();
    };
    // Once: the handlers read nothing that changes, and re-subscribing on
    // every render would miss the steps that arrive between the two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const config = status?.config ?? null;
  const last = status?.last ?? null;
  const where = config?.direct
    ? `${config.direct.host}:${config.direct.port}/${config.direct.database}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ─── Where, and whether it is on ───────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-ft-border">
        <Database size={13} className="shrink-0 text-ft-text-muted" />
        <span className="text-[12px] font-semibold text-ft-text">Sync</span>

        {where ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-ft-text-muted">
            {where}
          </span>
        ) : (
          <span className="text-[10px] text-ft-text-muted">No database connected</span>
        )}

        <div className="flex-1" />

        <button
          className="api-button-quiet flex items-center gap-1.5"
          onClick={onOpenConnection}
        >
          <Settings2 size={11} />
          Connection
        </button>
        {/*
          One button, two jobs — because there is only ever one of them to do,
          and a Stop sitting greyed out beside Sync for the ninety-nine percent
          of the time nothing is running is a worse use of the space than a
          button that says what it does now.

          It reads `config.enabled`, which means "a database is connected",
          rather than whether automatic passes are on. Pressing Sync is the
          request; having switched the timer off is not a reason to refuse it.
        */}
        {syncing ? (
          <button
            className="api-button flex items-center gap-1.5"
            onClick={onStopSync}
            disabled={stopping}
            title={
              stopping
                ? "Stopping at the end of the batch in flight"
                : "Stop after the batch in flight — what has moved is kept"
            }
          >
            {stopping ? (
              <Loader size={11} className="animate-spin" />
            ) : (
              <Square size={11} />
            )}
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            className="api-button flex items-center gap-1.5"
            onClick={onSyncNow}
            disabled={!config?.enabled}
            title={config?.enabled ? "Run a pass now" : "No database is connected"}
          >
            <RefreshCw size={11} />
            Sync now
          </button>
        )}
      </div>

      {/* ─── What is happening, right now ──────────────────────────────── */}
      <div className="px-3 py-2 shrink-0 border-b border-ft-border-subtle">
        {step ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              {step.phase === "push" ? (
                <Upload size={11} className="shrink-0 text-ft-accent" />
              ) : (
                <Download size={11} className="shrink-0 text-ft-accent" />
              )}
              <span className="text-ft-text">
                {step.phase === "push" ? "Sending" : "Taking"} {step.table}
              </span>
              <span className="text-ft-text-muted">
                {step.rows > 0 ? `${step.rows} row${step.rows === 1 ? "" : "s"}` : "…"}
              </span>
              <div className="flex-1" />
              <span className="text-ft-text-muted tabular-nums">
                {step.index + 1} of {step.total}
              </span>
            </div>

            {/* Tables, not rows — see the note at the top of this file. */}
            <div className="api-sync-bar">
              <div
                className="api-sync-bar-fill"
                style={{ width: `${((step.index + 1) / Math.max(1, step.total)) * 100}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-[11px]">
            <Counter label="Queued" value={status?.pending ?? 0} warn={(status?.pending ?? 0) > 0} />
            <Counter
              label="Conflicts"
              value={status?.conflicts ?? 0}
              warn={(status?.conflicts ?? 0) > 0}
            />
            {last && (
              <>
                <Counter label="Sent last pass" value={last.pushed} />
                <Counter label="Taken last pass" value={last.pulled} />
                <span className="text-ft-text-muted">{timeAgo(last.finishedAt, Date.now())}</span>
              </>
            )}
            {!last && <span className="text-ft-text-muted">Nothing has run yet.</span>}
          </div>
        )}
      </div>

      {/* ─── What went wrong, in full ──────────────────────────────────── */}
      {/* A stop is not a failure, so it does not get the red banner: the log
          line above has already said what moved. Only the deadline carries
          both, and it explains itself there. */}
      {last?.error && !last.stopped && (
        <div className="flex items-start gap-2 px-3 py-2 shrink-0 border-b border-ft-border-subtle text-[11px] text-ft-error">
          <CircleAlert size={12} className="mt-[2px] shrink-0" />
          {/* Whole, and selectable. A sync failure is a Postgres error with a
              SQLSTATE and often the name of the table or column that refused,
              and truncating it throws away the half that says what to do. */}
          <span className="min-w-0 break-all font-mono select-text">{last.error}</span>
        </div>
      )}

      {/* ─── The log ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {lines.length === 0 ? (
          <div className="px-3 py-3 text-[11px] leading-relaxed text-ft-text-muted">
            Every pass is listed here as it happens — what was sent, what came back, and
            whatever the database said if it refused. Nothing is kept between openings of
            this tab; the counts above are the durable part.
          </div>
        ) : (
          [...lines].reverse().map((line) => (
            <div
              key={line.id}
              className="flex items-start gap-2 px-3 py-1 border-b border-ft-border-subtle text-[11px]"
            >
              <span className="w-[62px] shrink-0 font-mono text-[10px] text-ft-text-muted">
                {new Date(line.at).toLocaleTimeString()}
              </span>
              {line.tone === "bad" ? (
                <CircleAlert size={11} className="mt-[2px] shrink-0 text-ft-error" />
              ) : line.tone === "good" ? (
                <Check size={11} className="mt-[2px] shrink-0 text-ft-success" />
              ) : (
                <TriangleAlert size={11} className="mt-[2px] shrink-0 text-ft-warning" />
              )}
              <span
                className={`min-w-0 break-all select-text ${
                  line.tone === "bad" ? "font-mono text-ft-error" : "text-ft-text"
                }`}
              >
                {line.text}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-2 shrink-0 border-t border-ft-border-subtle text-[10px] leading-relaxed text-ft-text-muted">
        History never travels: it is large, and it holds response bodies that were never
        meant to be shared. A variable marked secret travels as a name with an empty value.
      </div>
    </div>
  );
}

function Counter({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={`text-[13px] font-semibold tabular-nums ${
          warn ? "text-ft-warning" : "text-ft-text"
        }`}
      >
        {value}
      </span>
      <span className="text-ft-text-muted">{label}</span>
    </span>
  );
}
