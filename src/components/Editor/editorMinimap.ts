import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { syntaxHighlighter } from "./editorTheme";

/**
 * The minimap — the whole file as a column of marks, with the scrollbar beyond
 * it, the way an editor with a minimap arranges them.
 *
 * Written here rather than taken from `@replit/codemirror-minimap`, the usual
 * answer, for the reason `editorIndent.ts` gives about its own package and one
 * more: that one's last release is a year old, it is flagged for release
 * cadence, and this binary ships on three platforms where a dependency that
 * breaks on one of them breaks a release.
 *
 * ## Why it owns the scrollbar
 *
 * The first build put the map in a margin to the right of `.cm-scroller`, and
 * a scroller keeps its scrollbar at *its own* right edge — so the order came
 * out content, scrollbar, map, with the bar stranded in the middle. The only
 * way to get the bar past the map is to take it off the scroller and draw it,
 * which is what every editor with a minimap does.
 *
 * So the scroller's native bar is hidden, the map sits in the margin, and a
 * slim track sits outside the map. Scrolling by wheel, keyboard and selection
 * is still entirely CodeMirror's; this draws the bar and drags it.
 *
 * ## Everything is measured in pixels, not lines
 *
 * The map's box and the scrollbar's thumb are both `scrollTop / scrollHeight`
 * of the way down. Dragging either sets `scrollTop` directly rather than
 * dispatching a `scrollIntoView` — which is what makes a drag *glide* instead
 * of landing the cursor's line in the middle on every pointer move, and it is
 * correct with word wrap on for free, since wrapped lines are taller in pixels
 * and that is what pixels measure.
 *
 * ## It draws shape, not syntax colour
 *
 * Colouring marks by token means asking the parser for the *whole document* —
 * the one thing CodeMirror's incremental parser is careful never to do. On a
 * large file that is a long pause, or a map that fills in as you scroll. What
 * it draws instead is each line's non-blank runs at their real columns, which
 * keeps the file's shape: indentation, block structure, the gap where a
 * function ends, the long line that is a string. That is what a minimap is
 * navigated by; at two pixels a line, colour was never carrying much of it.
 */

/** Wide enough for ~90 columns of marks, narrow enough not to cost a pane. */
const WIDTH = 74;

/** The bar beyond the map. Matches the width the app styles its others at. */
const BAR_WIDTH = 10;

/** Room for one line, at the two extremes of how much there is to go round. */
const MIN_ROW = 1;
const MAX_ROW = 3;

/**
 * One character, one CSS pixel wide — the proportion VS Code uses at its
 * default scale, where a cell is 1×2. Lines longer than the width are clipped,
 * which still reads as "this line is long" because the text runs to the margin.
 */
const COLUMN_WIDTH = 1;

/**
 * How much bigger than its final size the text is rasterised.
 *
 * The canvas has a backing store this many times the element's CSS size, on
 * top of the device pixel ratio, and the browser scales it down to fit. That
 * downscale is the whole trick: glyphs drawn at eleven device pixels and
 * resampled to three come out as properly antialiased miniature text, where
 * glyphs drawn directly at three come out as noise.
 *
 * Two, because the gain past that is invisible and the cost is quadratic.
 */
const SUPERSAMPLE = 2;

/** The darkest the text is drawn. Minimaps are a glance, not a read. */
const MAX_ALPHA = 0.82;

/** Neither indicator becomes a hairline, however long the file is. */
const MIN_BOX_HEIGHT = 12;
const MIN_THUMB_HEIGHT = 24;

/** A tab moves this many columns in the drawing, matching the common default. */
const TAB_COLUMNS = 2;

/**
 * How long the map waits after an edit before redrawing.
 *
 * Long enough that a burst of typing costs one redraw rather than one per
 * keystroke, short enough that it never feels like it is lagging behind.
 */
const REDRAW_DELAY = 140;

/**
 * How long the parser is given to finish the document before the map gives up
 * and draws plain. A frame is sixteen milliseconds; this is a fraction of the
 * debounce above and never blocks one the user is watching.
 */
const PARSE_BUDGET = 30;

/** Past this many characters the map is drawn plain. See `tree()`. */
const COLOR_LIMIT = 500_000;

/** A stretch of one line that is drawn in a single colour. */
export interface Segment {
  /** Where it starts, in columns from the left edge of the map. */
  column: number;
  text: string;
  /** `null` where the parser had nothing to say — drawn in the plain colour. */
  color: string | null;
}

/** A colour the highlighter gave for a stretch of the document. */
export interface ColorSpan {
  from: number;
  to: number;
  color: string;
}

/**
 * One line, as the coloured pieces that will be drawn for it.
 *
 * Three jobs at once, and they have to be one pass because each depends on the
 * others' bookkeeping:
 *
 * - **Tabs become spaces**, to the next tab stop rather than a fixed width —
 *   the canvas lays glyphs out at a fixed advance and has no idea what a tab
 *   is, and getting the stop wrong shifts everything after it on the line.
 * - **The line is clipped** to the columns that fit.
 * - **Characters are grouped by colour**, so the drawing is one `fillText` per
 *   run rather than one per character.
 *
 * `spans` are document offsets, which is what the highlighter deals in; the
 * columns that come out are the map's, which is what the canvas deals in. The
 * translation between the two is the thing this exists to get right.
 */
export function lineSegments(
  text: string,
  lineStart: number,
  spans: ColorSpan[],
  maxColumns: number,
  tabColumns = TAB_COLUMNS
): Segment[] {
  const segments: Segment[] = [];
  let column = 0;
  let spanIndex = 0;
  let current: Segment | null = null;

  const push = (char: string, color: string | null, at: number) => {
    if (current && current.color === color && current.column + current.text.length === at) {
      current.text += char;
      return;
    }
    current = { column: at, text: char, color };
    segments.push(current);
  };

  for (let i = 0; i < text.length && column < maxColumns; i++) {
    const char = text[i];
    const offset = lineStart + i;

    if (char === "\t") {
      const next = Math.min(maxColumns, column + tabColumns - (column % tabColumns));
      column = next;
      current = null; // whitespace ends a run
      continue;
    }
    if (char === "\r") continue;
    if (char === " ") {
      column += 1;
      current = null;
      continue;
    }

    /*
      The spans arrive sorted and are walked alongside the text rather than
      searched per character — one cursor over both, so a long line costs a
      pass and not a pass per glyph.
    */
    while (spanIndex < spans.length && spans[spanIndex].to <= offset) spanIndex++;
    const span = spans[spanIndex];
    const color = span && span.from <= offset && offset < span.to ? span.color : null;

    push(char, color, column);
    column += 1;
  }

  return segments;
}

/**
 * Where a press belongs, as a scroll offset.
 *
 * `fraction` is how far down the track the pointer is; `grab` is where in the
 * thumb it was first taken hold of, so dragging a thumb moves it *with* the
 * pointer rather than snapping its middle to it. A press on empty track has no
 * grab and centres instead, which is what a press on empty track means.
 */
export function scrollTopFor(
  fraction: number,
  scrollHeight: number,
  clientHeight: number,
  grab: number | null
): number {
  const range = Math.max(0, scrollHeight - clientHeight);
  if (range === 0) return 0;
  const visible = clientHeight / scrollHeight;
  // Taking the grab out leaves the fraction the *top* of the view should be at,
  // rescaled because the top can only travel `1 - visible` of the track.
  const top = grab === null ? fraction - visible / 2 : fraction - grab;
  const travel = Math.max(1e-6, 1 - visible);
  return Math.min(range, Math.max(0, (top / travel) * range));
}

class MinimapView {
  private readonly wrap: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly box: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private frame = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Measured on resize, so the scroll path never has to force layout. */
  private mapHeight = 0;
  private barHeight = 0;
  /** The document length at which a full parse last ran out of budget. */
  private gaveUpAt = -1;
  private brushes: ReturnType<typeof syntaxHighlighter> | null = null;
  private brushesAreDark = false;
  /** Which element a drag started on, and where inside its indicator. */
  private drag: { on: "map" | "bar"; grab: number | null } | null = null;

  constructor(private readonly view: EditorView) {
    this.wrap = document.createElement("div");
    this.wrap.className = "cm-minimap";
    /*
      Not reachable by keyboard and not announced. Everything it does the
      editor already does better from the keyboard, and a canvas of marks has
      nothing to say to a screen reader that the document does not.
    */
    this.wrap.setAttribute("aria-hidden", "true");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "cm-minimap-canvas";
    this.wrap.appendChild(this.canvas);

    this.box = document.createElement("div");
    this.box.className = "cm-minimap-box";
    this.wrap.appendChild(this.box);

    this.bar = document.createElement("div");
    this.bar.className = "cm-minimap-bar";
    this.bar.setAttribute("aria-hidden", "true");
    this.thumb = document.createElement("div");
    this.thumb.className = "cm-minimap-thumb";
    this.bar.appendChild(this.thumb);

    this.wrap.addEventListener("pointerdown", this.onPointerDown);
    this.bar.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    /*
      The box and the thumb have to follow the scroller itself, not the editor's
      update cycle: a `viewportChanged` only arrives when CodeMirror re-renders,
      which is every few hundred pixels. Reading the scroll event is what makes
      them move with the content rather than in steps.
    */
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });

    view.dom.appendChild(this.wrap);
    view.dom.appendChild(this.bar);

    /*
      The editor is in a modal that is dragged, resized and put into
      picture-in-picture, so its height changes without the document changing,
      and a `ViewUpdate` does not always follow.
    */
    this.observer = new ResizeObserver(() => this.schedule(true));
    this.observer.observe(this.wrap);

    this.schedule(true);
  }

  update(update: ViewUpdate) {
    /*
      A reconfiguration is how the theme arrives.

      Without this the map kept the colours it was drawn with: switch to the
      light theme and the syntax stayed dark, on a now-light panel, until the
      next edit happened to repaint it. Nothing else in the update signals a
      theme change — it alters CSS, not geometry or content.
    */
    const reconfigured = update.transactions.some((tr) => tr.reconfigured);
    // A changed document can wait a moment; a changed shape or palette cannot.
    if (reconfigured || update.geometryChanged) this.schedule(true);
    else if (update.docChanged) this.schedule();
    else if (update.viewportChanged) this.place();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.idle);
    this.observer.disconnect();
    this.wrap.removeEventListener("pointerdown", this.onPointerDown);
    this.bar.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.wrap.remove();
    this.bar.remove();
  }

  private readonly onScroll = () => this.place();

  /**
   * The parse tree to colour from, or `null` to draw the map plain.
   *
   * Colour is **opportunistic**. `ensureSyntaxTree` is given a small budget
   * and may come back with nothing; when it does, the map is drawn in one
   * colour — which is a complete, correct map, not a broken one — and the next
   * redraw tries again with whatever the editor has parsed since. That is the
   * difference between a minimap that is sometimes plain and one that blocks
   * the frame on a large file to avoid ever being plain.
   *
   * Above `COLOR_LIMIT` it does not try at all. A document that size is being
   * sampled so heavily that the colours would be a handful of pixels, and the
   * walk is the one part of this that scales with the file rather than with
   * the map.
   */
  private tree() {
    const { state } = this.view;
    if (state.doc.length > COLOR_LIMIT) return null;

    /*
      The budget is spent at most once per document revision.

      `ensureSyntaxTree` parses *up to* its timeout and returns null when it
      could not finish. Called on every redraw, a file that never finishes
      would burn thirty milliseconds per keystroke forever and still end up
      drawing from the partial tree. So a failure is remembered against the
      document's revision: later redraws of the same text take whatever the
      editor has parsed on its own account, and an edit makes it worth trying
      again.
    */
    if (this.gaveUpAt !== state.doc.length) {
      const full = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET);
      if (full) return full;
      this.gaveUpAt = state.doc.length;
    }
    return syntaxTree(state);
  }

  /** The syntax colours for the theme in force, built once per theme. */
  private highlighter() {
    const dark = this.isDark();
    if (!this.brushes || this.brushesAreDark !== dark) {
      this.brushes = syntaxHighlighter(dark);
      this.brushesAreDark = dark;
    }
    return this.brushes;
  }

  /** Which half of the theme is in use, for the matching syntax colours. */
  private isDark(): boolean {
    const background = window.getComputedStyle(this.view.contentDOM).backgroundColor;
    const match = background.match(/\d+/g);
    if (!match) return true;
    const [r, g, b] = match.map(Number);
    // Rec. 601 luma, which is enough to answer a yes-or-no question.
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }

  /**
   * Coalesces redraws, and spaces them out while the document is changing.
   *
   * Two mechanisms because there are two problems. A frame's worth of
   * coalescing handles a burst — a window resize is a resize per frame, and
   * drawing each would be drawing the same picture before any of it is seen.
   *
   * The delay handles typing, and it is new with real glyphs: laying out
   * hundreds of text runs costs far more than the rectangles this used to
   * draw, and a keystroke does not change the shape of a file enough to be
   * worth it sixty times a second. The viewport box is not on this path — it
   * follows the scroll event directly — so nothing the eye tracks is delayed.
   */
  private schedule(urgent = false) {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.idle);
    if (urgent) {
      this.frame = requestAnimationFrame(() => this.draw());
      return;
    }
    this.idle = setTimeout(() => {
      this.frame = requestAnimationFrame(() => this.draw());
    }, REDRAW_DELAY);
  }

  private draw() {
    const height = this.wrap.clientHeight;
    const width = this.wrap.clientWidth;
    if (height <= 0 || width <= 0) return;
    this.mapHeight = height;
    this.barHeight = this.bar.clientHeight;

    const ratio = window.devicePixelRatio || 1;

    /*
      The backing store is `SUPERSAMPLE` times the element, and the element is
      sized by CSS — so the browser resamples on composite, for free and in
      hardware. That resample is what turns glyphs into miniature *text*
      rather than into noise, and it is the reason this does not need a font
      atlas of its own the way a from-scratch renderer would.
    */
    const scale = ratio * SUPERSAMPLE;
    const backingWidth = Math.round(width * scale);
    const backingHeight = Math.round(height * scale);
    // Only assigned when actually different: writing `width` clears the canvas
    // even when the value has not changed.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    // Drawing goes on in CSS pixels; the transform carries the supersample.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { doc } = this.view.state;
    const lines = doc.lines;

    /*
      The editor's own colour and typeface, read from the DOM rather than named
      here, so the map follows the theme and the font setting — a custom one
      included — without this file knowing anything about either.
    */
    const style = window.getComputedStyle(this.view.contentDOM);
    ctx.fillStyle = style.color;
    ctx.globalAlpha = MAX_ALPHA;
    ctx.textBaseline = "alphabetic";

    const rowHeight = Math.min(MAX_ROW, Math.max(MIN_ROW, height / lines));
    // One row per `step` lines, where `step` is whatever makes the file fit.
    const step = Math.max(1, Math.ceil((lines * MIN_ROW) / height));
    const columns = Math.max(1, Math.floor(width / COLUMN_WIDTH));

    /*
      The glyphs are as tall as the row and then squeezed to a pixel wide.

      A minimap cell is taller than it is wide — 1×2 at VS Code's default — and
      no font has that aspect, so the horizontal squash is not a shortcut but
      the shape of the thing. The factor is measured rather than assumed: it is
      whatever turns this font's advance into one column, which keeps the
      columns aligned under any monospace face the user picks.
    */
    const fontSize = Math.max(1, rowHeight);
    ctx.font = `${fontSize}px ${style.fontFamily}`;
    const advance = ctx.measureText("0").width || fontSize * 0.6;
    const squeeze = COLUMN_WIDTH / advance;

    ctx.save();
    ctx.scale(squeeze, 1);
    // Sat on the row's baseline rather than its top, which is where text sits.
    const baseline = fontSize * 0.8;
    // In squeezed space a column is this wide, so a segment at column N starts
    // here — the scale has already been applied to the axis.
    const columnStep = COLUMN_WIDTH / squeeze;

    const plain = style.color;
    const tree = this.tree();
    const highlighter = this.highlighter();
    let brush = plain;

    for (let number = 1; number <= lines; number += step) {
      const line = doc.line(number);
      if (!line.text.trim()) continue;
      const y = ((number - 1) / lines) * height;

      /*
        Colours for this line only, taken from the tree a line at a time.

        `highlightTree` accepts a range, which is what keeps this affordable:
        the alternative is walking every token in the document and asking which
        line each belongs to, and on a long file most of that work is thrown
        away because most lines are never drawn.
      */
      const spans: ColorSpan[] = [];
      if (tree) {
        highlightTree(
          tree,
          highlighter,
          (from, to, color) => spans.push({ from, to, color }),
          line.from,
          line.to
        );
      }

      for (const segment of lineSegments(line.text, line.from, spans, columns)) {
        const color = segment.color ?? plain;
        if (color !== brush) {
          brush = color;
          ctx.fillStyle = color;
        }
        ctx.fillText(segment.text, segment.column * columnStep, y + baseline);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
    this.place();
  }

  /**
   * The box over the part of the file on screen, and the scrollbar's thumb.
   *
   * Both are the same fraction of the same scroll metrics, which is what keeps
   * them in step with each other and with the content.
   */
  private place() {
    const { scrollTop, scrollHeight, clientHeight } = this.view.scrollDOM;
    if (scrollHeight <= 0) return;

    const visible = Math.min(1, clientHeight / scrollHeight);
    const range = Math.max(1, scrollHeight - clientHeight);
    const progress = Math.min(1, Math.max(0, scrollTop / range));

    /*
      Heights come from the resize observer rather than the elements.

      `clientHeight` forces the browser to flush layout, and this runs on every
      scroll event — so reading it here put a forced reflow in the middle of
      scrolling, which is the one place it is most expensive. They change only
      when the editor is resized, which is exactly what the observer reports.
    */
    const mapHeight = this.mapHeight;
    const boxHeight = Math.max(MIN_BOX_HEIGHT, visible * mapHeight);
    this.box.style.height = `${boxHeight}px`;
    this.box.style.transform = `translateY(${progress * (mapHeight - boxHeight)}px)`;

    const barHeight = this.barHeight;
    const thumbHeight = Math.max(MIN_THUMB_HEIGHT, visible * barHeight);
    this.thumb.style.height = `${thumbHeight}px`;
    this.thumb.style.transform = `translateY(${progress * (barHeight - thumbHeight)}px)`;

    // Nothing to scroll: a full-height thumb over a full-height track is
    // noise, so the bar steps out rather than sitting there inert.
    this.bar.classList.toggle("cm-minimap-bar-idle", visible >= 1);
  }

  /** Scrolls so the pointer's position down the rail becomes the view's. */
  private scrollFrom(clientY: number, target: HTMLElement, grab: number | null) {
    const rect = target.getBoundingClientRect();
    const fraction = (clientY - rect.top) / Math.max(1, rect.height);
    const { scrollHeight, clientHeight } = this.view.scrollDOM;
    /*
      Set directly rather than dispatched as a `scrollIntoView` effect. The
      effect centres a *position*, so a drag landed the cursor's line in the
      middle on every pointer move and the content jumped from one line to the
      next; this moves the same pixels the wheel would.
    */
    this.view.scrollDOM.scrollTop = scrollTopFor(
      fraction,
      scrollHeight,
      clientHeight,
      grab
    );
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    // The editor sits in a draggable modal; without this a press on the rail
    // starts dragging the window instead.
    e.preventDefault();
    e.stopPropagation();

    const onBar = this.bar.contains(e.target as Node);
    const indicator = onBar ? this.thumb : this.box;
    const rail = onBar ? this.bar : this.wrap;

    /*
      Taking hold of the indicator itself drags it; pressing the rail beside it
      jumps. Without the distinction, grabbing the middle of the thumb would
      snap it so its centre met the pointer — a visible lurch before the drag
      even starts.
    */
    const railRect = rail.getBoundingClientRect();
    const spot = indicator.getBoundingClientRect();
    const inside = e.clientY >= spot.top && e.clientY <= spot.bottom;
    const grab = inside
      ? (e.clientY - spot.top) / Math.max(1, railRect.height)
      : null;

    this.drag = { on: onBar ? "bar" : "map", grab };
    if (!inside) this.scrollFrom(e.clientY, rail, null);
    this.wrap.classList.add("cm-minimap-active");
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.drag) return;
    e.preventDefault();
    this.scrollFrom(e.clientY, this.drag.on === "bar" ? this.bar : this.wrap, this.drag.grab);
  };

  private readonly onPointerUp = () => {
    if (!this.drag) return;
    this.drag = null;
    this.wrap.classList.remove("cm-minimap-active");
  };
}

/**
 * The minimap, the bar beyond it, and the room they need.
 *
 * All together so that turning it off in the compartment takes the margin and
 * the hidden scrollbar with it — a scroller left with no bar and no map would
 * be an editor you could not drag-scroll at all.
 */
export function minimap(): Extension {
  return [
    ViewPlugin.fromClass(MinimapView),
    EditorView.theme({
      /*
        The positioning context both rails hang off. CodeMirror's base theme
        already makes this relative, so it is insurance rather than a fix — but
        an absolutely positioned child that escapes to the nearest positioned
        ancestor would land somewhere in the modal, and that is not worth
        leaving to an assumption about somebody else's stylesheet.
      */
      "&": { position: "relative" },

      /*
        Margin, not padding: padding on a scroll container travels with the
        content, so a long line would pass underneath the map on the way past.
        The margin takes the width out of the scroller altogether, which is the
        only arrangement where text can never be under it.

        The native bar goes with it — ours is drawn outside the map, and two
        scrollbars for one scroller is one too many.
      */
      ".cm-scroller": {
        marginRight: `${WIDTH + BAR_WIDTH}px`,
        scrollbarWidth: "none",
      },
      ".cm-scroller::-webkit-scrollbar": { display: "none" },

      ".cm-minimap": {
        position: "absolute",
        top: "0",
        bottom: "0",
        right: `${BAR_WIDTH}px`,
        width: `${WIDTH}px`,
        cursor: "pointer",
        zIndex: "1",
      },
      ".cm-minimap-canvas": { display: "block", width: "100%", height: "100%" },
      ".cm-minimap-box": {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        pointerEvents: "none",
      },

      ".cm-minimap-bar": {
        position: "absolute",
        top: "0",
        bottom: "0",
        right: "0",
        width: `${BAR_WIDTH}px`,
        zIndex: "1",
      },
      ".cm-minimap-thumb": {
        position: "absolute",
        top: "0",
        left: "2px",
        right: "2px",
        borderRadius: "3px",
      },
    }),
  ];
}
