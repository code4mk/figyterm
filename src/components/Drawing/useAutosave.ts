/**
 * The saving contract, shared by the canvas and the notes.
 *
 * Both panes want the same four things, and getting any of them wrong loses
 * work, so there is one copy of it:
 *
 * 1. **Idle-debounced, with a ceiling.** A write 800 ms after the last change,
 *    and at most 5 s since the last one. The ceiling matters because a change
 *    stream that never goes idle — a long drag on the canvas, a fast typist in
 *    the notes — would otherwise never trigger the idle timer.
 * 2. **No write without a change**, decided by a cheap `mark` rather than by
 *    comparing the value itself.
 * 3. **Every way out flushes**: unmount, tab hidden, window closing.
 * 4. **Nothing is written until something is recorded.** This is the one that
 *    is easy to get wrong and expensive when you do. The most important flush
 *    of all runs on unmount — switching pane, switching project, closing the
 *    window — and a pane that was opened and not touched must write *nothing*
 *    there, rather than writing its empty initial state over stored work.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

/** How long after the last change to write. */
const IDLE_MS = 800;
/** The longest a change may go unwritten. */
const CEILING_MS = 5000;

interface AutosaveOptions<T> {
  /** Persists the value. Called from the debounce, the ceiling and the flush. */
  write: (value: T) => void;
  /**
   * A cheap identity for the value. Two values with the same mark are the same
   * document as far as saving is concerned, and the second is not written.
   */
  mark: (value: T) => string;
}

export interface Autosave<T> {
  /** Notes a change. Schedules a write; does not perform one. */
  record: (value: T) => void;
  /** Writes now, if anything has been recorded and it differs from the last. */
  flush: () => void;
  /** Forgets everything, for a pane about to load a different document. */
  reset: () => void;
}

export function useAutosave<T>({ write, mark }: AutosaveOptions<T>): Autosave<T> {
  const latestRef = useRef<T | null>(null);
  /** Separate from `latestRef` so that `null` can be a legitimate value. */
  const hasValueRef = useRef(false);
  const savedMarkRef = useRef<string | null>(null);
  const idleTimer = useRef<number | null>(null);
  const ceilingTimer = useRef<number | null>(null);

  // Read through refs so the window listeners below can be registered once and
  // never hold a stale closure.
  const writeRef = useRef(write);
  writeRef.current = write;
  const markRef = useRef(mark);
  markRef.current = mark;

  const clearTimers = useCallback(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    if (ceilingTimer.current !== null) window.clearTimeout(ceilingTimer.current);
    idleTimer.current = null;
    ceilingTimer.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimers();
    if (!hasValueRef.current) return;

    const value = latestRef.current as T;
    const stamp = markRef.current(value);
    if (savedMarkRef.current === stamp) return;

    savedMarkRef.current = stamp;
    writeRef.current(value);
  }, [clearTimers]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const record = useCallback((value: T) => {
    // Recorded before the early return: a change that does not warrant a write
    // of its own is still the freshest version there is, and the flush on
    // unmount reads exactly this.
    latestRef.current = value;
    hasValueRef.current = true;

    if (savedMarkRef.current === markRef.current(value)) return;

    // Idle: restarted by every change, so a burst writes once at the end.
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => flushRef.current(), IDLE_MS);

    // Ceiling: deliberately *not* restarted, so a stream that never goes idle
    // still lands.
    if (ceilingTimer.current === null) {
      ceilingTimer.current = window.setTimeout(() => flushRef.current(), CEILING_MS);
    }
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    latestRef.current = null;
    hasValueRef.current = false;
    savedMarkRef.current = null;
  }, [clearTimers]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    const onUnload = () => flushRef.current();

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      flushRef.current();
    };
  }, []);

  // Memoised: callers put this in effect dependency arrays, and a fresh object
  // every render would re-run the load effect forever. The three callbacks are
  // already stable, so this is too.
  return useMemo(() => ({ record, flush, reset }), [record, flush, reset]);
}
