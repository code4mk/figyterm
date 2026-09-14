/**
 * What the canvas area shows when there is no drawing to show.
 *
 * Two cases, and they are not the same thing: a list that has never had
 * anything in it wants an invitation, and a list whose last project was just
 * deleted wants the same invitation without implying something went wrong.
 * Both get the button, because the only useful thing to do here is make one.
 */

import { Pencil, Plus } from "lucide-react";

interface DrawingEmptyProps {
  onCreate: () => void;
}

export function DrawingEmpty({ onCreate }: DrawingEmptyProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Pencil size={28} className="text-ft-text-muted opacity-40" />
      <div className="text-sm text-ft-text">No drawing open</div>
      <p className="max-w-[24rem] text-[11px] leading-relaxed text-ft-text-muted">
        Drawings are saved as you work — there is nothing to press.
      </p>
      <button
        className="mt-1 flex items-center gap-1.5 rounded-md border border-ft-border bg-ft-bg-tertiary px-3 py-1.5 text-[11px] font-medium text-ft-text hover:bg-ft-bg-secondary"
        onClick={onCreate}
      >
        <Plus size={12} />
        New drawing
      </button>
    </div>
  );
}
