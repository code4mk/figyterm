import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  effectiveChange,
  gitIgnored,
  gitRemoteUrl,
  gitStatus,
  GitChange,
  GitRepo,
  NO_REPO,
} from "../services/git";
import { parseRemote, Remote } from "../services/git-forge";

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

/**
 * Minimum gap between two *ignored* runs.
 *
 * Far longer than the status gap, because the answer only changes when someone
 * edits a `.gitignore` — while `git status` changes on every save. Asking for
 * both on every watcher burst would double the processes for a fact that moves
 * once a month, and on a large repository the ignore walk is the slower of the
 * two. Ten seconds is well inside "I edited .gitignore and the tree caught up".
 */
const IGNORED_GAP_MS = 10_000;

/**
 * A ceiling on how long coalescing may delay a run.
 *
 * Belt and braces for the case below: even if something contrives to keep
 * asking, the status is never more than this out of date.
 */
const MAX_DELAY_MS = 1_000;

export interface GitDecorations {
  /** Change per absolute path, for the file tree's badges. */
  files: Map<string, GitChange>;
  /** Every directory on the way to a changed file, so folders can be marked. */
  dirs: Set<string>;
}

export function useGitStatus(root: string | null, enabled: boolean) {
  const [repo, setRepo] = useState<GitRepo>(NO_REPO);
  const [error, setError] = useState<string | null>(null);
  /** Ignored paths, directories collapsed; see `isIgnored`. */
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const ignoredAt = useRef(0);
  const ignoredFor = useRef<string | null>(null);

  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the currently pending run was first asked for. */
  const askedAt = useRef(0);
  /** Guards against a reply for a folder the editor has already left. */
  const wanted = useRef<string | null>(root);
  wanted.current = enabled ? root : null;

  /**
   * The ignore list, refetched only when it is plausibly stale.
   *
   * Always on a change of folder — a different project ignores different things
   * — and otherwise at most once per [`IGNORED_GAP_MS`].
   */
  const refreshIgnored = useCallback(async (dir: string) => {
    const changedFolder = ignoredFor.current !== dir;
    if (!changedFolder && Date.now() - ignoredAt.current < IGNORED_GAP_MS) return;

    ignoredAt.current = Date.now();
    ignoredFor.current = dir;
    // A fresh folder starts with nothing ignored rather than the last one's
    // list, which would grey out rows in a project it knows nothing about.
    if (changedFolder) setIgnored(new Set());

    try {
      const paths = await gitIgnored(dir);
      if (wanted.current === dir) setIgnored(new Set(paths));
    } catch {
      // Not a repository, or git is missing — the status run reports that.
    }
  }, []);

  const run = useCallback(async (dir: string) => {
    running.current = true;
    try {
      void refreshIgnored(dir);
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
  }, [refreshIgnored]);

  /**
   * Asks for a status run, soon.
   *
   * A run already scheduled is **left alone** rather than pushed back, which is
   * the whole of the fix for a real bug: this used to `clearTimeout` and start
   * the window again on every call, so a burst of requests closer together than
   * the window starved it and the run never happened. Committing does exactly
   * that — git writes the index, the objects, the refs and the reflog, the
   * watcher reports each, and the panel sat there still listing files that were
   * already committed.
   *
   * Re-arming is safe to skip because there is nothing to coalesce: the run
   * reads the repository as it finds it, so a later request wants precisely
   * what the pending one is already going to fetch.
   */
  const refresh = useCallback(() => {
    const dir = wanted.current;
    if (!dir) return;

    // Mid-flight: note that the answer is already stale and re-run once it
    // lands, rather than asking two `git status` processes the same question.
    if (running.current) {
      again.current = true;
      return;
    }

    if (timer.current) {
      // Already scheduled. Only bring it forward if it has been waiting long
      // enough that "soon" has stopped being true.
      if (Date.now() - askedAt.current < MAX_DELAY_MS) return;
      clearTimeout(timer.current);
      timer.current = null;
    }

    askedAt.current = Date.now();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (wanted.current) void run(wanted.current);
    }, COALESCE_MS);
  }, [run]);

  useEffect(() => {
    if (!enabled || !root) {
      setRepo(NO_REPO);
      setError(null);
      setIgnored(new Set());
      ignoredFor.current = null;
      return;
    }
    refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [root, enabled, refresh]);

  /**
   * The forge behind the tracked remote, for the links on a SHA and a branch.
   *
   * Fetched on its own rather than with the status, and only when the
   * repository changes: a remote URL changes when somebody edits a config
   * file, not when a file is saved, so asking for it on every watcher burst
   * would be a process per keystroke pause for an answer that never moves.
   */
  const [remote, setRemote] = useState<Remote | null>(null);

  useEffect(() => {
    if (!enabled || !root || !repo.isRepo) {
      setRemote(null);
      return;
    }

    let cancelled = false;
    void gitRemoteUrl(root)
      .then((url) => {
        if (!cancelled) setRemote(parseRemote(url));
      })
      .catch(() => {
        // No remote, or a URL with no web address behind it. There is simply
        // no link to offer, which is not a failure worth reporting.
        if (!cancelled) setRemote(null);
      });

    return () => {
      cancelled = true;
    };
  }, [root, enabled, repo.isRepo]);

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

  return { repo, error, refresh, decorations, remote, ignored };
}
