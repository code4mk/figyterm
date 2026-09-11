import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Search, WholeWord, X } from "lucide-react";
import {
  cancelSearch,
  onSearchDone,
  onSearchResult,
  relativeTo,
  SearchMatch,
  SearchOptions,
  startSearch,
} from "../../services/editor-fs";
import { FileIcon } from "./fileIcons";

/**
 * Project-wide search — ⌘⇧F.
 *
 * Results stream in as the walker finds them (see `fs_search`), so a search
 * across a large repo shows its first hits in milliseconds instead of nothing
 * for two seconds and then everything. Each batch carries the search's id, and
 * anything from a superseded search is dropped: without that, typing quickly
 * interleaves the results of three different queries.
 */

/** Typing pause before a search starts, so each keystroke isn't a tree walk. */
const DEBOUNCE_MS = 220;

/** Files shown expanded at first; past this they arrive collapsed. */
const AUTO_EXPAND_FILES = 8;

interface GlobalSearchProps {
  root: string;
  onOpen: (path: string, line: number, column: number) => void;
  onClose: () => void;
}

interface Group {
  path: string;
  matches: SearchMatch[];
}

export function GlobalSearch({ root, onOpen, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    includeHidden: false,
    includeIgnored: false,
  });
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Only files the user has clicked. Everything else follows the default —
   * the first few groups expanded, the rest collapsed — so a search with 200
   * matching files doesn't open as an unreadable wall.
   */
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  /**
   * The search whose results we're willing to accept. A ref rather than state
   * because the event handler needs the current value without being torn down
   * and re-registered for every search.
   */
  const activeId = useRef<number | null>(null);

  useEffect(() => {
    const pending = [
      onSearchResult((id, batch) => {
        if (id !== activeId.current) return;
        setMatches((prev) => [...prev, ...batch]);
      }),
      onSearchDone((payload) => {
        if (payload.id !== activeId.current) return;
        setStatus("done");
        setComplete(payload.complete);
        if (payload.error) setError(payload.error);
      }),
    ];
    return () => {
      pending.forEach((p) => p.then((off) => off()).catch(() => {}));
      void cancelSearch().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      activeId.current = null;
      setMatches([]);
      setStatus("idle");
      setError(null);
      void cancelSearch().catch(() => {});
      return;
    }

    const timer = setTimeout(() => {
      setMatches([]);
      setStatus("searching");
      setError(null);
      setComplete(true);
      void startSearch(root, trimmed, options)
        .then((id) => {
          activeId.current = id;
        })
        .catch((e) => {
          // A bad regex is the common case here, and the message says which.
          setStatus("done");
          setError(String(e));
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, options, root]);

  const groups = useMemo(() => {
    const byPath = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const existing = byPath.get(match.path);
      if (existing) {
        existing.push(match);
      } else {
        byPath.set(match.path, [match]);
      }
    }
    return [...byPath.entries()].map(([path, group]): Group => ({ path, matches: group }));
  }, [matches]);

  const toggle = useCallback((path: string, wasCollapsed: boolean) => {
    setOverrides((prev) => new Map(prev).set(path, !wasCollapsed));
  }, []);

  const toggleOption = (key: keyof SearchOptions) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="editor-search-panel flex flex-col h-full min-h-0">
      <div className="editor-search-head flex items-center gap-1.5 px-2 h-[26px] shrink-0">
        <Search size={12} className="editor-search-icon shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wide flex-1">Search</span>
        <button
          className="editor-icon-btn p-0.5 rounded"
          onClick={onClose}
          title="Close search"
          aria-label="Close search"
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-2 pb-1.5 shrink-0">
        <div className="editor-search-field flex items-center gap-1 px-2 py-1 rounded-md">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
            placeholder="Search in folder"
            spellCheck={false}
            className="editor-search-input flex-1 min-w-0 bg-transparent outline-none text-[11px]"
          />
          <OptionToggle
            active={options.caseSensitive}
            onClick={() => toggleOption("caseSensitive")}
            title="Match case"
          >
            <CaseSensitive size={12} />
          </OptionToggle>
          <OptionToggle
            active={options.wholeWord}
            onClick={() => toggleOption("wholeWord")}
            title="Whole word"
          >
            <WholeWord size={12} />
          </OptionToggle>
          <OptionToggle
            active={options.regex}
            onClick={() => toggleOption("regex")}
            title="Regular expression"
          >
            <Regex size={12} />
          </OptionToggle>
        </div>

        <div className="flex items-center gap-3 mt-1.5 px-0.5">
          <Checkbox
            checked={options.includeIgnored}
            onChange={() => toggleOption("includeIgnored")}
            label="Ignored files"
          />
          <Checkbox
            checked={options.includeHidden}
            onChange={() => toggleOption("includeHidden")}
            label="Hidden files"
          />
        </div>
      </div>

      <div className="editor-search-status px-2.5 pb-1 text-[10px] shrink-0">
        {error
          ? error
          : status === "searching"
            ? `Searching… ${matches.length} found`
            : status === "done"
              ? `${matches.length} ${matches.length === 1 ? "result" : "results"} in ${
                  groups.length
                } ${groups.length === 1 ? "file" : "files"}${complete ? "" : " (showing the first 2000)"}`
              : ""}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {groups.map((group, index) => {
          const override = overrides.get(group.path);
          const isCollapsed = override ?? index >= AUTO_EXPAND_FILES;

          return (
            <div key={group.path}>
              <button
                className="editor-search-file flex items-center gap-1.5 w-full px-2 py-1 text-left"
                onClick={() => toggle(group.path, isCollapsed)}
              >
                <span className="shrink-0">
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </span>
                <FileIcon path={group.path} size={12} />
                <span className="flex-1 min-w-0 truncate text-[11px]">
                  {relativeTo(root, group.path)}
                </span>
                <span className="editor-search-count text-[10px] shrink-0">
                  {group.matches.length}
                </span>
              </button>

              {!isCollapsed &&
                group.matches.map((match, matchIndex) => (
                  <button
                    key={`${match.line}-${match.lineColumn}-${matchIndex}`}
                    className="editor-search-hit flex items-baseline gap-2 w-full pl-7 pr-2 py-0.5 text-left"
                    // `lineColumn`, not `column`: the latter indexes the trimmed
                    // text below, which on a long line starts partway in.
                    onClick={() => onOpen(match.path, match.line, match.lineColumn + 1)}
                  >
                    <span className="editor-search-line text-[10px] shrink-0 tabular-nums">
                      {match.line}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[11px] font-mono">
                      {match.text.slice(0, match.column)}
                      <mark className="editor-search-mark">
                        {match.text.slice(match.column, match.column + match.length)}
                      </mark>
                      {match.text.slice(match.column + match.length)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OptionToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`editor-search-toggle p-0.5 rounded shrink-0 ${active ? "active" : ""}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="editor-search-check flex items-center gap-1 text-[10px] cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} className="editor-checkbox" />
      {label}
    </label>
  );
}
