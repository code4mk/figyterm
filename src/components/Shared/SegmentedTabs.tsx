import { useRef } from "react";

/**
 * A segmented control: one choice, several options, a pill that slides.
 *
 * Lifted out of the drawing window's Draw · Notes · Both switcher, which is the
 * best control in the app and was the only one that had it. The editor's side
 * column asks the same kind of question — Files, Search or Source Control, one
 * at a time — and was answering it with underlined tabs, so the two looked like
 * different kinds of choice when they are the same kind.
 *
 * **The pill is one element, not a background per button.** That is what makes
 * the change read as one control changing state rather than two buttons
 * swapping colour, and it means the selected treatment is defined in exactly
 * one place. It also forces the segments to stay equal width — the pill is
 * `100% / n` and moves in whole steps — hence `flex: 1 1 0` on every item
 * rather than letting the labels size them.
 *
 * Keyboard follows the tablist pattern: `←`/`→` move through the segments,
 * `Home`/`End` jump to the ends, and a roving tabindex makes the whole control
 * one tab stop rather than three.
 */

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** The native tooltip. Falls back to the label. */
  title?: string;
  /** For when the visible label is shorter than the thing it means. */
  aria?: string;
  /**
   * Anything that rides along after the label — the drawing window's
   * unread-notes dot, the editor's count of changed files.
   */
  badge?: React.ReactNode;
}

interface SegmentedTabsProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for a screen reader. */
  ariaLabel: string;
  /**
   * Labels off, icons on — for when the control is narrower than its words.
   * Dropped rather than truncated: half a word is worse than the icon alone.
   */
  showLabels?: boolean;
  /**
   * The selection is real, but what it selects is put away.
   *
   * The editor's column can be collapsed while still being *on* Search, and
   * those are two different facts. The pill stays where it is and goes quiet,
   * so the control reports both at once: this one, and not right now.
   */
  standby?: boolean;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  showLabels = true,
  standby = false,
  className = "",
}: SegmentedTabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    segments.findIndex((segment) => segment.value === value)
  );

  const focusSegment = (next: number) => {
    const clamped = (next + segments.length) % segments.length;
    onChange(segments[clamped].value);
    ref.current?.querySelector<HTMLElement>(`[data-seg="${clamped}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusSegment(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusSegment(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusSegment(0);
        break;
      case "End":
        e.preventDefault();
        focusSegment(segments.length - 1);
        break;
    }
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      className={`seg-tabs ${className}`}
      /*
        The pill's geometry, as two numbers the stylesheet does the arithmetic
        with. Passing the transform itself would put layout maths in the
        component; passing the index and the count leaves it where the rest of
        the control's measurements already are.
      */
      style={
        {
          "--seg-count": segments.length,
          "--seg-index": index,
        } as React.CSSProperties
      }
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span aria-hidden className={`seg-pill ${standby ? "standby" : ""}`} />

      {segments.map((segment, i) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            data-seg={i}
            role="tab"
            aria-selected={selected}
            // Roving tabindex: one tab stop for the whole control.
            tabIndex={selected ? 0 : -1}
            title={segment.title ?? segment.label}
            aria-label={segment.aria ?? segment.label}
            onClick={() => onChange(segment.value)}
            className={`seg-item ${selected ? "selected" : ""} ${
              selected && standby ? "standby" : ""
            }`}
          >
            {segment.icon}
            {showLabels && <span className="seg-label">{segment.label}</span>}
            {segment.badge}
          </button>
        );
      })}
    </div>
  );
}
