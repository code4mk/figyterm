/**
 * A stable id for the empty row at the end of a table.
 *
 * Every table here ends in a blank row you can type into — that is how a row is
 * added, and there is no "add" button because of it. The row is scaffolding: it
 * is not in the stored list, so it has to be conjured during render.
 *
 * Conjuring it with `crypto.randomUUID()` is the obvious way and it is wrong.
 * React keys the row off that id, so a fresh one per render unmounts and
 * remounts the row on *every* render — and a field that remounts while you are
 * typing in it loses focus mid-word. That is the "sometimes the input will not
 * take focus" this exists to fix.
 *
 * So the id is held in a ref, and only replaced once the row it belonged to has
 * become a real one. The row being typed into keeps its identity; the new blank
 * that appears behind it gets the next id.
 */

import { useRef } from "react";

export function useBlankRow(): { id: string; renew: () => void } {
  const id = useRef<string>(crypto.randomUUID());
  return {
    id: id.current,
    // Called when the blank row has been typed into and committed, so the next
    // render's blank row is a different row rather than the same one again.
    renew: () => {
      id.current = crypto.randomUUID();
    },
  };
}
