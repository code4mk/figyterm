/**
 * The folders Figy Code is pointed at — the one part of that window that is
 * not invented.
 *
 * A project here is a real path the user chose, through the OS folder dialog
 * or from the terminal's own history, and it survives a restart. Nothing in
 * this file reads the folder: the agent that would is not written yet, and
 * `fs_set_roots` — the guard every filesystem command goes through — is
 * currently owned by the editor window, which replaces the whole list when it
 * opens a folder. A second window calling it would quietly take the editor's
 * root away. Sharing that list is the first thing the real agent has to
 * settle; until then, Figy Code knows a path and nothing behind it.
 *
 * The identity of a project is its normalised path. There is no name field
 * and no id: two checkouts of one repository are both called `api`, and what
 * tells them apart is the line underneath, which is the path itself. This is
 * the same decision `claude-project.ts` made, for the same reason.
 */

import { normalizeDir } from "./recent-dirs";

const STORAGE_KEY = "figycode-projects";
const MAX_PROJECTS = 24;

export interface FigyProject {
  /** Absolute and normalised. Also the identity. */
  root: string;
  /** Folders outside the root the agent would also be allowed to touch. */
  extraDirs: string[];
  lastUsedAt: number;
}

/* ─── Pure ────────────────────────────────────────────────────────────────── */

/** `~/code/fig-alternative` → `fig-alternative`, and a root stays itself. */
export function projectLabel(root: string): string {
  const segments = root.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || root;
}

/**
 * Puts `root` at the front, creating it if it is new.
 *
 * Returns a new list — the caller saves it — and keeps whatever extra folders
 * the project already had, because reopening a project is not a reason to
 * narrow what it can reach.
 */
export function rememberProject(
  projects: FigyProject[],
  root: string,
  at = Date.now()
): FigyProject[] {
  const normalized = normalizeDir(root.trim());
  if (!normalized) return projects;

  const existing = projects.find((p) => p.root === normalized);
  const rest = projects.filter((p) => p.root !== normalized);
  const next: FigyProject = existing
    ? { ...existing, lastUsedAt: at }
    : { root: normalized, extraDirs: [], lastUsedAt: at };

  return [next, ...rest].slice(0, MAX_PROJECTS);
}

export function forgetProject(projects: FigyProject[], root: string): FigyProject[] {
  const normalized = normalizeDir(root);
  return projects.filter((p) => p.root !== normalized);
}

/**
 * Grants a project one more folder.
 *
 * Add-only, and the root is never also an extra: a chip saying the agent may
 * reach the folder it is already running in is a chip that explains nothing.
 */
export function addExtraDir(
  projects: FigyProject[],
  root: string,
  dir: string
): FigyProject[] {
  const normalizedRoot = normalizeDir(root);
  const normalizedDir = normalizeDir(dir.trim());
  if (!normalizedDir || normalizedDir === normalizedRoot) return projects;

  return projects.map((project) =>
    project.root === normalizedRoot && !project.extraDirs.includes(normalizedDir)
      ? { ...project, extraDirs: [...project.extraDirs, normalizedDir] }
      : project
  );
}

/**
 * The rows the picker offers: every known project, then every recent folder
 * that is not already one of them.
 *
 * Suggestions are kept apart from projects rather than merged into the list,
 * because "a folder you have been in" and "a folder you pointed Figy Code at"
 * are different claims and the picker says which is which.
 */
export function pickerRows(
  projects: FigyProject[],
  recent: string[],
  cwd?: string
): { root: string; known: boolean }[] {
  const seen = new Set(projects.map((p) => p.root));
  const rows = projects.map((p) => ({ root: p.root, known: true }));

  const suggestions = cwd ? [cwd, ...recent] : recent;
  for (const dir of suggestions) {
    const normalized = normalizeDir(dir);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    rows.push({ root: normalized, known: false });
  }
  return rows;
}

/** Case-insensitive, against the whole path — `web/api` and `src/api` differ
 *  only in what is in front of them. */
export function filterRows<T extends { root: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => row.root.toLowerCase().includes(q));
}

/* ─── Storage ─────────────────────────────────────────────────────────────── */

export function loadProjects(): FigyProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FigyProject[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.root === "string")
      .map((p) => ({
        root: p.root,
        extraDirs: Array.isArray(p.extraDirs) ? p.extraDirs : [],
        lastUsedAt: typeof p.lastUsedAt === "number" ? p.lastUsedAt : 0,
      }));
  } catch {
    // A corrupt entry is not worth a broken window.
    return [];
  }
}

export function saveProjects(projects: FigyProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects.slice(0, MAX_PROJECTS)));
  } catch {
    // Private mode, a full quota: the list is a convenience, not the work.
  }
}
