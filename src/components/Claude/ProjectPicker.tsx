import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderPlus, Search, Star, Trash2, X } from "lucide-react";
import { ClaudeProject, projectName } from "../../services/claude-project";
import { collapseHome } from "../../services/recent-dirs";
import { scrollIntoViewWithin } from "../../services/scroll";

/**
 * Which project the window is showing.
 *
 * `WorkspacePicker`'s shape, deliberately — a filterable list with pins, the
 * current row checked, and a way to forget one. It is not the same component
 * because the rows carry different things (live conversations rather than open
 * tabs) and because the editor's picker is inside the lazily-loaded editor
 * bundle, which this must not pull in.
 *
 * Each row is a folder name over its path, which is what makes a project with
 * no name of its own legible: two checkouts of one repository are both called
 * `api`, and the line underneath is how you tell them apart.
 */

interface ProjectPickerProps {
  projects: ClaudeProject[];
  activeProjectId: string | null;
  /** Live conversation counts, by project id. */
  liveCounts: Record<string, number>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onForget: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onClose: () => void;
}

export function ProjectPicker({
  projects,
  activeProjectId,
  liveCounts,
  onOpen,
  onNew,
  onForget,
  onTogglePinned,
  onClose,
}: ProjectPickerProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const ordered = [...projects].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastUsedAt - a.lastUsedAt
    );
    const query = filter.trim().toLowerCase();
    if (!query) return ordered;
    // Matched against the whole path, not just the folder name: `src/api` and
    // `web/api` are told apart by what is in front of them.
    return ordered.filter((project) => project.root.toLowerCase().includes(query));
  }, [projects, filter]);

  useEffect(() => setSelected(0), [filter]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`);
    scrollIntoViewWithin(listRef.current, row);
  }, [selected]);

  const choose = (project: ClaudeProject) => {
    if (project.id !== activeProjectId) onOpen(project.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (rows[selected]) choose(rows[selected]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      className="editor-dialog-backdrop absolute inset-0 z-[20] flex items-start justify-center pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div
        className="editor-workspace-modal w-[520px] max-w-[92vw] max-h-[70vh] rounded-xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Claude projects"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-workspace-header flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <span className="editor-dialog-title text-[13px] font-semibold flex-1">Projects</span>
          <button
            className="editor-icon-btn p-1 rounded"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="editor-workspace-search flex items-center gap-2 px-3.5 py-2 shrink-0">
          <Search size={12} className="editor-palette-icon shrink-0" />
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onPaste={(e) => e.stopPropagation()}
            placeholder="Filter projects…"
            spellCheck={false}
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
          {rows.map((project, index) => {
            const live = liveCounts[project.id] ?? 0;
            const isCurrent = project.id === activeProjectId;
            return (
              <div
                key={project.id}
                data-row={index}
                className={`editor-workspace-item group flex items-center gap-2.5 px-3.5 py-2 ${
                  index === selected ? "selected" : ""
                } ${isCurrent ? "current" : ""}`}
                onMouseEnter={() => setSelected(index)}
              >
                <button
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  onClick={() => choose(project)}
                  title={project.root}
                >
                  <span className="w-3.5 shrink-0 flex items-center">
                    {isCurrent && <Check size={12} className="editor-workspace-check" />}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[12px] truncate">{projectName(project)}</span>
                    <span className="editor-workspace-path text-[10px] truncate">
                      {collapseHome(project.root)}
                    </span>
                  </span>
                </button>

                {live > 0 && (
                  <span
                    className="claude-live-count text-[10px] shrink-0"
                    title={`${live} running ${live === 1 ? "conversation" : "conversations"}`}
                  >
                    <span className="claude-dot live" /> {live}
                  </span>
                )}

                <button
                  className={`editor-workspace-star p-1 rounded shrink-0 ${
                    project.pinned ? "on" : ""
                  }`}
                  onClick={() => onTogglePinned(project.id)}
                  title={project.pinned ? "Unpin" : "Pin to the top"}
                  aria-pressed={project.pinned}
                >
                  <Star size={12} className={project.pinned ? "fill-current" : ""} />
                </button>

                {/*
                  Forgetting is the permanent one, and the only one on this
                  list: the project record goes, and with it the folder set and
                  the conversations FigyTerm was tracking. The folders and every
                  transcript stay on disk, so the work survives — but the
                  project as a thing you can reopen does not.
                  *Closing* a project is the other action entirely, and lives in
                  the Working-on menu.

                  A running conversation is the one thing that protects a
                  project here: forgetting one whose process is still alive
                  would leave a pty nothing can reach.
                */}
                {live === 0 && (
                  <button
                    className="editor-workspace-remove p-1 rounded shrink-0"
                    onClick={() => onForget(project.id)}
                    title="Forget this project for good — the folders and transcripts are not touched"
                    aria-label={`Forget ${projectName(project)}`}
                  >
                    <Trash2 size={12} />
                    <span className="editor-workspace-remove-label text-[10px]">Forget</span>
                  </button>
                )}
              </div>
            );
          })}

          {rows.length === 0 && (
            <div className="editor-workspace-empty px-3.5 py-6 text-center text-[11px]">
              {filter.trim() ? "No projects match that." : "No projects yet."}
            </div>
          )}
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <button
            className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={() => {
              onNew();
              onClose();
            }}
          >
            <FolderPlus size={12} />
            New project…
          </button>
          <div className="flex-1" />
          <span className="editor-workspace-hint text-[10px]">
            Opening one adds it to Working on
          </span>
        </div>
      </div>
    </div>
  );
}
