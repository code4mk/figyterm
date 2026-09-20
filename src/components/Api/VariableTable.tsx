/**
 * A table of variables, wherever they are being edited.
 *
 * One component rather than one per scope: a collection's, a folder's and an
 * environment's are the same four things — a tick, a name, a value and a way to
 * remove the row — and three tables that drift apart is three places to fix the
 * next thing anybody notices about them.
 *
 * The trailing blank row is the only way to add one. No "add" button: a table
 * whose last row is always empty is a table you can type into, and the button
 * would be a second way to do the thing the table already does.
 */

import { Trash2 } from "lucide-react";
import { Scope, Variable } from "../../services/api/template";
import { VariableInput } from "./VariableInput";

interface VariableTableProps {
  variables: Variable[];
  onChange: (variables: Variable[]) => void;
  /** The chain in play, so a value built from other variables is coloured and
   * completed here as it is everywhere else. */
  scopes: Scope[];
  /** What the empty state says. The scopes differ enough to be worth saying. */
  hint?: string;
}

function isBlank(row: Variable): boolean {
  return row.key.trim() === "" && row.value.trim() === "";
}

/** Exactly one empty row at the end, however the list was edited. */
function withTrailingBlank(rows: Variable[]): Variable[] {
  const kept = rows.filter((row, index) => !isBlank(row) || index === rows.length - 1);
  const last = kept[kept.length - 1];
  if (!last || !isBlank(last)) kept.push({ key: "", value: "", enabled: true });
  return kept;
}

export function VariableTable({ variables, onChange, scopes, hint }: VariableTableProps) {
  const rows = withTrailingBlank(variables);

  // The blank row is scaffolding, not a variable, so it never reaches the
  // caller — which is what keeps an empty row out of the exported document.
  const commit = (next: Variable[]) =>
    onChange(next.filter((row) => row.key.trim() !== "" || row.value.trim() !== ""));

  const update = (index: number, patch: Partial<Variable>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const remove = (index: number) => commit(rows.filter((_, at) => at !== index));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[10px] text-ft-text-muted border-b border-ft-border-subtle">
        <span className="w-4" />
        <span className="flex-1">Name</span>
        <span className="flex-[1.6]">Value</span>
        <span className="w-6" />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {rows.map((row, index) => (
          <div
            key={index}
            className="group flex items-center gap-2 px-3 py-1 border-b border-ft-border-subtle"
          >
            <input
              type="checkbox"
              className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
              checked={row.enabled}
              disabled={isBlank(row)}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              aria-label={row.key ? `Use ${row.key}` : "Use this variable"}
            />
            <input
              className="api-cell flex-1"
              value={row.key}
              spellCheck={false}
              placeholder="name"
              onChange={(e) => update(index, { key: e.target.value })}
            />
            {/* A variable's value is very often built from other variables —
                `{{protocol}}://{{host}}` is the ordinary way to write a base
                URL, and resolution re-resolves until nothing changes. So this
                cell gets the same field as every other place one can go. */}
            <VariableInput
              className="api-cell flex-[1.6]"
              value={row.value}
              scopes={scopes}
              placeholder="value"
              onChange={(value) => update(index, { value })}
              ariaLabel={row.key ? `Value of ${row.key}` : "Variable value"}
            />
            <button
              className="w-6 shrink-0 rounded p-1 text-ft-text-muted opacity-0 group-hover:opacity-100 hover:bg-ft-surface hover:text-ft-error disabled:invisible"
              disabled={isBlank(row)}
              onClick={() => remove(index)}
              title="Remove"
              aria-label={`Remove ${row.key || "variable"}`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {hint && (
        <div className="px-3 py-2 shrink-0 border-t border-ft-border-subtle text-[10px] leading-relaxed text-ft-text-muted">
          {hint}
        </div>
      )}
    </div>
  );
}
