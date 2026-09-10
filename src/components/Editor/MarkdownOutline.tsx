import { useEffect, useMemo, useRef } from "react";
import { ListTree, X } from "lucide-react";
import { scrollIntoViewWithin } from "../../services/scroll";
import {
  activeOutlineIndex,
  normalizeDepth,
  parseOutline,
} from "../../services/markdown-outline";

/**
 * The table of contents, as a rail down the right of the preview.
 *
 * It used to share the right-hand panel with the file tree and the search
 * results, which cost a whole column and meant choosing between the outline and
 * the tree. It lives inside the preview instead: the prose is capped at a
 * readable measure, so there is already empty space to the right of it, and a
 * contents list is the natural thing to put beside a rendered document.
 *
 * Clicking an entry moves the editor's cursor to that heading *and* scrolls the
 * preview to it, so it works the same whether you're reading or writing. The
 * entry you're currently inside is marked as you scroll either pane, which is
 * the thing that makes a long file navigable.
 */

const INDENT = 10;

interface MarkdownOutlineProps {
  /** Hides the rail. Omitted when there is nowhere for it to go. */
  onClose?: () => void;
  source: string;
  /**
   * The line to mark as current — the top of whichever pane was last scrolled.
   *
   * Scroll position rather than caret position: "where am I in this document"
   * is about what's on screen, and while reading the caret is usually somewhere
   * else, often off screen entirely.
   */
  activeLine: number;
  onSelect: (line: number) => void;
}

export function MarkdownOutline({
  source,
  activeLine,
  onSelect,
  onClose,
}: MarkdownOutlineProps) {
  const entries = useMemo(() => parseOutline(source), [source]);
  const rows = useMemo(() => normalizeDepth(entries), [entries]);
  const active = useMemo(() => activeOutlineIndex(entries, activeLine), [entries, activeLine]);
  const listRef = useRef<HTMLDivElement>(null);

  // Follows the marked entry, but only scrolls when it's off screen, so
  // reading the outline isn't interrupted by it jumping around.
  useEffect(() => {
    if (active < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-outline-index="${active}"]`
    );
    scrollIntoViewWithin(listRef.current, row);
  }, [active]);

  return (
    <div className="editor-outline flex flex-col h-full min-h-0">
      {/*
        A quiet label, not a second toolbar. It sits under the preview's own
        header, and giving it a bar of its own — background, border, 26px —
        stacked two toolbars on top of each other and looked broken.
      */}
      <div className="editor-outline-label flex items-center gap-1.5 px-3 pt-2.5 pb-1 shrink-0">
        <ListTree size={10} className="shrink-0" />
        <span className="text-[9px] font-semibold uppercase tracking-wide flex-1">
          On this page
        </span>
        {onClose && (
          <button
            className="editor-outline-hide p-0.5 rounded shrink-0"
            onClick={onClose}
            title="Hide the outline"
            aria-label="Hide the outline"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto pb-3 pr-1">
        {rows.map(({ entry, depth }, index) => (
          <button
            key={`${entry.line}-${index}`}
            data-outline-index={index}
            className={`editor-outline-row flex items-center w-full pr-2 py-[3px] text-left ${
              index === active ? "active" : ""
            }`}
            // Indented by depth alone — the level chips read as clutter in a
            // list this narrow, and the indent already carries the hierarchy.
            style={{ paddingLeft: 12 + depth * INDENT }}
            onClick={() => onSelect(entry.line)}
            title={`${entry.text} — line ${entry.line}`}
          >
            <span
              className={`min-w-0 truncate ${
                depth === 0 ? "text-[11.5px] font-medium" : "text-[11px]"
              }`}
            >
              {entry.text}
            </span>
          </button>
        ))}

        {rows.length === 0 && (
          <div className="editor-outline-empty px-3 py-3 text-[11px]">
            No headings in this file.
          </div>
        )}
      </div>
    </div>
  );
}
