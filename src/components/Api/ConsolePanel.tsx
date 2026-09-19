/**
 * The console, docked at the foot of the window.
 *
 * Every other surface here shows the *result* of something. This one shows what
 * the window did: what went out, what came back, what a script printed, what a
 * sync pass moved. When a send never leaves, or a variable is set to the wrong
 * thing, or a pass pushes nothing, this is the only place the evidence appears.
 *
 * Collapsed it is one line with a count on it, because a console that takes a
 * third of the window when nothing is wrong is a console people close and
 * forget. Open it is a log, filterable and copyable.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CircleAlert, Copy, Trash2, TriangleAlert } from "lucide-react";
import {
  clockOf,
  ConsoleEntry,
  ConsoleLevel,
  formatAll,
  formatLine,
  matches,
  summarise,
} from "../../services/api/console";

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  /** Takes you to the tab a line came from, when it came from one. */
  onOpenTab: (tabId: string) => void;
}

const LEVELS: { level: ConsoleLevel; label: string }[] = [
  { level: "info", label: "Info" },
  { level: "warn", label: "Warnings" },
  { level: "error", label: "Errors" },
];

function levelClass(level: ConsoleLevel): string {
  return level === "error"
    ? "text-ft-error"
    : level === "warn"
      ? "text-ft-warning"
      : "text-ft-text-secondary";
}

export function ConsolePanel({
  entries,
  open,
  onToggle,
  onClear,
  onOpenTab,
}: ConsolePanelProps) {
  // The filter lives here rather than in the store: it is how somebody is
  // reading the log right now, not something the window should remember about
  // them a week later.
  const [levels, setLevels] = useState<Set<ConsoleLevel>>(new Set());
  const [query, setQuery] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const { errors, warnings } = summarise(entries);
  const shown = open ? entries.filter((entry) => matches(entry, { levels, query })) : [];

  /**
   * Follows the log down — but only when it is already at the bottom.
   *
   * Scrolling back to read a failure and being yanked to the end by the next
   * line is the behaviour that makes a console unusable during a run.
   */
  const pinned = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !open || !pinned.current) return;
    list.scrollTop = list.scrollHeight;
  }, [shown.length, open]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const toggleLevel = (level: ConsoleLevel) => {
    const next = new Set(levels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    setLevels(next);
  };

  return (
    <div className="flex flex-col shrink-0 border-t border-ft-border bg-ft-tab">
      {/* The bar. It is the whole console when collapsed. */}
      <div className="flex items-center gap-2 px-2 h-6 shrink-0">
        <button
          className="flex items-center gap-1.5 text-[10px] text-ft-text-muted hover:text-ft-text"
          onClick={onToggle}
          title={open ? "Hide the console" : "Show the console"}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
          Console
          {entries.length > 0 && (
            <span className="text-ft-text-muted">{entries.length}</span>
          )}
        </button>

        {errors > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-ft-error">
            <CircleAlert size={10} />
            {errors}
          </span>
        )}
        {warnings > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-ft-warning">
            <TriangleAlert size={10} />
            {warnings}
          </span>
        )}

        {/* The newest line, so the collapsed bar says something rather than
            just counting. */}
        {!open && entries.length > 0 && (
          <button
            className={`min-w-0 flex-1 truncate text-left text-[10px] ${levelClass(
              entries[entries.length - 1]!.level
            )}`}
            onClick={onToggle}
            title="Show the console"
          >
            {entries[entries.length - 1]!.text}
          </button>
        )}

        <div className="flex-1" />

        {open && (
          <>
            {LEVELS.map(({ level, label }) => (
              <button
                key={level}
                className={`api-tab ${levels.has(level) ? "selected" : ""}`}
                onClick={() => toggleLevel(level)}
                title={
                  levels.size === 0
                    ? `Show only ${label.toLowerCase()}`
                    : levels.has(level)
                      ? `Stop showing ${label.toLowerCase()}`
                      : `Also show ${label.toLowerCase()}`
                }
                aria-pressed={levels.has(level)}
              >
                {label}
              </button>
            ))}
            <input
              className="api-rail-search w-[140px]"
              value={query}
              spellCheck={false}
              placeholder="Filter"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter the console"
            />
            <button
              className="api-rail-action"
              onClick={() => copy(formatAll(shown))}
              title="Copy what is shown"
              aria-label="Copy the console"
            >
              <Copy size={12} />
            </button>
            <button
              className="api-rail-action danger"
              onClick={onClear}
              title="Clear the console"
              aria-label="Clear the console"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>

      {open && (
        <div
          ref={listRef}
          className="h-[180px] shrink-0 overflow-auto border-t border-ft-border-subtle"
          onScroll={(e) => {
            const list = e.currentTarget;
            // A few pixels of slack: a list scrolled to the bottom is rarely
            // at exactly `scrollHeight`.
            pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
          }}
        >
          {shown.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-ft-text-muted">
              {entries.length === 0
                ? "Everything this window does is listed here: what was sent, what came back, what a script printed, what a sync pass moved."
                : "Nothing matches that filter."}
            </div>
          ) : (
            shown.map((entry) => (
              <div
                key={entry.id}
                className="group flex items-start gap-2 px-2 py-0.5 font-mono text-[10px] leading-relaxed hover:bg-ft-surface"
              >
                <span className="shrink-0 tabular-nums text-ft-text-muted">
                  {clockOf(entry.at)}
                </span>
                <span className="w-12 shrink-0 text-ft-text-muted">{entry.source}</span>
                <span className={`min-w-0 flex-1 break-all ${levelClass(entry.level)}`}>
                  {entry.text}
                  {entry.detail && (
                    <span className="text-ft-text-muted"> — {entry.detail}</span>
                  )}
                </span>

                {entry.tabId && (
                  <button
                    className="api-row-action group-hover:opacity-100"
                    onClick={() => onOpenTab(entry.tabId!)}
                    title="Go to the tab this came from"
                    aria-label="Go to the tab this came from"
                  >
                    <ChevronUp size={11} />
                  </button>
                )}
                <button
                  className="api-row-action group-hover:opacity-100"
                  onClick={() => copy(formatLine(entry))}
                  title="Copy this line"
                  aria-label="Copy this line"
                >
                  <Copy size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
