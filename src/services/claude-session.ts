/**
 * What the Claude window remembers between launches.
 *
 * Projects, their conversations, and where the window sat. Same contract as
 * `editor-session.ts`, for the same reasons: `localStorage`, one versioned blob,
 * read through a merge over defaults so a shape change degrades instead of
 * throwing.
 *
 * **No transcript text, ever.** The CLI already writes every conversation to
 * `~/.claude/projects/<root>/<session-id>.jsonl`; copying that into a
 * synchronous few-megabyte browser store would be slow, redundant and a way to
 * lose it. What is stored is a list of ids — which is enough, because an id is
 * what `--resume` takes.
 */

import { ClaudeProject, Conversation, normalizeFolder } from "./claude-project";

const SESSION_KEY = "figy-term-claude";

/**
 * Bumped when the stored shape changes incompatibly. A mismatch is discarded
 * rather than migrated — it is a folder list, and the conversations it points
 * at are still on disk under their own ids.
 */
const SESSION_VERSION = 1;

/** How many projects are remembered before the least recently used is dropped. */
const MAX_PROJECTS = 20;

/**
 * How many conversations a project keeps.
 *
 * Older ones are still on disk and still resumable through the CLI's own
 * `/resume`; this is only how many FigyTerm offers in a tab strip, and a strip
 * with fifty tabs in it is not a feature.
 */
const MAX_CONVERSATIONS = 20;

export interface PersistedClaudeSession {
  version: number;
  projects: ClaudeProject[];
  /** Which project to reopen. */
  activeProjectId: string | null;
}

const DEFAULT_SESSION: PersistedClaudeSession = {
  version: SESSION_VERSION,
  projects: [],
  activeProjectId: null,
};

/**
 * Checks one stored project before anything acts on it.
 *
 * `localStorage` is user-editable and these strings become a working directory
 * and `--add-dir` arguments. Nothing here is a security boundary — someone who
 * can edit their own storage can also type into the terminal — but a malformed
 * entry should fail as "that folder doesn't exist" rather than as something
 * stranger, and an `extraDirs` of `"/a /b"` should not arrive where a list is
 * expected.
 */
function sanitizeProject(value: unknown): ClaudeProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  const root = typeof raw.root === "string" && raw.root.trim() ? normalizeFolder(raw.root) : null;
  if (!id || !root) return null;

  const extraDirs = Array.isArray(raw.extraDirs)
    ? raw.extraDirs
        .filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0)
        .map(normalizeFolder)
    : [];

  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations
        .map(sanitizeConversation)
        .filter((c): c is Conversation => c !== null)
        .slice(0, MAX_CONVERSATIONS)
    : [];

  return {
    id,
    root,
    // De-duplicated on the way in as well as on the way out: two spellings of
    // one folder would otherwise become two chips granting the same access.
    extraDirs: Array.from(new Set(extraDirs)),
    conversations,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : 0,
    pinned: raw.pinned === true,
    model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
    permissionMode:
      typeof raw.permissionMode === "string"
        ? (raw.permissionMode as ClaudeProject["permissionMode"])
        : undefined,
  };
}

function sanitizeConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  // It becomes a path segment on the Rust side and a `--resume` argument here.
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;

  const launched = raw.launchedWith as Record<string, unknown> | undefined;
  const launchedRoot =
    launched && typeof launched.root === "string" ? normalizeFolder(launched.root) : "";
  const launchedDirs =
    launched && Array.isArray(launched.extraDirs)
      ? launched.extraDirs
          .filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
          .map(normalizeFolder)
      : [];

  return {
    sessionId,
    title: typeof raw.title === "string" ? raw.title : "",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    // Everything loaded from disk is by definition not running: the pty died
    // with the process that owned it. A stored `endedAt` of null would draw a
    // live dot on a conversation that no longer has a process.
    endedAt: typeof raw.endedAt === "number" ? raw.endedAt : (raw.startedAt as number) || 0,
    launchedWith: { root: launchedRoot, extraDirs: launchedDirs },
  };
}

export function loadClaudeSession(): PersistedClaudeSession {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return { ...DEFAULT_SESSION };
    const parsed = JSON.parse(stored) as Partial<PersistedClaudeSession>;
    if (parsed.version !== SESSION_VERSION) return { ...DEFAULT_SESSION };

    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.map(sanitizeProject).filter((p): p is ClaudeProject => p !== null)
      : [];

    const activeProjectId =
      typeof parsed.activeProjectId === "string" &&
      projects.some((p) => p.id === parsed.activeProjectId)
        ? parsed.activeProjectId
        : projects[0]?.id ?? null;

    return { version: SESSION_VERSION, projects, activeProjectId };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

export function saveClaudeSession(session: Omit<PersistedClaudeSession, "version">): void {
  try {
    const projects = [...session.projects]
      // Pinned projects are kept regardless of age; the rest are trimmed by
      // how recently they were used.
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_PROJECTS)
      .map((project) => ({
        ...project,
        conversations: project.conversations.slice(-MAX_CONVERSATIONS),
      }));

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ version: SESSION_VERSION, projects, activeProjectId: session.activeProjectId })
    );
  } catch {
    // A full or unavailable store costs the project list, not the conversation:
    // the transcripts are the CLI's and are already on disk.
  }
}
