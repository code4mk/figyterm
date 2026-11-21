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
    <div className="flex h-full w-full flex-col items-center justify-center gap-3.5 px-6 text-center">
      {/*
        A framed mark rather than a bare glyph at 40% opacity. An empty screen
        needs somewhere for the eye to land before it reads anything, and a
        faded icon is a thing the eye skips.
      */}
      <span className="drawing-medallion">
        <Pencil size={18} />
      </span>
      <span className="drawing-empty-title">No drawing open</span>
      <p className="drawing-empty-body max-w-[24rem]">
        Drawings are saved as you work — there is nothing to press.
      </p>
      {/*
        The button's hover used to go *darker* than its resting state: it was
        written against a `bg-tertiary`/`bg-secondary` pair that this app never
        defined, so neither tone applied and the inversion was invisible. It is
        the accent now, which is what the only action on an empty screen should
        be.
      */}
      <button className="drawing-btn primary" onClick={onCreate}>
        <Plus size={12} />
        New drawing
      </button>
    </div>
  );
}
