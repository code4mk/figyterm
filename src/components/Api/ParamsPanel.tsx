/**
 * The query string, as a table.
 *
 * Editing here rewrites the URL, and editing the URL redraws this — there is
 * one copy of the query and it is the one in the bar. A table that kept its own
 * list would be a second answer to "what will be sent", and the two would
 * disagree the moment somebody typed in the URL directly.
 *
 * The values take the variable-aware field, because a query value is where
 * `{{api_key}}` most often lives. The names do not: a parameter is called
 * `page`, and an editor per cell in a table of twenty is twenty editors.
 */

import { Trash2 } from "lucide-react";
import { QueryRow } from "../../services/api/params";
import { Scope } from "../../services/api/template";
import { VariableInput } from "./VariableInput";
import { useBlankRow } from "./useBlankRow";

interface ParamsPanelProps {
  rows: QueryRow[];
  onChange: (rows: QueryRow[]) => void;
  scopes: Scope[];
}

function isBlank(row: QueryRow): boolean {
  return row.key === "" && row.value === "";
}

export function ParamsPanel({ rows, onChange, scopes }: ParamsPanelProps) {
  const blank = useBlankRow();

  // Exactly one empty row at the end, however the list was edited. Its id comes
  // from `useBlankRow` and not from a fresh `randomUUID()` per render: React
  // keys the row off it, and a new one each time remounts the row — which
  // takes the focus out of it mid-word.
  const last = rows[rows.length - 1];
  const shown =
    last && isBlank(last)
      ? rows
      : [...rows, { id: blank.id, key: "", value: "", enabled: true }];

  // The blank row is scaffolding, not a parameter, so it never reaches the URL.
  const commit = (next: QueryRow[]) => {
    // Once it has been typed into it is a real row and keeps the id it was
    // being edited under; the next blank needs a different one.
    if (next.some((row) => row.id === blank.id && !isBlank(row))) blank.renew();
    onChange(next.filter((row) => !isBlank(row)));
  };

  const update = (id: string, patch: Partial<QueryRow>) =>
    commit(
      shown.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              // Typing a value into a bare `?flag` makes it an ordinary pair.
              bare: patch.value !== undefined && patch.value !== "" ? undefined : row.bare,
            }
          : row
      )
    );

  const remove = (id: string) => commit(shown.filter((row) => row.id !== id));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[10px] text-ft-text-muted border-b border-ft-border-subtle">
        <span className="w-4" />
        <span className="flex-1">Key</span>
        <span className="flex-[1.6]">Value</span>
        <span className="w-6" />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {shown.map((row) => (
          <div
            key={row.id}
            className="group flex items-center gap-2 px-3 py-1 border-b border-ft-border-subtle"
          >
            <input
              type="checkbox"
              className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
              checked={row.enabled}
              disabled={isBlank(row)}
              onChange={(e) => update(row.id, { enabled: e.target.checked })}
              aria-label={row.key ? `Send ${row.key}` : "Send this parameter"}
            />
            <input
              className="api-cell flex-1"
              value={row.key}
              spellCheck={false}
              placeholder="key"
              onChange={(e) => update(row.id, { key: e.target.value })}
            />
            <VariableInput
              className="api-cell flex-[1.6]"
              value={row.value}
              scopes={scopes}
              placeholder="value"
              onChange={(value) => update(row.id, { value })}
              ariaLabel={row.key ? `Value of ${row.key}` : "Parameter value"}
            />
            <button
              className="w-6 shrink-0 rounded p-1 text-ft-text-muted opacity-0 group-hover:opacity-100 hover:bg-ft-surface hover:text-ft-error disabled:invisible"
              disabled={isBlank(row)}
              onClick={() => remove(row.id)}
              title="Remove"
              aria-label={`Remove ${row.key || "parameter"}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
