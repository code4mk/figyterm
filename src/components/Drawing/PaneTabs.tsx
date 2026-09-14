/**
 * Draw · Notes · Both — the switch between a project's two halves.
 *
 * A segmented control rather than window tabs, because these are not documents
 * you might close: both halves of a project always exist, and this only decides
 * which you are looking at. Window tabs would promise a close button that
 * cannot exist.
 *
 * The selected segment is drawn by a single sliding pill behind the labels
 * rather than by a background on each button. That is what makes the movement
 * read as one control changing state instead of two buttons swapping colour,
 * and it means the active treatment is defined in exactly one place.
 *
 * Keyboard follows the tablist pattern: `←`/`→` move through the segments and
 * `Home`/`End` jump to the ends, with a roving tabindex so the control is one
 * tab stop rather than three.
 */

import { useRef } from "react";
import { Columns2, FileText, Pencil } from "lucide-react";
import type { DrawingPane } from "../../services/drawing-project";

interface Segment {
  value: DrawingPane;
  label: string;
  icon: React.ReactNode;
  title: string;
}

const SEGMENTS: Segment[] = [
  { value: "draw", label: "Draw", icon: <Pencil size={11} />, title: "The canvas" },
  { value: "notes", label: "Notes", icon: <FileText size={11} />, title: "The written notes" },
  { value: "both", label: "Both", icon: <Columns2 size={11} />, title: "Canvas and notes side by side" },
];

interface PaneTabsProps {
  pane: DrawingPane;
  onChange: (pane: DrawingPane) => void;
  /** Marks Notes when the document has something in it. */
  hasNotes: boolean;
}

export function PaneTabs({ pane, onChange, hasNotes }: PaneTabsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(0, SEGMENTS.findIndex((s) => s.value === pane));

  const focusSegment = (next: number) => {
    const clamped = (next + SEGMENTS.length) % SEGMENTS.length;
    onChange(SEGMENTS[clamped].value);
    ref.current?.querySelector<HTMLElement>(`[data-seg="${clamped}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusSegment(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusSegment(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusSegment(0);
        break;
      case "End":
        e.preventDefault();
        focusSegment(SEGMENTS.length - 1);
        break;
    }
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Project view"
      className="drawing-panes"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/*
        The pill. Width is a third of the track and it slides by whole steps, so
        the three segments must stay equal width — hence `flex: 1 1 0` on each
        rather than letting the labels size them.
      */}
      <span
        aria-hidden
        className="drawing-panes-pill"
        style={{ transform: `translateX(${index * 100}%)` }}
      />

      {SEGMENTS.map((segment, i) => {
        const selected = segment.value === pane;
        return (
          <button
            key={segment.value}
            data-seg={i}
            role="tab"
            aria-selected={selected}
            // Roving tabindex: one tab stop for the whole control.
            tabIndex={selected ? 0 : -1}
            title={segment.title}
            onClick={() => onChange(segment.value)}
            className={`drawing-panes-seg ${selected ? "selected" : ""}`}
          >
            {segment.icon}
            <span>{segment.label}</span>
            {/* Only worth pointing at while you are not already there. */}
            {segment.value === "notes" && hasNotes && !selected && (
              <span aria-hidden className="drawing-panes-dot" />
            )}
          </button>
        );
      })}
    </div>
  );
}
