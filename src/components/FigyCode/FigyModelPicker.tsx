/**
 * Which model answers, as a one-click choice in the footer.
 *
 * It was two clicks and a dialog, which is the right place to *set a
 * model up* and the wrong place to switch between ones already set up.
 * Those are different actions at different frequencies: adding a
 * provider happens twice, picking between a cheap model and an
 * expensive one happens in the middle of a task.
 *
 * Built here rather than taken from a library. A select that has to
 * match this window's type, open upwards from a 28px bar, and show a
 * price under each row is most of a component whatever it is built on,
 * and `react-select` is 30KB plus an emotion runtime for the parts that
 * would then need overriding.
 *
 * ## What a row says
 *
 * The name, and under it the host and what it costs. The price belongs
 * here because it is the reason to switch: an agent that is about to
 * read forty files has a right answer and it is not the expensive
 * model, and nobody makes that choice from a list of names.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { formatCost } from "../../services/figycode-blocks";
import type { ProviderModel } from "../../services/figycode-agent";

/** `api.openai.com`, from whatever was typed. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function name(model: ProviderModel): string {
  return model.label.trim() || model.model || "Untitled model";
}

/** `$3 in · $15 out`, or nothing when no prices are set. */
function price(model: ProviderModel): string | null {
  if (!model.inputPrice && !model.outputPrice) return null;
  return `${formatCost(model.inputPrice ?? 0)} in · ${formatCost(model.outputPrice ?? 0)} out`;
}

export function ModelPicker({
  models,
  active,
  onPick,
  onManage,
}: {
  models: ProviderModel[];
  active: string | null;
  /** Called with the id to switch to. Persisting it is the caller's. */
  onPick: (id: string) => void;
  /** The way to the place models are added and edited. */
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);

  const usable = models.filter((m) => m.baseUrl.trim() && m.model.trim());
  const chosen = usable.find((m) => m.id === active) ?? usable[0] ?? null;

  // A click anywhere else closes it, on the way down so nothing
  // underneath is half-pressed first.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", away), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", away);
    };
  }, [open]);

  // Opening lands on the model in use, not on the top of the list.
  useEffect(() => {
    if (open) setAt(Math.max(0, usable.findIndex((m) => m.id === chosen?.id)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: string) => {
    setOpen(false);
    if (id !== chosen?.id) onPick(id);
  };

  /*
    The keys this list claims, and only these.

    The window's own handler takes Escape, the arrows and digits for the
    composer and the permission card, so every one of them is stopped
    here while the list is open — and nothing else is, because a list
    that swallowed typing would be a list you cannot escape by typing.
  */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") {
      claim();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      claim();
      setAt((i) => Math.min(usable.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      claim();
      setAt((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && usable[at]) {
      claim();
      choose(usable[at].id);
    }
  };

  return (
    <div className="figy-picker" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`figy-picker-button ${open ? "on" : ""} ${chosen ? "" : "warn"}`}
        onClick={() => (usable.length > 0 ? setOpen((o) => !o) : onManage())}
        title={chosen ? `${name(chosen)} · ${host(chosen.baseUrl)}` : "No model is set up"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{chosen ? name(chosen) : "set up a model"}</span>
        <ChevronDown size={10} className="figy-picker-caret shrink-0" />
      </button>

      {open && (
        <div className="figy-picker-list" role="listbox" aria-label="Model">
          {usable.map((model, i) => (
            <button
              type="button"
              key={model.id}
              role="option"
              aria-selected={model.id === chosen?.id}
              className={`figy-picker-row ${i === at ? "at" : ""}`}
              onMouseEnter={() => setAt(i)}
              onClick={() => choose(model.id)}
            >
              <span className="figy-picker-tick">
                {model.id === chosen?.id ? <Check size={11} /> : null}
              </span>
              <span className="figy-picker-text">
                <span className="figy-picker-name">{name(model)}</span>
                <span className="figy-picker-meta">
                  {[host(model.baseUrl), price(model)].filter(Boolean).join(" · ")}
                </span>
              </span>
              {!model.hasKey && <span className="figy-picker-flag">no key</span>}
            </button>
          ))}

          <button type="button" className="figy-picker-manage" onClick={() => (setOpen(false), onManage())}>
            <Settings2 size={11} />
            Manage models…
          </button>
        </div>
      )}
    </div>
  );
}
