/**
 * The request's headers, as a spreadsheet rather than a form.
 *
 * There is no "add row" button: the table always ends in a blank row, and
 * typing into it grows another. That is how every table people already use for
 * this behaves, and it removes the one click that otherwise stands between a
 * thought and a header.
 *
 * A row is kept when it is unticked — that is the whole point of the tick. What
 * is sent is decided in `services/api/request.ts`, which is also where it is
 * tested.
 */

import { Trash2 } from "lucide-react";
import { HeaderRow } from "../../types/api";
import { blankHeader } from "../../services/api/request";
import { Scope } from "../../services/api/template";
import { suggestHeaders } from "../../services/api/headers";
import { SuggestInput } from "./SuggestInput";
import { VariableInput } from "./VariableInput";

interface HeaderTableProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  /** The chain in play, so a `{{value}}` is coloured and completed here too. */
  scopes: Scope[];
}

/** True for the row that exists only to be typed into. */
function isBlank(row: HeaderRow): boolean {
  return row.name === "" && row.value === "";
}

/** Keeps exactly one empty row at the end, however the list was edited. */
function withTrailingBlank(rows: HeaderRow[]): HeaderRow[] {
  const last = rows[rows.length - 1];
  if (last && isBlank(last)) return rows;
  return [...rows, blankHeader(crypto.randomUUID())];
}

export function HeaderTable({ rows, onChange, scopes }: HeaderTableProps) {
  const update = (id: string, patch: Partial<HeaderRow>) => {
    onChange(
      withTrailingBlank(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    );
  };

  const remove = (id: string) => {
    onChange(withTrailingBlank(rows.filter((row) => row.id !== id)));
  };

  return (
    <div className="flex flex-col text-[11px]">
      <div className="flex items-center gap-2 px-3 py-1.5 text-ft-text-muted border-b border-ft-border-subtle">
        <span className="w-4" />
        <span className="flex-1">Name</span>
        <span className="flex-[1.6]">Value</span>
        <span className="w-6" />
      </div>

      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-center gap-2 px-3 py-1 border-b border-ft-border-subtle group"
        >
          <input
            type="checkbox"
            className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
            // The blank row has nothing to enable, and a tick on it reads as a
            // header that exists.
            checked={row.enabled}
            disabled={isBlank(row)}
            onChange={(e) => update(row.id, { enabled: e.target.checked })}
            aria-label={row.name ? `Send ${row.name}` : "Send this header"}
          />
          {/* Suggested, not restricted: the list is the twenty names people
              actually type, and anything else is still typed straight in. */}
          <SuggestInput
            className="api-cell flex-1"
            value={row.name}
            placeholder="Header"
            ariaLabel="Header name"
            title="HEADERS"
            suggestions={suggestHeaders(row.name).map((entry) => ({
              value: entry.name,
              hint: entry.hint,
            }))}
            onChange={(name) => update(row.id, { name })}
          />
          {/* The value takes the variable-aware field; the name does not.
              A header's name is `Authorization`, not `{{Authorization}}` —
              templates there are vanishingly rare, and an editor per cell in
              a table of thirty headers is thirty editors. */}
          <VariableInput
            className="api-cell flex-[1.6]"
            value={row.value}
            scopes={scopes}
            placeholder="Value"
            onChange={(value) => update(row.id, { value })}
            ariaLabel={row.name ? `Value of ${row.name}` : "Header value"}
          />
          <button
            className="w-6 shrink-0 rounded p-1 text-ft-text-muted opacity-0 group-hover:opacity-100 hover:bg-ft-surface hover:text-ft-error disabled:invisible"
            disabled={isBlank(row)}
            onClick={() => remove(row.id)}
            title="Remove header"
            aria-label={`Remove ${row.name || "header"}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
