/**
 * The method, chosen from a list of our own.
 *
 * A native `<select>` draws the operating system's menu: a grey list in the
 * system font, at the system size, with no room for a colour or a word of
 * explanation — and it is the one control in the window that cannot be made
 * to look like the rest of it. So this is a button and a list.
 *
 * The colours are the same ones the sidebar gives a method, because that is
 * the whole point of colouring them: `DELETE` should be the same red wherever
 * it appears, and a person should be able to tell a POST from a PUT without
 * reading either.
 *
 * The list is portalled to the body and positioned from the button's own
 * rectangle. This sits inside a modal several clipping scrollers deep, and a
 * menu drawn in place is cut off at the bottom edge of a 30px-high URL bar.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { HTTP_METHODS, HttpMethod } from "../../types/api";

interface MethodSelectProps {
  value: HttpMethod;
  onChange: (method: HttpMethod) => void;
}

/** The colour a method takes, here and in the sidebar. */
export function methodTone(method: string): string {
  switch (method.toUpperCase()) {
    case "POST":
      return "post";
    case "PUT":
    case "PATCH":
      return "put";
    case "DELETE":
      return "delete";
    case "HEAD":
    case "OPTIONS":
      return "quiet";
    default:
      return "get";
  }
}

/**
 * What each one is for, in the fewest words that are still true.
 *
 * Not decoration: PUT and PATCH are the pair people pick the wrong one of, and
 * a list of seven bare words does nothing to help with that.
 */
const MEANS: Record<HttpMethod, string> = {
  GET: "Read something",
  POST: "Create, or anything else",
  PUT: "Replace it whole",
  PATCH: "Change part of it",
  DELETE: "Remove it",
  HEAD: "Headers only, no body",
  OPTIONS: "Ask what is allowed",
};

export function MethodSelect({ value, onChange }: MethodSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => HTTP_METHODS.indexOf(value));
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Measured before paint, so the menu never appears at the top-left corner
  // for one frame on its way to the button.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setBox({ top: rect.bottom + 6, left: rect.left });
  }, [open]);

  // Opening always starts on what is already chosen, wherever the list was
  // left last time.
  useEffect(() => {
    if (open) setActive(HTTP_METHODS.indexOf(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;

    const away = (event: Event) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    /*
      `mousedown`, not `click`: a click that lands on something else should
      close this and reach that thing in the same gesture.

      And in the capture phase, not the bubble one. This window is full of
      panes that stop `mousedown` where it lands — a drag handle, a resizable
      separator, the modal's own title bar — and a listener waiting on the
      document for an event that was stopped three levels up never fires,
      which leaves the menu open over whatever was just clicked.
    */
    document.addEventListener("mousedown", away, true);
    // A touch or a pen is the same gesture and must close it too.
    document.addEventListener("touchstart", away, true);
    // Scrolling the pane underneath would leave the menu behind, pointing at
    // nothing. Closing is the honest answer and costs one keystroke.
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("touchstart", away, true);
    };
  }, [open]);

  const choose = (method: HttpMethod) => {
    onChange(method);
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
      setActive((at) => (at + 1) % HTTP_METHODS.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => (at - 1 + HTTP_METHODS.length) % HTTP_METHODS.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(HTTP_METHODS[active] ?? value);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`api-method-button ${methodTone(value)} ${open ? "open" : ""}`}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Method: ${value}`}
        title="Method"
      >
        <span className="api-method-name">{value}</span>
        <ChevronDown size={12} className="api-method-caret" />
      </button>

      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            className="api-method-menu"
            style={{ top: box.top, left: box.left }}
            role="listbox"
            aria-label="Method"
            onKeyDown={onKeyDown}
          >
            {HTTP_METHODS.map((method, index) => (
              <button
                key={method}
                type="button"
                role="option"
                aria-selected={method === value}
                className={`api-method-item ${methodTone(method)} ${
                  index === active ? "active" : ""
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(method)}
              >
                <span className="api-method-item-name">{method}</span>
                <span className="api-method-item-means">{MEANS[method]}</span>
                {method === value && <Check size={12} className="api-method-item-tick" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
