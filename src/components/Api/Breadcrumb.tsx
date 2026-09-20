/**
 * Where the open request lives, above the URL bar.
 *
 * A request called `token` means nothing on its own — three collections have
 * one — and the tab strip has room for the name and nothing else. The trail
 * says *which* `token`, and every step but the last is somewhere to go.
 *
 * The last step is the name itself, and clicking it renames in place. A name
 * is the one thing about a saved request that has nowhere else to be edited —
 * it is not in the URL bar, not on any of the tabs below it — and a dialog for
 * a word is a dialog nobody opens.
 *
 * Nothing is drawn for a request that has not been saved anywhere: it has no
 * trail, and a row of chevrons around the word "Untitled" is furniture.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, Layers } from "lucide-react";
import { Crumb } from "../../services/api/tree";

interface BreadcrumbProps {
  crumbs: Crumb[];
  /** Opens a collection's or a folder's own tab. Not called for the last step,
   * which is the thing already on screen. */
  onOpen: (crumb: Crumb) => void;
  /** Renames the item the trail ends at. Absent where it cannot be renamed. */
  onRename?: (name: string) => void;
}

export function Breadcrumb({ crumbs, onOpen, onRename }: BreadcrumbProps) {
  const last = crumbs[crumbs.length - 1];

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Selected, not just focused: the common rename replaces the name rather
    // than appending to it, and the uncommon one is one arrow key away.
    input.select();
  }, [editing]);

  // A tab switched under the editor, or the item was renamed elsewhere. Either
  // way what is in the box is about a request that is no longer on screen.
  useEffect(() => {
    setEditing(false);
  }, [last?.id]);

  if (crumbs.length === 0 || !last) return null;

  const start = () => {
    if (!onRename) return;
    setText(last.name);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const name = text.trim();
    // An empty name would leave a row nothing can be said about, so it is
    // read as "never mind" rather than applied.
    if (name !== "" && name !== last.name) onRename?.(name);
  };

  return (
    <nav className="api-crumbs" aria-label="Location">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span className="api-crumb-step" key={crumb.id}>
            {index > 0 && <ChevronRight size={11} className="api-crumb-sep" aria-hidden />}

            {isLast ? (
              editing ? (
                <input
                  ref={inputRef}
                  className="api-crumb-input"
                  value={text}
                  spellCheck={false}
                  onChange={(event) => setText(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      // Straight out, without committing: Escape means the
                      // name it had, whatever has been typed over it.
                      setEditing(false);
                    }
                    // Nothing below this gets a look at these keys — ⌘S and
                    // the tab shortcuts would otherwise fire while a name is
                    // being typed.
                    event.stopPropagation();
                  }}
                  aria-label="Request name"
                />
              ) : (
                <button
                  type="button"
                  className={`api-crumb current ${onRename ? "editable" : ""}`}
                  onClick={start}
                  disabled={!onRename}
                  title={onRename ? "Click to rename" : undefined}
                  aria-current="page"
                >
                  {crumb.name || "Untitled"}
                </button>
              )
            ) : (
              <button
                type="button"
                className="api-crumb"
                onClick={() => onOpen(crumb)}
                title={
                  crumb.kind === "collection"
                    ? `Open the collection ${crumb.name}`
                    : `Open the folder ${crumb.name}`
                }
              >
                {crumb.kind === "collection" ? (
                  <Layers size={11} className="api-crumb-icon" aria-hidden />
                ) : (
                  <Folder size={11} className="api-crumb-icon" aria-hidden />
                )}
                <span className="api-crumb-name">{crumb.name || "Untitled"}</span>
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
