/**
 * An environment, open as a tab.
 *
 * A tab rather than the sheet this used to be: setting up an environment is
 * something you do *while* looking at the request that needs it, and a modal
 * over the whole window is the one arrangement that makes that impossible.
 *
 * **Two value columns, and the distinction is the point.** The initial value is
 * shared — it exports with the file and syncs to everyone. The current value is
 * this machine's, never written to a file and never pushed. That is what lets a
 * collection ship with `token` = `put-yours-here` while the machine running it
 * holds the real one.
 */

import { useState } from "react";
import { Eye, EyeOff, Globe, Save, Trash2, Variable as VariableIcon } from "lucide-react";
import { EnvDraft } from "../../stores/apiStore";
import { EnvVariable } from "../../services/api/store";
import { Scope } from "../../services/api/template";
import { VariableInput } from "./VariableInput";
import { Select } from "./Select";

interface EnvironmentPaneProps {
  draft: EnvDraft;
  onChange: (patch: Partial<EnvDraft>) => void;
  onSave: () => void;
  dirty: boolean;
  /** Whether this is the environment whose variables are in play. */
  active: boolean;
  onUse: () => void;
  /** Absent on one that has not been created yet. */
  onDelete: (() => void) | null;
  /** The chain in play. An environment value built from another variable —
   * `{{protocol}}://{{host}}` — is ordinary, and resolution re-resolves until
   * nothing changes, so these fields understand them too. */
  scopes: Scope[];
}

function isBlank(row: EnvVariable): boolean {
  return row.key.trim() === "" && row.value === "" && (row.currentValue ?? "") === "";
}

const EMPTY: EnvVariable = {
  key: "",
  value: "",
  currentValue: null,
  enabled: true,
  secret: false,
};

/** Exactly one empty row at the end, however the list was edited. */
function withTrailingBlank(rows: EnvVariable[]): EnvVariable[] {
  const kept = rows.filter((row, index) => !isBlank(row) || index === rows.length - 1);
  const last = kept[kept.length - 1];
  if (!last || !isBlank(last)) kept.push({ ...EMPTY });
  return kept;
}

export function EnvironmentPane({
  draft,
  onChange,
  onSave,
  dirty,
  active,
  onUse,
  onDelete,
  scopes,
}: EnvironmentPaneProps) {
  /** Which secrets have been revealed, by row index. Deliberately not
   * remembered anywhere: revealing one is for the next ten seconds. */
  const [shown, setShown] = useState<Set<number>>(new Set());

  const rows = withTrailingBlank(draft.variables);

  const commit = (next: EnvVariable[]) =>
    onChange({ variables: next.filter((row) => !isBlank(row)) });

  const update = (index: number, patch: Partial<EnvVariable>) =>
    commit(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const remove = (index: number) => {
    setShown(new Set());
    commit(rows.filter((_, at) => at !== index));
  };

  const reveal = (index: number) => {
    const next = new Set(shown);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setShown(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-2 shrink-0 border-b border-ft-border">
        {draft.isGlobal ? (
          <Globe size={14} className="shrink-0 text-ft-text-muted" />
        ) : (
          <VariableIcon size={14} className="shrink-0 text-ft-text-muted" />
        )}

        {draft.isGlobal ? (
          <span className="text-[12px] font-semibold text-ft-text">Globals</span>
        ) : (
          <input
            className="api-url flex-1 min-w-0 max-w-[320px]"
            value={draft.name}
            spellCheck={false}
            placeholder="Environment name"
            onChange={(e) => onChange({ name: e.target.value })}
            aria-label="Environment name"
          />
        )}

        <span className="min-w-0 truncate text-[10px] text-ft-text-muted">
          {draft.isGlobal
            ? "These apply whichever environment is selected."
            : active
              ? "In use — these are the values requests resolve with."
              : "Not in use. Select it to resolve with these."}
        </span>

        <div className="flex-1" />

        {!draft.isGlobal && (
          <button className="api-button-quiet" onClick={onUse}>
            {active ? "Stop using" : "Use this one"}
          </button>
        )}
        {onDelete && (
          <button
            className="api-rail-action danger"
            onClick={onDelete}
            title="Delete this environment"
            aria-label="Delete this environment"
          >
            <Trash2 size={13} />
          </button>
        )}
        <button
          className={`api-icon-button ${dirty ? "text-ft-accent" : "text-ft-text-muted"}`}
          onClick={onSave}
          title="Save (⌘S)"
          aria-label="Save"
        >
          <Save size={13} />
        </button>
      </div>

      {/* The two columns, explained once at the top rather than in a tooltip
          nobody opens. This is the thing about environments people get wrong. */}
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[10px] text-ft-text-muted border-b border-ft-border-subtle">
        <span className="w-4" />
        <span className="flex-1">Name</span>
        <span className="w-16 shrink-0">Type</span>
        <span className="flex-[1.4]" title="Shared: this is what exports and syncs">
          Initial value
        </span>
        <span className="flex-[1.4]" title="This machine only: never exported, never synced">
          Current value
        </span>
        <span className="w-12" />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {rows.map((row, index) => {
          const masked = row.secret && !shown.has(index);
          return (
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
              <Select
                className="w-16 shrink-0"
                value={row.secret ? "secret" : "default"}
                options={[
                  { value: "default", label: "Default", hint: "Shared like any other value" },
                  {
                    value: "secret",
                    label: "Secret",
                    hint: "Masked here, and synced as a name with no value",
                  },
                ]}
                onChange={(kind) => update(index, { secret: kind === "secret" })}
                ariaLabel={row.key ? `Type of ${row.key}` : "Type"}
              />

              {/* A masked value keeps the plain field: the variable-aware one
                  is a CodeMirror, which has no `type="password"` — and a
                  secret shown while being masked would be the one failure this
                  column cannot have. */}
              {masked ? (
                <input
                  className="api-cell flex-[1.4]"
                  value={row.value}
                  spellCheck={false}
                  type="password"
                  placeholder="shared placeholder"
                  onChange={(e) => update(index, { value: e.target.value })}
                  aria-label={row.key ? `Initial value of ${row.key}` : "Initial value"}
                />
              ) : (
                <VariableInput
                  className="api-cell flex-[1.4]"
                  value={row.value}
                  scopes={scopes}
                  placeholder={row.secret ? "shared placeholder" : "value"}
                  onChange={(value) => update(index, { value })}
                  ariaLabel={row.key ? `Initial value of ${row.key}` : "Initial value"}
                />
              )}
              {/* Null and empty are different, and only the field can tell
                  them apart: typing anything makes it a current value, and
                  clearing it back to empty leaves an empty one. Deleting it
                  entirely is what the initial column is for. */}
              {masked ? (
                <input
                  className="api-cell flex-[1.4]"
                  value={row.currentValue ?? ""}
                  spellCheck={false}
                  type="password"
                  placeholder={row.value === "" ? "" : "same as initial"}
                  onChange={(e) =>
                    update(index, { currentValue: e.target.value === "" ? null : e.target.value })
                  }
                  aria-label={row.key ? `Current value of ${row.key}` : "Current value"}
                />
              ) : (
                <VariableInput
                  className="api-cell flex-[1.4]"
                  value={row.currentValue ?? ""}
                  scopes={scopes}
                  placeholder={row.value === "" ? "" : "same as initial"}
                  onChange={(value) =>
                    update(index, { currentValue: value === "" ? null : value })
                  }
                  ariaLabel={row.key ? `Current value of ${row.key}` : "Current value"}
                />
              )}

              <button
                className="w-6 shrink-0 rounded p-1 text-ft-text-muted hover:bg-ft-surface hover:text-ft-text disabled:invisible"
                disabled={!row.secret}
                onClick={() => reveal(index)}
                title={masked ? "Show this value" : "Hide this value"}
                aria-label={masked ? "Show this value" : "Hide this value"}
                aria-pressed={!masked}
              >
                {masked ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
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
          );
        })}
      </div>

      <div className="px-3 py-2 shrink-0 border-t border-ft-border-subtle text-[10px] leading-relaxed text-ft-text-muted">
        Use them anywhere as <code>{"{{name}}"}</code>. The <b>initial value</b> is
        shared — it is what an export writes and what syncing sends. The{" "}
        <b>current value</b> stays on this machine and is what requests actually
        resolve with, so a real token belongs there and never in the first column.
      </div>
    </div>
  );
}
