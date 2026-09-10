import { useEffect, useState } from "react";
import { onFsChange, unwatch, watchRoot } from "../services/editor-fs";
import type { ExplorerChange } from "../components/Editor/FileExplorer";

/**
 * Subscribes to changes under `root` while the editor is open.
 *
 * The watch is torn down when the editor closes rather than left running: a
 * recursive watch costs real resources (an inotify descriptor per directory on
 * Linux), and an editor nobody has opened should cost nothing. The cost of that
 * choice is that changes made while the editor is closed go unheard, so the
 * modal re-checks its open buffers when it becomes visible again.
 *
 * `mechanism` is `"poll"` when the platform's own watcher couldn't be used —
 * worth surfacing, because it means changes take seconds rather than
 * milliseconds to appear.
 */
export function useFileWatcher(root: string | null, enabled: boolean) {
  const [change, setChange] = useState<ExplorerChange>({
    paths: [],
    overflow: false,
    token: 0,
  });
  const [mechanism, setMechanism] = useState<"native" | "poll" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !root) {
      setMechanism(null);
      return;
    }

    let cancelled = false;

    // Listening before watching, so a change during startup isn't missed.
    const pending = onFsChange((paths, overflow) => {
      if (cancelled) return;
      // The token is what makes two identical bursts distinguishable.
      setChange((prev) => ({ paths, overflow, token: prev.token + 1 }));
    });

    void watchRoot(root)
      .then((used) => {
        if (cancelled) return;
        setMechanism(used === "poll" ? "poll" : "native");
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setMechanism(null);
        setError(String(e));
      });

    return () => {
      cancelled = true;
      pending.then((off) => off()).catch(() => {});
      void unwatch().catch(() => {});
    };
  }, [root, enabled]);

  return { change, mechanism, error };
}
