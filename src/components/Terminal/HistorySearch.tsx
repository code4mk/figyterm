import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, Clock, CornerDownLeft, X, PictureInPicture2, Maximize2 } from "lucide-react";

interface HistoryEntry {
  command: string;
  timestamp: number | null;
}

interface HistorySearchProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (command: string) => void;
}

const PAGE_SIZE = 50;
const MIN_WIDTH = 340;
const MIN_HEIGHT = 180;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 700;

function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (t.includes(q)) {
    const idx = t.indexOf(q);
    return { match: true, score: 100 - idx };
  }

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10;
      if (lastMatchIdx >= 0 && ti - lastMatchIdx === 1) score += 5;
      lastMatchIdx = ti;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

function highlightMatch(command: string, query: string): JSX.Element {
  if (!query) return <>{command}</>;

  const lower = command.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);

  if (idx >= 0) {
    return (
      <>
        {command.slice(0, idx)}
        <span className="history-highlight">{command.slice(idx, idx + query.length)}</span>
        {command.slice(idx + query.length)}
      </>
    );
  }

  return <>{command}</>;
}

function formatTime(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;

  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HistorySearch({ visible, onClose, onSelect }: HistorySearchProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pipMode, setPipMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Resize state
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 520, h: 440 });
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    if (visible) {
      setQuery("");
      setSelectedIndex(0);
      setVisibleCount(PAGE_SIZE);
      setPipMode(false);
      setPos(null);
      setSize({ w: 520, h: 440 });
      setLoading(true);
      invoke<HistoryEntry[]>("read_shell_history", { maxEntries: 5000 })
        .then((result) => {
          setEntries(result);
          setLoading(false);
        })
        .catch(() => setLoading(false));

      setTimeout(() => inputRef.current?.focus(), 50);
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [visible]);

  const allFiltered = useMemo(() => {
    if (!query.trim()) return entries;
    return entries
      .map((e) => ({ entry: e, ...fuzzyMatch(query, e.command) }))
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.entry);
  }, [entries, query]);

  const filtered = useMemo(() => {
    return allFiltered.slice(0, visibleCount);
  }, [allFiltered, visibleCount]);

  const hasMore = visibleCount < allFiltered.length;

  useEffect(() => {
    setSelectedIndex(0);
    setVisibleCount(PAGE_SIZE);
  }, [query]);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollTop + clientHeight >= scrollHeight - 40) {
      setVisibleCount((c) => c + PAGE_SIZE);
    }
  }, [hasMore]);

  const handleSelect = useCallback((cmd: string) => {
    onSelect(cmd);
    if (!pipMode) onClose();
  }, [onSelect, onClose, pipMode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => {
        const next = Math.min(i + 1, filtered.length - 1);
        if (next >= visibleCount - 5 && hasMore) {
          setVisibleCount((c) => c + PAGE_SIZE);
        }
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        handleSelect(filtered[selectedIndex].command);
      }
    }
  }, [filtered, selectedIndex, handleSelect, onClose, visibleCount, hasMore]);

  // --- Drag handlers ---
  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const modal = modalRef.current;
    if (!modal) return;

    const rect = modal.getBoundingClientRect();
    const currentX = pos ? pos.x : rect.left;
    const currentY = pos ? pos.y : rect.top;

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: currentX,
      origY: currentY,
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPos({
        x: Math.max(0, dragRef.current.origX + dx),
        y: Math.max(0, dragRef.current.origY + dy),
      });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [pos]);

  // --- Resize handlers ---
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: size.w,
      origH: size.h,
    };

    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      const dx = ev.clientX - resizeRef.current.startX;
      const dy = ev.clientY - resizeRef.current.startY;
      setSize({
        w: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeRef.current.origW + dx)),
        h: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, resizeRef.current.origH + dy)),
      });
    };

    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [size]);

  const togglePip = useCallback(() => {
    setPipMode((prev) => {
      const next = !prev;
      if (next && !pos) {
        // Enter PiP: snap to bottom-right
        setSize({ w: 420, h: 360 });
        setPos({
          x: window.innerWidth - 440,
          y: window.innerHeight - 380,
        });
      } else if (!next) {
        // Exit PiP: center it again
        setPos(null);
        setSize({ w: 520, h: 440 });
      }
      return next;
    });
  }, [pos]);

  if (!visible) return null;

  const totalCount = allFiltered.length;
  const headerHeight = 90;
  const listMaxHeight = size.h - headerHeight;

  const modalStyle: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: size.w }
    : { width: size.w };

  const modal = (
    <div
      ref={modalRef}
      className={`history-modal rounded-xl overflow-hidden shadow-2xl ${pipMode ? "history-pip" : ""}`}
      style={modalStyle}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {/* Drag handle header */}
      <div
        className="history-drag-handle flex items-center justify-between px-3 py-1 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={handleDragStart}
      >
        <span className="text-[10px] history-pip-label font-medium">
          {pipMode ? "PiP — History" : "History"}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="history-pip-btn p-0.5 rounded transition-colors"
            onClick={(e) => { e.stopPropagation(); togglePip(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title={pipMode ? "Exit PiP mode" : "Enter PiP mode"}
          >
            {pipMode ? <Maximize2 size={12} /> : <PictureInPicture2 size={12} />}
          </button>
        </div>
      </div>

      {/* Search input */}
      <div className="history-header flex items-center gap-2.5 px-4 py-2.5">
        <Search size={15} className="history-search-icon shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); handleKeyDown(e); }}
          onKeyUp={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          placeholder="Search command history..."
          className="history-input flex-1 bg-transparent outline-none text-sm"
          autoFocus
        />
        <div className="flex items-center gap-1.5">
          {totalCount > 0 && (
            <span className="history-count text-[10px]">
              {totalCount}{query ? " found" : " commands"}
            </span>
          )}
          <button onClick={onClose} className="history-close-btn p-1 rounded transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Keyboard hints */}
      <div className="history-hints flex items-center gap-3 px-4 py-1.5">
        <span className="flex items-center gap-1">
          <kbd className="history-kbd">↑↓</kbd>
          <span>navigate</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="history-kbd">↵</kbd>
          <span>select</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="history-kbd">esc</kbd>
          <span>close</span>
        </span>
      </div>

      {/* Results */}
      <div
        ref={listRef}
        className="history-list overflow-y-auto"
        style={{ maxHeight: Math.max(80, listMaxHeight) }}
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="px-4 py-8 text-center text-xs history-empty">
            Loading history...
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs history-empty">
            {query ? "No matching commands" : "No history found"}
          </div>
        ) : (
          <>
            {filtered.map((entry, i) => (
              <button
                key={`${entry.command}-${i}`}
                ref={i === selectedIndex ? selectedRef : null}
                onClick={() => handleSelect(entry.command)}
                className={`history-item w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                  i === selectedIndex ? "active" : ""
                }`}
              >
                <Clock size={11} className="history-item-icon shrink-0" />
                <span className="history-command flex-1 min-w-0 truncate text-xs font-mono">
                  {highlightMatch(entry.command, query)}
                </span>
                {entry.timestamp && (
                  <span className="history-time text-[10px] shrink-0">
                    {formatTime(entry.timestamp)}
                  </span>
                )}
                {i === selectedIndex && (
                  <CornerDownLeft size={11} className="history-enter-icon shrink-0" />
                )}
              </button>
            ))}
            {hasMore && (
              <div className="px-4 py-2 text-center text-[10px] history-empty">
                Showing {filtered.length} of {totalCount} — scroll for more
              </div>
            )}
          </>
        )}
      </div>

      {/* Resize handle */}
      <div
        className="history-resize-handle"
        onPointerDown={handleResizeStart}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="history-resize-icon">
          <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );

  // PiP mode: no backdrop, terminal is fully interactive
  if (pipMode) {
    return modal;
  }

  // Normal mode: centered with backdrop
  return (
    <div
      className="fixed inset-0 z-[250] flex items-start justify-center pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {modal}
    </div>
  );
}
