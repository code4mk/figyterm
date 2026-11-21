import { ChevronRight, FolderOpen, History, Plus, X } from "lucide-react";
import { ClaudeProject, Conversation, conversationTitle, projectName } from "../../services/claude-project";
import { PastConversation } from "../../services/claude";
import { collapseHome } from "../../services/recent-dirs";
import { HistoryList } from "./HistoryPicker";

/**
 * The navigator: every project on the bench, and the conversations under it.
 *
 * This is the window's answer to "where am I, and what else is running", and it
 * replaced three separate answers. The first build put the current project in a
 * dropdown on the title bar, its conversations in a pill rail underneath, and
 * the folder's earlier conversations behind a toolbar button — so the one fact
 * the feature exists to show, *several projects alive at once*, was the one
 * thing no screen showed. You could only ever see the conversations of the
 * project you were already looking at, and a second project's work was a number
 * in a dropdown you had to open.
 *
 * A tree says it in one glance, and costs the terminal 236 pixels it can spare.
 *
 * Nothing here holds state. Which projects are expanded, which conversation is
 * current and what happens on a click all belong to `ClaudeModal`, which owns
 * the ptys — this draws what it is handed and reports clicks back.
 */

interface ClaudeNavigatorProps {
  width: number;
  /** The bench: projects open right now, in the order they were opened. */
  workingProjects: ClaudeProject[];
  /** Every project ever made, for the bench's empty state. Pinned first. */
  recentProjects: ClaudeProject[];
  activeProjectId: string | null;
  /** Which conversation each project is showing, by project id. */
  activeConversation: Record<string, string>;
  /** Live conversation counts, by project id. */
  liveCounts: Record<string, number>;
  /** Conversations that have rung the bell since they were last looked at. */
  attention: Record<string, true>;
  /** Whether a conversation has a process behind it right now. */
  isLive: (conversation: Conversation) => boolean;
  /** Which projects are showing their conversations. The active one always is. */
  expanded: Record<string, boolean>;
  onToggleExpanded: (id: string) => void;

  /** Whether the project section is expanded at all. */
  benchOpen: boolean;
  onToggleBench: () => void;

  /** The active folder's conversations on disk that this project doesn't track. */
  history: PastConversation[] | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onAdopt: (sessionId: string, title: string | null) => void;

  onOpenProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onNewProject: () => void;
  onAllProjects: () => void;
  onShowConversation: (project: ClaudeProject, conversation: Conversation) => void;
  onCloseConversation: (project: ClaudeProject, conversation: Conversation) => void;
  onNewConversation: (project: ClaudeProject) => void;
}

export function ClaudeNavigator({
  width,
  workingProjects,
  recentProjects,
  activeProjectId,
  activeConversation,
  liveCounts,
  attention,
  isLive,
  expanded,
  onToggleExpanded,
  benchOpen,
  onToggleBench,
  history,
  historyOpen,
  onToggleHistory,
  onAdopt,
  onOpenProject,
  onCloseProject,
  onNewProject,
  onAllProjects,
  onShowConversation,
  onCloseConversation,
  onNewConversation,
}: ClaudeNavigatorProps) {
  const empty = workingProjects.length === 0;
  /** What the header counts when it is collapsed: whichever list it holds. */
  const rowCount = empty ? recentProjects.length : workingProjects.length;

  return (
    <nav
      className="claude-nav flex flex-col shrink-0 min-h-0"
      style={{ width }}
      aria-label="Projects and conversations"
    >
      {/*
        The section header, and the control that puts the section away.

        A heading you can collapse is the convention every sidebar with more
        than one list in it uses, and this one earns it for a reason of its own:
        the bench grows. Four projects with their conversations open is a column
        you scroll, and sometimes the only thing you want from it is the footer
        and the width.

        Collapsed, the header keeps the count — a section that hides what it
        holds should at least say how much that is.
      */}
      <div className="claude-nav-head flex items-center shrink-0">
        <button
          className="claude-nav-head-toggle flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={onToggleBench}
          aria-expanded={benchOpen}
          title={benchOpen ? "Hide the list" : "Show the list"}
        >
          <ChevronRight
            size={10}
            className={`claude-nav-head-caret shrink-0 ${benchOpen ? "open" : ""}`}
          />
          <span className="claude-nav-heading truncate">
            {empty ? "Recent" : "Working on"}
          </span>
          {!benchOpen && rowCount > 0 && (
            <span className="claude-nav-count shrink-0">{rowCount}</span>
          )}
        </button>
        <button
          className="claude-iconbtn sm"
          onClick={onNewProject}
          title="New project…"
          aria-label="New project"
        >
          <Plus size={12} />
        </button>
      </div>

      {/*
        Collapsed, the list is gone but the footer still belongs at the bottom
        of the column — so something has to hold the space it was taking.
      */}
      {!benchOpen && <div className="flex-1" />}

      {/*
        Plain buttons, deliberately.

        The obvious markup for this is `role="tree"`, and it would be a lie:
        ARIA's tree contract is a single tab stop with arrow keys moving a
        roving focus between items, and this column doesn't do that. The rail
        it replaced made the same promise in miniature — `role="tab"` on rows
        with no `tablist` around them — which is a structure a screen reader
        announces and then cannot navigate.

        A labelled `nav` of ordinary buttons is what this actually is. Every row
        is a real tab stop, `aria-current` says which project and which
        conversation you are in, and `aria-expanded` is on the control that
        expands. Nothing is claimed that the keyboard cannot deliver.
      */}
      {benchOpen && (
        <div className="claude-nav-scroll flex-1 min-h-0 overflow-y-auto">
          {/*
            Nothing on the bench, so the sidebar offers the thing that would put
            something on it. The projects you already have, rather than a line of
            text telling you the list is empty — the next click is the same either
            way, and this one saves a modal.
          */}
          {empty && recentProjects.length === 0 && (
            <div className="claude-nav-note">No projects yet.</div>
          )}

          {empty &&
            recentProjects.map((project) => (
              <button
                key={project.id}
                className="claude-proj-main recent flex items-center gap-2 w-full text-left"
                onClick={() => onOpenProject(project.id)}
                title={project.root}
              >
                <FolderOpen size={11} className="claude-proj-icon shrink-0" />
                <span className="flex flex-col min-w-0 flex-1 gap-px">
                  <span className="claude-proj-name truncate">{projectName(project)}</span>
                  <span className="claude-proj-path truncate">{collapseHome(project.root)}</span>
                </span>
              </button>
            ))}

          {workingProjects.map((project) => {
            const isActive = project.id === activeProjectId;
            // The project you are in always shows its conversations: collapsing
            // the one on screen would hide the row that says which it is.
            const open = isActive || expanded[project.id] === true;
            const live = liveCounts[project.id] ?? 0;
            const currentSessionId = activeConversation[project.id] ?? null;

            return (
              <div key={project.id} className="claude-nav-group">
                <div className={`claude-proj group flex items-center ${isActive ? "active" : ""}`}>
                  <button
                    className={`claude-proj-twisty shrink-0 ${open ? "open" : ""}`}
                    onClick={() => onToggleExpanded(project.id)}
                    // The active project's twisty is held open rather than
                    // removed: a row that loses its control when selected makes
                    // the whole column jump by 14px on every switch.
                    disabled={isActive}
                    title={open ? "Hide conversations" : "Show conversations"}
                    aria-label={`${open ? "Hide" : "Show"} conversations in ${projectName(
                      project
                    )}`}
                    aria-expanded={open}
                  >
                    <ChevronRight size={11} />
                  </button>

                  <button
                    className="claude-proj-main flex items-center gap-2 flex-1 min-w-0 text-left"
                    onClick={() => onOpenProject(project.id)}
                    title={project.root}
                    aria-current={isActive}
                  >
                    <span className="flex flex-col min-w-0 flex-1 gap-px">
                      <span className="claude-proj-name truncate">{projectName(project)}</span>
                      <span className="claude-proj-path truncate">
                        {collapseHome(project.root)}
                      </span>
                    </span>
                  </button>

                  {live > 0 && (
                    <span
                      className="claude-live-count shrink-0"
                      title={`${live} running ${live === 1 ? "conversation" : "conversations"}`}
                    >
                      <span className="claude-dot live" />
                      {live}
                    </span>
                  )}

                  {/*
                    Closes the project — takes it off the bench and keeps it. Not
                    a delete: it stays in Projects with its folders and history.
                  */}
                  <button
                    className="claude-proj-close shrink-0"
                    onClick={() => onCloseProject(project.id)}
                    title={
                      live > 0
                        ? `Close — stops ${live} running ${
                            live === 1 ? "conversation" : "conversations"
                          }. The project is kept.`
                        : "Close — the project is kept in Projects"
                    }
                    aria-label={`Close ${projectName(project)}`}
                  >
                    <X size={11} />
                  </button>
                </div>

                {open && (
                  <div className="claude-nav-children">
                    {project.conversations.map((conversation, index) => {
                      const current = conversation.sessionId === currentSessionId && isActive;
                      const running = isLive(conversation);
                      const wants = attention[conversation.sessionId] === true;
                      return (
                        <div
                          key={conversation.sessionId}
                          className={`claude-conv group flex items-center ${
                            current ? "active" : ""
                          }`}
                        >
                          <button
                            className="claude-conv-main flex items-center gap-2 flex-1 min-w-0 text-left"
                            onClick={() => onShowConversation(project, conversation)}
                            aria-current={current}
                            title={
                              wants
                                ? "Waiting for you"
                                : running
                                  ? "Running"
                                  : "Not running — opening it resumes the conversation"
                            }
                          >
                            <span
                              className={`claude-dot shrink-0 ${running ? "live" : ""} ${
                                wants ? "wants-you" : ""
                              }`}
                            />
                            <span className="claude-conv-title truncate">
                              {conversationTitle(conversation, index)}
                            </span>
                          </button>
                          <button
                            className="claude-conv-close shrink-0"
                            onClick={() => onCloseConversation(project, conversation)}
                            title={running ? "Close — stops this conversation" : "Close"}
                            aria-label="Close conversation"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      );
                    })}

                    <button
                      className="claude-nav-new flex items-center gap-2 w-full text-left"
                      onClick={() => onNewConversation(project)}
                      title={isActive ? "New conversation (⌘T)" : "New conversation"}
                    >
                      <Plus size={11} className="shrink-0" />
                      <span className="truncate">New conversation</span>
                    </button>

                    {/*
                      The folder's own history, under the project it belongs to.

                      Only for the project on screen: reading a directory is an
                      IPC round trip per project, and "what was I doing here last
                      time" is a question about where you are. Collapsed by
                      default — it is the deepest thing in the tree and the least
                      often wanted.
                    */}
                    {isActive && (
                      <>
                        <button
                          className="claude-nav-section flex items-center gap-1.5 w-full text-left"
                          onClick={onToggleHistory}
                          aria-expanded={historyOpen}
                          title="Conversations already in this folder that this project doesn’t list"
                        >
                          <ChevronRight
                            size={10}
                            className={`claude-nav-section-caret shrink-0 ${
                              historyOpen ? "open" : ""
                            }`}
                          />
                          <History size={10} className="shrink-0" />
                          <span className="flex-1 truncate">Earlier</span>
                          {history !== null && history.length > 0 && (
                            <span className="claude-nav-count shrink-0">{history.length}</span>
                          )}
                        </button>
                        {historyOpen && (
                          <HistoryList
                            compact
                            rows={history}
                            onPick={onAdopt}
                            emptyLabel="Nothing earlier in this folder."
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        className="claude-nav-foot flex items-center gap-2 shrink-0 w-full text-left"
        onClick={onAllProjects}
        title="All projects (⌘P)"
      >
        <FolderOpen size={11} className="opacity-70 shrink-0" />
        <span className="flex-1 truncate">All projects…</span>
        <span className="claude-kbd shrink-0">⌘P</span>
      </button>
    </nav>
  );
}
