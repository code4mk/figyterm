/**
 * The two little overlays the language-server features need: pick one of these,
 * and type a new name.
 *
 * Plain DOM inside the editor's own scroller rather than React, for the same
 * reason `FindPanel` is mounted into a CodeMirror panel rather than floated
 * over one: these are anchored to a *character position*, which only CodeMirror
 * knows, and they have to survive the editor scrolling underneath them. Going
 * through React would mean lifting a caret coordinate into component state and
 * re-rendering the modal to move a box six pixels.
 *
 * Both are keyboard-first — arrows and Enter, Escape to dismiss — because both
 * are reached from the keyboard.
 */

import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { EditorView } from "@codemirror/view";

interface Dismissable {
  close: () => void;
}

/** Only one at a time; opening a second closes the first. */
let open: Dismissable | null = null;

export function closePopup(): void {
  open?.close();
  open = null;
}

/** Room left around the overlay, so it never touches the editor's edge. */
const VIEWPORT_PADDING = 8;

/**
 * Pins `element` to a character position, and keeps it there.
 *
 * Through `@floating-ui/dom`, which the terminal's suggestion popup already
 * uses — not a second positioning library, and not the arithmetic this used to
 * do by hand. That version flipped vertically and nothing else, so an overlay
 * opened near the right edge of a narrow modal ran off it, and one opened near
 * the bottom of a long list was taller than the space it had.
 *
 * The character position is a **virtual element**: CodeMirror can give
 * coordinates for an offset but there is no DOM node there to anchor to, and a
 * `getBoundingClientRect` is the whole interface Floating UI needs.
 *
 * Returns the cleanup for the `autoUpdate` subscription, which is what keeps
 * the overlay on its character while the editor scrolls, the window resizes, or
 * the modal is dragged.
 */
function anchor(view: EditorView, element: HTMLElement, at: number): () => void {
  const reference = {
    getBoundingClientRect: () => {
      const coords = view.coordsAtPos(at);
      if (coords) {
        return new DOMRect(
          coords.left,
          coords.top,
          0,
          coords.bottom - coords.top
        );
      }
      // The position has scrolled out of the rendered range; the caret's own
      // box is the closest honest answer.
      const fallback = view.dom.getBoundingClientRect();
      return new DOMRect(fallback.left, fallback.top, 0, 0);
    },
  };

  const place = () => {
    /*
      Bounded to the code area, not the window.

      The breadcrumb bar and the status bar are outside CodeMirror's DOM
      entirely, so nothing stops an overlay from covering them: a picker opened
      on line 1 flips upward and lands on the file path. Handing Floating UI the
      scroller as its boundary makes it flip back down instead.
    */
    const boundary = view.scrollDOM;

    void computePosition(reference, element, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [
        offset(4),
        flip({
          fallbackPlacements: ["top-start"],
          padding: VIEWPORT_PADDING,
          boundary,
        }),
        shift({ padding: VIEWPORT_PADDING, boundary }),
        // Never taller than the space it has. Without this the menu's own
        // `max-height` wins and the last entries sit below the window.
        size({
          padding: VIEWPORT_PADDING,
          boundary,
          apply({ availableHeight, elements }) {
            elements.floating.style.setProperty(
              "--cm-lsp-available",
              `${Math.max(120, availableHeight)}px`
            );
          },
        }),
      ],
    }).then(({ x, y }) => {
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.visibility = "visible";
    });
  };

  return autoUpdate(reference, element, place);
}

export interface MenuItem {
  /** The main line. For a location this is the file name. */
  label: string;
  /** Dimmed, beside the label — a directory, or a code action's kind. */
  detail?: string;
  /** A second line under the label: the source line a reference sits on. */
  preview?: string;
  /** Right-aligned marker, such as a line number. */
  badge?: string;
  disabled?: boolean;
}

export interface MenuOptions {
  title?: string;
  /** Shown small and dimmed beside the title — "12 in 4 files". */
  subtitle?: string;
  /** The keyboard hint along the bottom. Defaults to the usual one. */
  hint?: string;
}

/**
 * A list to choose from.
 *
 * Resolves with the chosen index, or null if it was dismissed.
 *
 * Dismissal has three routes on purpose, because a panel that can only be
 * closed one way is a panel people get stuck in: Escape, the close button, and
 * a click anywhere outside it. The outside click is the one that was missing
 * and the one most people reach for first.
 */
export function showMenu(
  view: EditorView,
  at: number,
  items: MenuItem[],
  options: MenuOptions | string = {}
): Promise<number | null> {
  closePopup();

  const { title, subtitle, hint }: MenuOptions =
    typeof options === "string" ? { title: options } : options;

  return new Promise((resolve) => {
    const element = document.createElement("div");
    element.className = "cm-lsp-popup cm-lsp-menu";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", title ?? "Select");

    if (title) {
      const header = document.createElement("div");
      header.className = "cm-lsp-popup-header";

      const heading = document.createElement("div");
      heading.className = "cm-lsp-popup-title";
      heading.textContent = title;
      header.append(heading);

      if (subtitle) {
        const count = document.createElement("div");
        count.className = "cm-lsp-popup-subtitle";
        count.textContent = subtitle;
        header.append(count);
      }

      const close = document.createElement("button");
      close.className = "cm-lsp-popup-close";
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.title = "Close (Esc)";
      // A glyph rather than an icon component: this is plain DOM, outside
      // React, and pulling a renderer in for one × would not be worth it.
      close.textContent = "✕";
      close.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      });
      header.append(close);

      element.append(header);
    }

    const list = document.createElement("div");
    list.className = "cm-lsp-menu-list";
    list.setAttribute("role", "listbox");
    element.append(list);

    const rows = items.map((item, index) => {
      const row = document.createElement("div");
      row.className = "cm-lsp-menu-item";
      row.setAttribute("role", "option");
      if (item.disabled) row.classList.add("is-disabled");

      const top = document.createElement("div");
      top.className = "cm-lsp-menu-line";

      const label = document.createElement("span");
      label.className = "cm-lsp-menu-label";
      label.textContent = item.label;
      top.append(label);

      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "cm-lsp-menu-detail";
        detail.textContent = item.detail;
        top.append(detail);
      }

      if (item.badge) {
        const badge = document.createElement("span");
        badge.className = "cm-lsp-menu-badge";
        badge.textContent = item.badge;
        top.append(badge);
      }

      row.append(top);

      if (item.preview) {
        const preview = document.createElement("div");
        preview.className = "cm-lsp-menu-preview";
        // The source line, as it is. Indentation is stripped by the caller so
        // that deeply nested code doesn't render as an empty row.
        preview.textContent = item.preview;
        row.append(preview);
      }

      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!item.disabled) finish(index);
      });
      row.addEventListener("mouseenter", () => select(index));
      list.append(row);
      return row;
    });

    const footer = document.createElement("div");
    footer.className = "cm-lsp-popup-hint";
    footer.textContent = hint ?? "↑↓ to move · ↵ to open · Esc to close";
    element.append(footer);

    let active = items.findIndex((item) => !item.disabled);

    const select = (index: number) => {
      if (index < 0 || index >= rows.length) return;
      rows[active]?.classList.remove("is-active");
      active = index;
      rows[active]?.classList.add("is-active");
      rows[active]?.scrollIntoView({ block: "nearest" });
    };

    const step = (delta: number) => {
      for (let i = 1; i <= rows.length; i++) {
        const next = (active + delta * i + rows.length * i) % rows.length;
        if (!items[next].disabled) return select(next);
      }
    };

    const finish = (index: number | null) => {
      cleanup();
      resolve(index);
    };

    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          return step(1);
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          return step(-1);
        case "Home":
          event.preventDefault();
          event.stopPropagation();
          return select(0);
        case "End":
          event.preventDefault();
          event.stopPropagation();
          return select(rows.length - 1);
        case "PageDown":
          event.preventDefault();
          event.stopPropagation();
          return select(Math.min(rows.length - 1, active + 8));
        case "PageUp":
          event.preventDefault();
          event.stopPropagation();
          return select(Math.max(0, active - 8));
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          return finish(items[active]?.disabled ? null : active);
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          return finish(null);
      }
    };

    /*
      Any press that isn't inside the panel closes it.

      On `mousedown` rather than `click`, so the panel is gone before the press
      lands in the editor behind — otherwise clicking away both dismisses this
      and moves the caret, which reads as the click having done two things.
      Captured at the document, because the editor is inside a modal that stops
      propagation on its own container.
    */
    const onOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      finish(null);
    };

    let stopTracking: (() => void) | null = null;

    const cleanup = () => {
      view.dom.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("blur", onWindowBlur);
      stopTracking?.();
      element.remove();
      open = null;
    };

    const onWindowBlur = () => finish(null);

    // Hidden until placed, or it paints once at the top-left and jumps.
    element.style.visibility = "hidden";
    view.dom.append(element);
    select(active);
    stopTracking = anchor(view, element, at);
    view.dom.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onWindowBlur);
    /*
      Registered on the next tick, not now. The press that opened this panel —
      the context-menu click, or the mouseup of a chord — is still being
      dispatched, and a listener added synchronously would catch its tail and
      close the panel in the same gesture that opened it.
    */
    setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);

    open = { close: () => finish(null) };
  });
}

/**
 * A one-line text box, for the new name in a rename.
 *
 * Resolves with the text, or null if it was dismissed. The input takes focus,
 * so keystrokes go here rather than into the document behind — which would
 * otherwise be typing a new symbol name into the file at the cursor.
 */
export function showInput(
  view: EditorView,
  at: number,
  label: string,
  initial: string
): Promise<string | null> {
  closePopup();

  return new Promise((resolve) => {
    const element = document.createElement("div");
    element.className = "cm-lsp-popup cm-lsp-input";

    const heading = document.createElement("label");
    heading.className = "cm-lsp-popup-title";
    heading.textContent = label;
    element.append(heading);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-lsp-input-field";
    input.value = initial;
    input.spellcheck = false;
    element.append(input);

    const hint = document.createElement("div");
    hint.className = "cm-lsp-popup-hint";
    hint.textContent = "Enter to rename · Esc to cancel";
    element.append(hint);

    const finish = (value: string | null) => {
      cleanup();
      resolve(value);
    };

    const onKey = (event: KeyboardEvent) => {
      // Stopped in every case: this box is inside the editor's DOM, and an
      // unhandled key here reaches CodeMirror's own keymap.
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.value.trim();
        finish(value && value !== initial ? value : null);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };

    let stopTracking: (() => void) | null = null;

    const cleanup = () => {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      stopTracking?.();
      element.remove();
      open = null;
      view.focus();
    };

    const onBlur = () => finish(null);

    element.style.visibility = "hidden";
    view.dom.append(element);
    stopTracking = anchor(view, element, at);
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
    input.focus();
    input.select();

    open = { close: () => finish(null) };
  });
}
