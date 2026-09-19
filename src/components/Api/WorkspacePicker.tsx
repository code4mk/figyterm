/**
 * Which workspace is open, and how to be in a different one.
 *
 * A workspace is a wall: two of them are two bodies of work that never see
 * each other's collections, environments or history, and sync is scoped to one
 * — so the client at one job and the side project are not one long list with
 * a naming convention holding them apart.
 *
 * At the foot of the rail rather than in a settings screen, because it is the
 * answer to "why can I not find that request", and an answer nobody can see is
 * not one. At the foot rather than the head because it is the thing here that
 * changes least often, and a picker above the tree would put what you touch
 * once a week over what you touch every minute.
 *
 * Switching is a whole reload: every tab closes, because a tab is a request in
 * a collection and a collection belongs to exactly one workspace. The menu
 * says so before it happens.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { ApiWorkspace } from "../../types/api";

interface WorkspacePickerProps {
  workspaces: ApiWorkspace[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (workspace: ApiWorkspace) => void;
  onDelete: (workspace: ApiWorkspace) => void;
}

export function WorkspacePicker({
  workspaces,
  activeId,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: WorkspacePickerProps) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = workspaces.find((entry) => entry.id === activeId) ?? workspaces[0] ?? null;

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    /*
      Opened upwards when there is no room below, which at the foot of the
      sidebar is always. Measured rather than assumed: the picker is at the
      bottom now, but a menu that only ever opens one way is a menu that will
      be wrong the next time something moves.
    */
    const height = Math.min(workspaces.length * 32 + 110, 360);
    const below = window.innerHeight - rect.bottom - 8;
    setBox({
      top: below < height ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 220),
    });
  }, [open, workspaces.length]);

  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    // Captured: the panes around this stop their own pointer events, and a
    // bubbling listener would never hear the click meant to dismiss it.
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!active) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`api-workspace ${open ? "open" : ""}`}
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Workspace: ${active.name}`}
      >
        {/* The initial, as a tile. A row of workspaces all beginning "Reso"
            is told apart by name; the tile is what makes the *current* one
            recognisable at a glance from across the window. */}
        <span className="api-workspace-mark">{initial(active.name)}</span>
        <span className="api-workspace-name">{active.name}</span>
        <ChevronDown size={12} className="api-workspace-caret" />
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            className="api-picker-menu api-workspace-menu"
            style={{ top: box.top, left: box.left, minWidth: box.width }}
            role="menu"
          >
            <div className="api-workspace-heading">Workspaces</div>

            {workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className={`api-workspace-row ${workspace.id === active.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={workspace.id === active.id}
                  className="api-workspace-open"
                  onClick={() => {
                    setOpen(false);
                    if (workspace.id !== active.id) onOpen(workspace.id);
                  }}
                >
                  <span className="api-workspace-mark small">{initial(workspace.name)}</span>
                  <span className="api-workspace-label">{workspace.name}</span>
                  {workspace.id === active.id && (
                    <Check size={12} className="api-workspace-tick" />
                  )}
                </button>

                {/* Shown on hover, so a list of workspaces is a list rather
                    than a column of buttons. */}
                <span className="api-workspace-tools">
                  <button
                    type="button"
                    className="api-workspace-tool"
                    onClick={() => {
                      setOpen(false);
                      onRename(workspace);
                    }}
                    title={`Rename ${workspace.name}`}
                    aria-label={`Rename ${workspace.name}`}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    className="api-workspace-tool danger"
                    // The last one cannot go: a window with no workspace has
                    // nowhere to put the collection somebody makes next.
                    disabled={workspaces.length <= 1}
                    onClick={() => {
                      setOpen(false);
                      onDelete(workspace);
                    }}
                    title={
                      workspaces.length <= 1
                        ? "The only workspace cannot be deleted"
                        : `Delete ${workspace.name}`
                    }
                    aria-label={`Delete ${workspace.name}`}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>
            ))}

            <div className="api-menu-rule" />

            <button
              type="button"
              role="menuitem"
              className="api-picker-item"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <Plus size={12} />
              <span className="api-picker-item-label">New workspace…</span>
            </button>

            <p className="api-workspace-note">
              Switching closes the open tabs. Collections, environments and history
              belong to one workspace and stay in it.
            </p>
          </div>,
          document.body
        )}
    </>
  );
}

/** The first letter that is one, so an emoji or a bracket does not become the
 * tile. Falls back to a dot rather than an empty square. */
function initial(name: string): string {
  const letter = Array.from(name).find((character) => /\p{L}|\p{N}/u.test(character));
  return (letter ?? "·").toUpperCase();
}
