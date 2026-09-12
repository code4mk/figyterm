import { create } from "zustand";
import {
  alreadyCovered,
  ClaudeProject,
  Conversation,
  normalizeFolder,
} from "../services/claude-project";
import { loadClaudeSession, saveClaudeSession } from "../services/claude-session";

/**
 * Projects and conversations — the metadata, and nothing that is alive.
 *
 * The ptys and their xterm instances are deliberately *not* in here. A
 * conversation's terminal is a mutable object with a scrollback buffer that is
 * written to many times a second; putting one in a store would re-render the
 * project switcher on every chunk of output. `ClaudeModal` keeps them in a ref
 * map keyed by session id, the way `AppShell` keeps its per-pane refs, and this
 * store carries only the fact that a session is live.
 *
 * Which is also why `endedAt` is the source of truth for "is this running":
 * one nullable number, set once when the process dies, that persistence can
 * reason about without knowing anything about terminals.
 */

interface ClaudeStore {
  projects: ClaudeProject[];
  activeProjectId: string | null;
  /** Which conversation each project is showing, by project id. */
  activeConversation: Record<string, string>;

  activeProject: () => ClaudeProject | null;
  project: (id: string) => ClaudeProject | null;

  /** Creates a project and makes it current. Returns it. */
  createProject: (root: string, extraDirs: string[], options?: Partial<ClaudeProject>) => ClaudeProject;
  /**
   * Which project is on screen. `null` is legitimate and means none is open —
   * the window can have an empty working set while the project list is full.
   */
  switchProject: (id: string | null) => void;
  forgetProject: (id: string) => void;
  togglePinned: (id: string) => void;

  /** Appends a folder. There is no removal — see `docs/CLAUDE-CODE.md`. */
  addFolder: (projectId: string, folder: string) => void;

  startConversation: (projectId: string, conversation: Conversation) => void;
  endConversation: (projectId: string, sessionId: string) => void;
  /** A conversation being resumed: it has a process again. */
  restartConversation: (projectId: string, sessionId: string) => void;
  setConversationTitle: (projectId: string, sessionId: string, title: string) => void;
  /** A folder granted to a running conversation via `/add-dir`. */
  grantFolder: (projectId: string, sessionId: string, folder: string) => void;
  selectConversation: (projectId: string, sessionId: string) => void;
  forgetConversation: (projectId: string, sessionId: string) => void;

  /** Every conversation with a live pty, across every project. */
  liveConversations: () => { project: ClaudeProject; conversation: Conversation }[];
}

const stored = loadClaudeSession();

function persist(state: ClaudeStore): void {
  saveClaudeSession({
    projects: state.projects,
    activeProjectId: state.activeProjectId,
  });
}

/** Replaces one project, leaving the rest alone. */
function withProject(
  projects: ClaudeProject[],
  id: string,
  change: (project: ClaudeProject) => ClaudeProject
): ClaudeProject[] {
  return projects.map((project) => (project.id === id ? change(project) : project));
}

function withConversation(
  project: ClaudeProject,
  sessionId: string,
  change: (conversation: Conversation) => Conversation
): ClaudeProject {
  return {
    ...project,
    conversations: project.conversations.map((conversation) =>
      conversation.sessionId === sessionId ? change(conversation) : conversation
    ),
  };
}

export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  projects: stored.projects,
  activeProjectId: stored.activeProjectId,
  activeConversation: {},

  activeProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((project) => project.id === activeProjectId) ?? null;
  },

  project: (id) => get().projects.find((project) => project.id === id) ?? null,

  createProject: (root, extraDirs, options) => {
    const now = Date.now();
    const project: ClaudeProject = {
      id: crypto.randomUUID(),
      root: normalizeFolder(root),
      // Folders that the primary folder already covers are dropped rather than
      // stored: a chip that grants nothing is a chip that misleads.
      extraDirs: Array.from(
        new Set(extraDirs.map(normalizeFolder).filter(Boolean))
      ).filter((dir) => dir !== normalizeFolder(root)),
      conversations: [],
      createdAt: now,
      lastUsedAt: now,
      ...options,
    };

    set((state) => ({ projects: [project, ...state.projects], activeProjectId: project.id }));
    persist(get());
    return project;
  },

  switchProject: (id) => {
    set((state) => ({
      activeProjectId: id,
      projects: id
        ? withProject(state.projects, id, (project) => ({
            ...project,
            lastUsedAt: Date.now(),
          }))
        : state.projects,
    }));
    persist(get());
  },

  forgetProject: (id) => {
    set((state) => {
      const projects = state.projects.filter((project) => project.id !== id);
      // Its selected conversation goes with it, or a project created later
      // could inherit a selection pointing at a conversation that no longer
      // belongs to anything.
      const activeConversation = { ...state.activeConversation };
      delete activeConversation[id];

      return {
        projects,
        activeConversation,
        activeProjectId:
          state.activeProjectId === id ? projects[0]?.id ?? null : state.activeProjectId,
      };
    });
    persist(get());
  },

  togglePinned: (id) => {
    set((state) => ({
      projects: withProject(state.projects, id, (project) => ({
        ...project,
        pinned: !project.pinned,
      })),
    }));
    persist(get());
  },

  addFolder: (projectId, folder) => {
    const project = get().project(projectId);
    if (!project || alreadyCovered(project, folder)) return;

    set((state) => ({
      projects: withProject(state.projects, projectId, (current) => ({
        ...current,
        extraDirs: [...current.extraDirs, normalizeFolder(folder)],
      })),
    }));
    persist(get());
  },

  startConversation: (projectId, conversation) => {
    set((state) => ({
      projects: withProject(state.projects, projectId, (project) => ({
        ...project,
        lastUsedAt: Date.now(),
        conversations: [...project.conversations, conversation],
      })),
      activeConversation: { ...state.activeConversation, [projectId]: conversation.sessionId },
    }));
    persist(get());
  },

  endConversation: (projectId, sessionId) => {
    set((state) => ({
      projects: withProject(state.projects, projectId, (project) =>
        withConversation(project, sessionId, (conversation) => ({
          ...conversation,
          // Only the first death counts: a process that exits and is then
          // closed must not have its end time rewritten.
          endedAt: conversation.endedAt ?? Date.now(),
        }))
      ),
    }));
    persist(get());
  },

  restartConversation: (projectId, sessionId) => {
    set((state) => ({
      projects: withProject(state.projects, projectId, (project) =>
        withConversation(project, sessionId, (conversation) => ({
          ...conversation,
          endedAt: null,
        }))
      ),
    }));
    persist(get());
  },

  setConversationTitle: (projectId, sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) => ({
      projects: withProject(state.projects, projectId, (project) =>
        withConversation(project, sessionId, (conversation) => ({
          ...conversation,
          title: trimmed,
        }))
      ),
    }));
    persist(get());
  },

  grantFolder: (projectId, sessionId, folder) => {
    const normalized = normalizeFolder(folder);
    set((state) => ({
      projects: withProject(state.projects, projectId, (project) =>
        withConversation(project, sessionId, (conversation) =>
          conversation.launchedWith.extraDirs.includes(normalized)
            ? conversation
            : {
                ...conversation,
                launchedWith: {
                  ...conversation.launchedWith,
                  extraDirs: [...conversation.launchedWith.extraDirs, normalized],
                },
              }
        )
      ),
    }));
    persist(get());
  },

  selectConversation: (projectId, sessionId) => {
    set((state) => ({
      activeConversation: { ...state.activeConversation, [projectId]: sessionId },
    }));
  },

  forgetConversation: (projectId, sessionId) => {
    set((state) => {
      const projects = withProject(state.projects, projectId, (project) => ({
        ...project,
        conversations: project.conversations.filter(
          (conversation) => conversation.sessionId !== sessionId
        ),
      }));

      const active = { ...state.activeConversation };
      if (active[projectId] === sessionId) {
        const project = projects.find((p) => p.id === projectId);
        const survivor = project?.conversations[project.conversations.length - 1];
        if (survivor) active[projectId] = survivor.sessionId;
        else delete active[projectId];
      }

      return { projects, activeConversation: active };
    });
    persist(get());
  },

  liveConversations: () =>
    get().projects.flatMap((project) =>
      project.conversations
        .filter((conversation) => conversation.endedAt === null)
        .map((conversation) => ({ project, conversation }))
    ),
}));
