/**
 * Where an untitled request goes when it is saved.
 *
 * Saving one used to be silent and arbitrary: ⌘S on a scratch tab dropped it
 * into whichever collection happened to be first, at the root, under a name
 * derived from its URL — and created a collection called "My collection" to do
 * it with if there were none. Nothing asked, nothing said. A request you had
 * been working on for ten minutes went somewhere you had not chosen and would
 * have to go and find.
 *
 * So the first save asks the two questions that have no default worth guessing:
 * what it is called, and where it lives. Every save after that is silent again,
 * because by then both answers are known.
 *
 * Only for a request with no home yet. A saved one has a place, and asking
 * again every time would make ⌘S a dialog rather than a save.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Layers } from "lucide-react";
import { ApiCollection, ApiItem } from "../../types/api";
import { byRank } from "../../services/api/rank";

/** One place a request can be put. */
interface Destination {
  collectionId: string;
  /** The folder inside it, or null for the collection's own root. */
  parentId: string | null;
  name: string;
  /** How deep to indent it: 0 for a collection, 1+ for its folders. */
  depth: number;
}

interface SaveRequestDialogProps {
  /** Derived from the URL, and usually right — offered, not imposed. */
  suggestedName: string;
  collections: ApiCollection[];
  items: ApiItem[];
  onSave: (params: { name: string; collectionId: string; parentId: string | null }) => void;
  /** Makes a collection to save into, for a workspace with none. */
  onNewCollection: () => Promise<string | null>;
  onClose: () => void;
}

/**
 * Every collection and folder, flattened, parents before children.
 *
 * Folders only: a request cannot hold another request, so offering one as a
 * destination would be offering somewhere it cannot go.
 */
function destinations(collections: ApiCollection[], items: ApiItem[]): Destination[] {
  const rows: Destination[] = [];

  // Sorted the way the sidebar sorts, so the list here and the tree over
  // there name the same place in the same order. A fractional rank is what
  // decides it; see `rank.ts`.
  const folders = (collectionId: string, parentId: string | null, depth: number) => {
    const children = items
      .filter(
        (item) =>
          item.kind === "folder" &&
          item.collectionId === collectionId &&
          (item.parentId ?? null) === parentId
      )
      .sort(byRank);

    for (const item of children) {
      rows.push({ collectionId, parentId: item.id, name: item.name, depth });
      folders(collectionId, item.id, depth + 1);
    }
  };

  for (const collection of [...collections].sort(byRank)) {
    rows.push({
      collectionId: collection.id,
      parentId: null,
      name: collection.name,
      depth: 0,
    });
    folders(collection.id, null, 1);
  }

  return rows;
}

const key = (row: Destination) => `${row.collectionId}:${row.parentId ?? ""}`;

export function SaveRequestDialog({
  suggestedName,
  collections,
  items,
  onSave,
  onNewCollection,
  onClose,
}: SaveRequestDialogProps) {
  const [name, setName] = useState(suggestedName);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => destinations(collections, items), [collections, items]);

  /*
    The first collection's root, to begin with.

    A dialog that opens with nothing chosen makes Save a disabled button and
    the choice compulsory, when in practice most workspaces have one collection
    and the answer is obvious. Pre-selecting keeps the question askable without
    making it an obstacle.
  */
  const [chosen, setChosen] = useState<string | null>(rows[0] ? key(rows[0]) : null);

  useEffect(() => {
    const input = nameRef.current;
    if (!input) return;
    input.focus();
    // Selected, because the suggested name is a guess from the URL and the
    // commonest edit is to replace it outright.
    input.select();
  }, []);

  // A collection made from in here becomes the choice, since making one is
  // only ever a way of answering the question on screen.
  useEffect(() => {
    if (chosen === null && rows[0]) setChosen(key(rows[0]));
  }, [rows, chosen]);

  const trimmed = name.trim();
  const target = rows.find((row) => key(row) === chosen);
  const ready = trimmed !== "" && target !== undefined;

  const confirm = () => {
    if (!ready || !target) return;
    onSave({
      name: trimmed,
      collectionId: target.collectionId,
      parentId: target.parentId,
    });
    onClose();
  };

  const addCollection = async () => {
    setCreating(true);
    try {
      const id = await onNewCollection();
      if (id) setChosen(`${id}:`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="api-dialog-scrim"
      onClick={onClose}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="api-dialog"
        style={{ width: 440 }}
        role="dialog"
        aria-modal="true"
        aria-label="Save request"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter") {
            event.preventDefault();
            confirm();
          }
          // Nothing below sees these: ⌘S and the tab shortcuts would otherwise
          // fire while a name is being typed.
          event.stopPropagation();
        }}
      >
        <div className="api-dialog-head">
          <span className="api-dialog-title">Save request</span>
        </div>

        <div className="api-dialog-body">
          <label className="api-dialog-row">
            <span className="api-dialog-label">Name</span>
            <input
              ref={nameRef}
              className="api-url flex-1 min-w-0"
              value={name}
              spellCheck={false}
              placeholder="What this request is for"
              onChange={(event) => setName(event.target.value)}
              aria-label="Request name"
            />
          </label>

          <div className="api-dialog-label mt-2 mb-1">Save in</div>

          {rows.length === 0 ? (
            <p className="api-dialog-note">
              There are no collections yet. One is needed to keep a request in.
            </p>
          ) : (
            <div className="api-save-targets" role="radiogroup" aria-label="Save in">
              {rows.map((row) => {
                const id = key(row);
                const on = id === chosen;
                return (
                  <button
                    key={id}
                    className={`api-save-target ${on ? "selected" : ""}`}
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setChosen(id)}
                    onDoubleClick={confirm}
                    title={row.depth === 0 ? "The collection's root" : row.name}
                  >
                    {row.depth === 0 ? (
                      <Layers size={11} className="shrink-0 opacity-70" />
                    ) : (
                      <>
                        <ChevronRight size={10} className="shrink-0 opacity-40" />
                        <Folder size={11} className="shrink-0 opacity-70" />
                      </>
                    )}
                    <span className="truncate">{row.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          <button
            className="api-chip-action mt-2"
            onClick={() => void addCollection()}
            disabled={creating}
          >
            <FolderPlus size={10} />
            {creating ? "Making it…" : "New collection"}
          </button>
        </div>

        <div className="api-dialog-foot">
          <button className="api-button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="api-button" disabled={!ready} onClick={confirm}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
