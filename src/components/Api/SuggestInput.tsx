/**
 * A plain input with a list of suggestions under it.
 *
 * Not `<datalist>`: it cannot be styled, renders differently on every platform,
 * and on macOS shows nothing at all until a character has been typed — which
 * is exactly the moment somebody who does not know the header names needs it.
 *
 * Not the CodeMirror field either. A header *name* is `Content-Type`, not a
 * template, and an editor per cell in a table of thirty is thirty editors. An
 * `<input>` with a list under it is the whole requirement.
 *
 * **The list is the variable popup's list.** Same panel, same header with a
 * live count, same two-line rows, same key hint along the bottom — it wears
 * the `figy-vars` classes rather than a set of its own, because two completion
 * popups that look like two applications is the thing this window keeps being
 * told off for. It is portalled to the body for the same reason that one is:
 * drawn in place it is cut off by the scrolling table it sits in.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Suggestion {
  value: string;
  /** One line about it, shown under the name. */
  hint?: string;
}

interface SuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Recomputed from what has been typed; the caller decides the order. */
  suggestions: Suggestion[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** The word across the top of the list. */
  title?: string;
}

export function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
  ariaLabel,
  title = "SUGGESTIONS",
}: SuggestInputProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = open && suggestions.length > 0;

  // Measured before paint, and again whenever the list changes height, so it
  // never appears at the corner of the window on its way to the field.
  useLayoutEffect(() => {
    if (!shown) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Flipped above when there is no room below: a list that opens off the
    // bottom of the window is a list with nothing in it.
    const height = Math.min(suggestions.length * 44 + 66, 336);
    const below = window.innerHeight - rect.bottom - 8;
    setBox({
      top: below < height ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: Math.min(rect.left, Math.max(8, window.innerWidth - 8 - 320)),
      width: Math.max(rect.width, 260),
    });
  }, [shown, suggestions.length]);

  // Closed on a click anywhere else. Captured, because the panes around this
  // stop propagation of their own clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    // The list is positioned once, so scrolling the table underneath would
    // leave it behind, pointing at a row that has moved on.
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // The highlighted row goes back to the top whenever the list changes, or it
  // would point at whatever happens to be in that position now.
  useEffect(() => setActive(0), [suggestions.length, value]);

  useEffect(() => {
    if (!shown) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-at="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  const take = (suggestion: Suggestion) => {
    onChange(suggestion.value);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) {
        setOpen(true);
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Wraps, so holding one arrow reaches everything rather than stopping.
      setActive((at) => (at + step + suggestions.length) % Math.max(1, suggestions.length));
      return;
    }
    if (event.key === "Enter" && open && suggestions[active]) {
      event.preventDefault();
      take(suggestions[active]!);
      return;
    }
    if (event.key === "Escape" && open) {
      // Stopped, or the window behind would take it as "close me".
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`api-suggest ${className ?? ""}`}>
      <input
        className="api-suggest-field"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        role="combobox"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {shown &&
        box &&
        createPortal(
          <div
            ref={listRef}
            className="figy-vars figy-vars-free"
            style={{ position: "fixed", top: box.top, left: box.left, width: box.width }}
            role="listbox"
            aria-label={ariaLabel}
            // The field must not lose focus before a click on a row lands.
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="figy-vars-head">
              <span className="figy-vars-title">{title}</span>
              <span className="figy-vars-count">{suggestions.length}</span>
            </div>

            <div className="figy-vars-list">
              {suggestions.map((suggestion, at) => (
                <div
                  key={suggestion.value}
                  data-at={at}
                  role="option"
                  aria-selected={at === active}
                  className={`figy-vars-row ${at === active ? "selected" : ""}`}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => take(suggestion)}
                >
                  <div className="figy-vars-line">
                    <span className="figy-vars-name">{suggestion.value}</span>
                  </div>
                  <div className={`figy-vars-value ${suggestion.hint ? "" : "empty"}`}>
                    {suggestion.hint ?? "—"}
                  </div>
                </div>
              ))}
            </div>

            <div className="figy-vars-foot">↑↓ to move · ↵ to insert · Esc to close</div>
          </div>,
          document.body
        )}
    </div>
  );
}
