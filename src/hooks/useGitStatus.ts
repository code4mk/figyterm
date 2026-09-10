import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { effectiveChange, gitStatus, GitChange, GitRepo, NO_REPO } from "../services/git";

/**
 * The repository behind the open folder, kept roughly current.
 *
 * Refreshed on three things: the folder changing, the file watcher reporting
 * anything (which includes writes under `.git`, so a commit or a checkout in
 * the pane behind shows up without polling), and an explicit ask after the
 * editor itself stages or commits something.
 *
 * Coalesced, because the watcher fires in bursts and `git status` is a process:
 * a request while one is already running sets a flag and re-runs once, instead
 * of queueing a process per event. A `git rebase` or a `npm install` under a
 * watched tree is exactly the burst that would otherwise fork a hundred times.
 *
 * A folder that isn't a repository is the ordinary case, not a failure, so it
 * resolves to `NO_REPO` and the UI simply has nothing to show.
 */

/** Minimum gap between two status runs. */
const COALESCE_MS = 250;

export interface GitDecorations {
  /** Change per absolute path, for the file tree's badges. */
  files: Map<string, GitChange>;
  /** Every directory on the way to a changed file, so folders can be marked. */
  dirs: Set<string>;
}

export function useGitStatus(root: string | null, enabled: boolean) {
  const [repo, setRepo] = useState<GitRepo>(NO_REPO);
  const [error, setError] = useState<string | null>(null);

  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against a reply for a folder the editor has already left. */
  const wanted = useRef<string | null>(root);
  wanted.current = enabled ? root : null;

  const run = useCallback(async (dir: string) => {
    running.current = true;
    try {
      const next = await gitStatus(dir);
      if (wanted.current === dir) {
        setRepo(next);
        setError(null);
      }
    } catch (e) {
      if (wanted.current === dir) {
        setRepo(NO_REPO);
        // Reported rather than swallowed: "git was not found on PATH" is worth
        // seeing once, and it's the difference between "no repository here"
        // and "git integration is not working at all".
        setError(String(e));
      }
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        if (wanted.current) void run(wanted.current);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    const dir = wanted.current;
    if (!dir) return;
    if (running.current) {
      again.current = true;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (wanted.current) void run(wanted.current);
    }, COALESCE_MS);
  }, [run]);

  useEffect(() => {
    if (!enabled || !root) {
      setRepo(NO_REPO);
      setError(null);
      return;
    }
    refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [root, enabled, refresh]);

  const decorations = useMemo<GitDecorations>(() => {
    const files = new Map<string, GitChange>();
    const dirs = new Set<string>();
    if (!repo.isRepo || !repo.root) return { files, dirs };

    for (const file of repo.files) {
      files.set(file.path, effectiveChange(file));

      // Every ancestor up to the repository top level, so a collapsed folder
      // still says something changed inside it. Walked by trimming the string
      // rather than with `dirname`, so a path separator that isn't this
      // platform's can't produce a directory nobody will match.
      let at = file.path;
      for (;;) {
        const cut = Math.max(at.lastIndexOf("/"), at.lastIndexOf("\\"));
        if (cut <= 0) break;
        at = at.slice(0, cut);
        // Stop at the repository itself: it has no row in the tree to mark,
        // and once an ancestor is already in the set so is everything above it.
        if (at.length <= repo.root.length || dirs.has(at)) break;
        dirs.add(at);
      }
    }
    return { files, dirs };
  }, [repo]);

  return { repo, error, refresh, decorations };
}
