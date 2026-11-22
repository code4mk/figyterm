/**
 * Draw · Notes · Both — the switch between a project's two halves.
 *
 * A segmented control rather than window tabs, because these are not documents
 * you might close: both halves of a project always exist, and this only decides
 * which you are looking at. Window tabs would promise a close button that
 * cannot exist.
 *
 * The control itself now lives in `SegmentedTabs`, shared with the editor's
 * Files · Search · Git column switcher. The two ask the same kind of question —
 * one of several, pick one — and were answering it in two different shapes
 * until the editor adopted this one. The sliding pill, the equal-width
 * segments, the roving tabindex and the arrow keys are all there; what stays
 * here is only what is particular to a drawing: the three segments, and the dot
 * that marks Notes when the document has something in it.
 */

import { Columns2, FileText, Pencil } from "lucide-react";
import type { DrawingPane } from "../../services/drawing-project";
import { SegmentedTabs, type Segment } from "../Shared/SegmentedTabs";

const SEGMENTS: Segment<DrawingPane>[] = [
  { value: "draw", label: "Draw", icon: <Pencil size={11} />, title: "The canvas" },
  { value: "notes", label: "Notes", icon: <FileText size={11} />, title: "The written notes" },
  {
    value: "both",
    label: "Both",
    icon: <Columns2 size={11} />,
    title: "Canvas and notes side by side",
  },
];

interface PaneTabsProps {
  pane: DrawingPane;
  onChange: (pane: DrawingPane) => void;
  /** Marks Notes when the document has something in it. */
  hasNotes: boolean;
}

export function PaneTabs({ pane, onChange, hasNotes }: PaneTabsProps) {
  return (
    <SegmentedTabs
      segments={SEGMENTS.map((segment) => ({
        ...segment,
        // Only worth pointing at while you are not already there.
        badge:
          segment.value === "notes" && hasNotes && pane !== "notes" ? (
            <span aria-hidden className="drawing-panes-dot" />
          ) : undefined,
      }))}
      value={pane}
      onChange={onChange}
      ariaLabel="Project view"
    />
  );
}
