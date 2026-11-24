/**
 * Which folder Figy Code is pointed at.
 *
 * `ProjectPicker`'s shape, deliberately — a filterable list, the current row
 * checked, a way to forget one, and a primary action at the bottom that opens
 * the real folder dialog. It is a separate component because its rows carry
 * different things: there are no conversations to count, and half the list is
 * a *suggestion* — a folder the terminal has been in — rather than a project
 * anyone has opened here.
 *
 * Suggestions are marked rather than merged. "You have worked in this folder"
 * and "you pointed Figy Code at this folder" are different claims, and a list
 * that made them look alike would quietly grow to thirty rows of noise.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { Check, Clock, FolderOpen, Search, Trash2, X } from "lucide-react";
import { collapseHome } from "../../services/recent-dirs";
import { scrollIntoViewWithin } from "../../services/scroll";
import {
  filterRows,
  pickerRows,
  projectLabel,
  type FigyProject,
} from "../../services/figycode-projects";

interface FigyProjectsProps {
  projects: FigyProject[];
  /** Folders the terminal has been in, most recent first. */
  recent: string[];
  /** The focused pane's working directory — the likeliest answer. */
  cwd?: string;
  activeRoot: string | null;
  onOpen: (root: string) => void;
  onForget: (root: string) => void;
  onClose: () => void;
}

export function FigyProjects({
  projects,
  recent,
  cwd,
  activeRoot,
  onOpen,
  onForget,
  onClose,
}: FigyProjectsProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => filterRows(pickerRows(projects, recent, cwd), filter),
    [cwd, filter, projects, recent]
  );

  useEffect(() => setSelected(0), [filter]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`);
    scrollIntoViewWithin(listRef.current, row);
  }, [selected]);

  const choose = (root: string) => {
    onOpen(root);
    onClose();
  };

  /** The OS dialog, which is the only way to reach a folder nothing knows. */
  const browse = async () => {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      defaultPath: activeRoot ?? cwd ?? undefined,
    });
    if (typeof picked !== "string") return;
    choose(picked);
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
        if (rows[selected]) choose(rows[selected].root);
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
        aria-label="FigyCode projects"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-workspace-header flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <span className="editor-dialog-title text-[13px] font-semibold flex-1">Project</span>
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
            placeholder="Filter folders…"
            spellCheck={false}
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
          {rows.map((row, index) => {
            const isCurrent = row.root === activeRoot;
            return (
              <div
                key={row.root}
                data-row={index}
                className={`editor-workspace-item group flex items-center gap-2.5 px-3.5 py-2 ${
                  index === selected ? "selected" : ""
                } ${isCurrent ? "current" : ""}`}
                onMouseEnter={() => setSelected(index)}
              >
                <button
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  onClick={() => choose(row.root)}
                  title={row.root}
                >
                  <span className="w-3.5 shrink-0 flex items-center">
                    {isCurrent && <Check size={12} className="editor-workspace-check" />}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[12px] truncate flex items-center gap-1.5">
                      {projectLabel(row.root)}
                      {/* A suggestion says so once, quietly, and only here. */}
                      {!row.known && (
                        <span className="figy-suggestion" title="A folder the terminal has been in">
                          <Clock size={9} />
                          recent
                        </span>
                      )}
                    </span>
                    <span className="editor-workspace-path text-[10px] truncate">
                      {collapseHome(row.root)}
                    </span>
                  </span>
                </button>

                {row.known && !isCurrent && (
                  <button
                    className="editor-workspace-remove p-1 rounded shrink-0"
                    onClick={() => onForget(row.root)}
                    title="Forget this folder — nothing on disk is touched"
                    aria-label={`Forget ${projectLabel(row.root)}`}
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
              {filter.trim() ? "No folders match that." : "No folders yet — browse for one."}
            </div>
          )}
        </div>

        <div className="editor-workspace-footer flex items-center gap-2 px-3.5 py-2.5 shrink-0">
          <button
            className="editor-dialog-btn primary flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium"
            onClick={() => void browse()}
          >
            <FolderOpen size={12} />
            Browse…
          </button>
          <div className="flex-1" />
          <span className="editor-workspace-hint text-[10px]">
            ↑↓ to choose · ↵ to open
          </span>
        </div>
      </div>
    </div>
  );
}
