/**
 * A dropdown of our own, wherever a `<select>` used to be.
 *
 * A native `<select>` draws the operating system's menu: the system font at
 * the system size, its own colours, its own corner radius, and no room for a
 * word of explanation beside an option. It is the one control in a window that
 * cannot be made to match the rest of it — and this window has seven of them.
 *
 * The menu is portalled to the body and positioned from the button's own
 * rectangle: these sit inside a modal several clipping scrollers deep, and one
 * drawn in place is cut off at the bottom edge of a 22px-high row.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A few words on what it means, beside the label. The pairs people pick
   * the wrong one of are exactly what a bare list cannot help with. */
  hint?: string;
  /** A colour class, for the lists where the options are colour-coded. */
  tone?: string;
}

interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Width of the button. The menu is sized to its own content. */
  className?: string;
  ariaLabel?: string;
  title?: string;
  /** Drawn in the button when the value matches no option — an imported
   * document using something this window does not offer. */
  fallbackLabel?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
  title,
  fallbackLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const chosen = options.find((option) => option.value === value);

  // Measured before paint, so the menu never appears at the top-left corner
  // for one frame on its way to the button.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Flipped above when there is no room below. A menu that opens off the
    // bottom of the window is a menu with no options in it.
    const height = Math.min(options.length * 30 + 10, 300);
    const below = window.innerHeight - rect.bottom - 8;
    setBox({
      top: below < height ? Math.max(8, rect.top - height - 6) : rect.bottom + 6,
      left: Math.min(rect.left, Math.max(8, window.innerWidth - 8 - Math.max(rect.width, 160))),
      minWidth: rect.width,
    });
  }, [open, options.length]);

  // Opening always starts on what is already chosen, wherever the list was
  // left last time.
  useEffect(() => {
    if (!open) return;
    const at = options.findIndex((option) => option.value === value);
    setActive(at === -1 ? 0 : at);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;

    const away = (event: Event) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    /*
      `mousedown` in the capture phase. `click` would let the menu outlive the
      gesture that dismissed it; the bubble phase would miss it entirely,
      because this window is full of panes that stop `mousedown` where it
      lands — a drag handle, a resize separator, the modal's title bar — and a
      listener on the document never hears an event stopped three levels up.
    */
    document.addEventListener("mousedown", away, true);
    document.addEventListener("touchstart", away, true);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("touchstart", away, true);
    };
  }, [open]);

  const choose = (option: SelectOption<T>) => {
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((at) => (at + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => (at - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const option = options[active];
      if (option) choose(option);
    }
    // Nothing below gets these while a menu is open: ⌘S and the tab
    // shortcuts would otherwise fire off an arrow key.
    event.stopPropagation();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`api-picker ${chosen?.tone ?? ""} ${open ? "open" : ""} ${className ?? ""}`}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? chosen?.hint}
      >
        <span className="api-picker-label">
          {chosen?.label ?? fallbackLabel ?? value}
        </span>
        <ChevronDown size={11} className="api-picker-caret" />
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            className="api-picker-menu"
            style={{ top: box.top, left: box.left, minWidth: box.minWidth }}
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={onKeyDown}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`api-picker-item ${option.tone ?? ""} ${
                  index === active ? "active" : ""
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="api-picker-item-label">{option.label}</span>
                {option.hint && <span className="api-picker-item-hint">{option.hint}</span>}
                {option.value === value && (
                  <Check size={12} className="api-picker-item-tick" />
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
