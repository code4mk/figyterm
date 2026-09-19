/**
 * The environment selector, and a look at what is in it.
 *
 * The selector on its own answers "which one", which is the less useful half of
 * the question. The one people actually have is "what is `{{base_url}}` right
 * now" — and until this, answering it meant leaving the request.
 *
 * Read-only, deliberately: this is a glance, not a form. Editing opens the tab,
 * where there is room to say which column is shared and which is not.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Eye, EyeOff, Pencil } from "lucide-react";
import { ApiEnvironment } from "../../types/api";

interface EnvironmentPeekProps {
  environments: ApiEnvironment[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (id: string) => void;
}

export function EnvironmentPeek({
  environments,
  activeId,
  onSelect,
  onEdit,
}: EnvironmentPeekProps) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  const active = environments.find((row) => row.id === activeId && !row.isGlobal) ?? null;
  const globals = environments.find((row) => row.isGlobal) ?? null;
  const choices = environments.filter((row) => !row.isGlobal);

  // Closes on a click anywhere else. Captured, so it still fires over the
  // panes below, which stop propagation of their own clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  // Nothing revealed carries over to the next opening.
  useEffect(() => {
    if (!open) setRevealed(new Set());
  }, [open]);

  const reveal = (id: string) => {
    const next = new Set(revealed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRevealed(next);
  };

  const rows = [
    ...(active?.variables ?? []).map((variable) => ({ variable, from: active!.name })),
    ...(globals?.variables ?? []).map((variable) => ({ variable, from: "Globals" })),
  ].filter((row) => row.variable.enabled);

  return (
    <div ref={rootRef} className="relative">
      <button
        className="api-select flex items-center gap-1.5"
        onClick={() => setOpen(!open)}
        title="Which environment's variables are in play, and what they are"
        aria-label="Environment"
        aria-expanded={open}
      >
        <span className="max-w-[140px] truncate">{active?.name ?? "No environment"}</span>
        <ChevronDown size={11} className="shrink-0 text-ft-text-muted" />
      </button>

      {open && (
        <div className="api-env-peek">
          <div className="max-h-[160px] overflow-auto border-b border-ft-border-subtle">
            <button
              className="api-menu-item w-full"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <span className="w-3.5 shrink-0">
                {activeId === null && <Check size={11} />}
              </span>
              No environment
            </button>

            {choices.map((environment) => (
              <div key={environment.id} className="group flex items-center">
                <button
                  className="api-menu-item flex-1 min-w-0"
                  onClick={() => {
                    onSelect(environment.id);
                    setOpen(false);
                  }}
                >
                  <span className="w-3.5 shrink-0">
                    {environment.id === activeId && <Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                  <span className="shrink-0 text-ft-text-muted">
                    {environment.variables.length}
                  </span>
                </button>
                <button
                  className="api-row-action group-hover:opacity-100 mr-1"
                  onClick={() => {
                    onEdit(environment.id);
                    setOpen(false);
                  }}
                  title={`Edit ${environment.name}`}
                  aria-label={`Edit ${environment.name}`}
                >
                  <Pencil size={11} />
                </button>
              </div>
            ))}
          </div>

          {/* What those names are worth right now — the actual question. */}
          <div className="max-h-[240px] overflow-auto">
            {rows.length === 0 ? (
              <div className="px-3 py-2.5 text-[11px] leading-relaxed text-ft-text-muted">
                {active || globals
                  ? "Nothing set here yet."
                  : "No environment selected, and no globals. Requests resolve only what their collection defines."}
              </div>
            ) : (
              rows.map(({ variable, from }) => {
                const masked = variable.secret && !revealed.has(variable.id);
                // What a request would actually use, which is the current
                // value when there is one — the same rule resolution follows.
                const value = variable.currentValue ?? variable.value;

                return (
                  <div
                    key={variable.id}
                    className="flex items-center gap-2 px-3 py-1 text-[10px] font-mono"
                  >
                    <span className="min-w-0 flex-1 truncate text-ft-accent">
                      {variable.key}
                    </span>
                    <span
                      className={`min-w-0 flex-[1.4] truncate ${
                        value === "" ? "text-ft-warning" : "text-ft-text"
                      }`}
                      title={masked ? undefined : value}
                    >
                      {masked ? "••••••••" : value === "" ? "(empty)" : value}
                    </span>
                    {variable.secret && (
                      <button
                        className="shrink-0 rounded p-0.5 text-ft-text-muted hover:text-ft-text"
                        onClick={() => reveal(variable.id)}
                        title={masked ? "Show" : "Hide"}
                        aria-label={masked ? `Show ${variable.key}` : `Hide ${variable.key}`}
                      >
                        {masked ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    )}
                    <span className="w-12 shrink-0 truncate text-right text-ft-text-muted">
                      {from}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-ft-border-subtle">
            <span className="text-[10px] text-ft-text-muted">
              Showing what a request would use.
            </span>
            <div className="flex-1" />
            <button
              className="api-chip-action"
              onClick={() => {
                onEdit(activeId ?? "new");
                setOpen(false);
              }}
            >
              {activeId ? "Edit" : "New environment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
