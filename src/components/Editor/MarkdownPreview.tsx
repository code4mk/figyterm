import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ListTree } from "lucide-react";
import { Markdown } from "../Updates/Markdown";
import { MarkdownOutline } from "./MarkdownOutline";

/**
 * Live preview for the Markdown buffer being edited.
 *
 * It renders whatever CodeMirror currently holds, not what's on disk, so the
 * preview follows the edit rather than the save — which is the whole point of
 * having it beside the editor. The modal debounces the text it passes in; see
 * `previewSource` there.
 *
 * The renderer is the same one the update modal uses for release notes, in its
 * `document` variant: no `dangerouslySetInnerHTML` anywhere, so a file
 * containing a `<script>` tag previews as the text `<script>`.
 *
 * ## Scroll sync
 *
 * `Markdown` stamps every heading with the source line it came from, and those
 * anchors are the whole mechanism: to find where line 120 renders, look up the
 * headings either side of it and interpolate between their offsets. Mapping by
 * plain proportion — scroll fraction to line fraction — drifts badly on real
 * documents, where a fenced code block occupies many lines and little height
 * while a table is the reverse.
 */

export interface MarkdownPreviewHandle {
  /** Scrolls so the content for `line` sits at the top. */
  scrollToLine: (line: number, smooth?: boolean) => void;
  /** The source line currently at the top of the preview. */
  topLine: () => number | null;
}

/** Below this, the rail would leave the prose too narrow to read. */
const MIN_WIDTH_FOR_OUTLINE = 520;

/** Narrow enough to leave the document the bulk of the pane. */
const OUTLINE_WIDTH = 190;

interface MarkdownPreviewProps {
  source: string;
  /** Shown above the document, so it's clear which file is being previewed. */
  name: string;
  /** The first visible source line, on every scroll. Throttled to a frame. */
  onScrollLine: (line: number) => void;
  /** Marked in the outline as the reader's place. */
  activeLine: number;
  /** Called when an outline entry is picked. */
  onSelectHeading: (line: number) => void;
  /** Follows a link that isn't `http(s)` — a sibling file or an in-page anchor. */
  onFollowLink: (href: string) => void;
}

interface Anchor {
  line: number;
  top: number;
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(
  function MarkdownPreview(
    { source, name, onScrollLine, activeLine, onSelectHeading, onFollowLink },
    ref
  ) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const paneRef = useRef<HTMLDivElement>(null);
    const [outlineWanted, setOutlineWanted] = useState(true);
    const [wideEnough, setWideEnough] = useState(true);
    const handlers = useRef({ onScrollLine });
    handlers.current = { onScrollLine };

    /**
     * Every rendered heading's source line and offset, in document order.
     *
     * Read from the DOM on demand rather than cached: the preview re-renders on
     * a debounce while typing, and a cache would be stale exactly when someone
     * is editing headings.
     */
    const anchors = useCallback((): Anchor[] => {
      const body = bodyRef.current;
      if (!body) return [];
      const bodyTop = body.getBoundingClientRect().top - body.scrollTop;
      return Array.from(body.querySelectorAll("[data-md-line]")).map((el) => ({
        line: Number(el.getAttribute("data-md-line")),
        top: el.getBoundingClientRect().top - bodyTop,
      }));
    }, []);

    useImperativeHandle(
      ref,
      (): MarkdownPreviewHandle => ({
        scrollToLine: (line, smooth = false) => {
          const body = bodyRef.current;
          if (!body) return;

          const found = anchors();
          if (found.length === 0) {
            // Nothing to anchor to — a document with no headings falls back to
            // proportion, which is all the information there is.
            body.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
            return;
          }

          let before = found[0];
          let after: Anchor | null = null;
          for (const anchor of found) {
            if (anchor.line <= line) before = anchor;
            else {
              after = anchor;
              break;
            }
          }

          let top = before.top;
          if (after && after.line > before.line) {
            // Interpolated between the two headings, so scrolling through a
            // long section moves the preview steadily rather than in jumps.
            const ratio = (line - before.line) / (after.line - before.line);
            top = before.top + ratio * (after.top - before.top);
          }

          body.scrollTo({
            top: Math.max(0, top),
            behavior: smooth ? "smooth" : "auto",
          });
        },

        topLine: () => {
          const body = bodyRef.current;
          if (!body) return null;
          const found = anchors();
          if (found.length === 0) return null;

          const offset = body.scrollTop;
          let before = found[0];
          let after: Anchor | null = null;
          for (const anchor of found) {
            if (anchor.top <= offset + 1) before = anchor;
            else {
              after = anchor;
              break;
            }
          }

          if (after && after.top > before.top) {
            const ratio = (offset - before.top) / (after.top - before.top);
            return Math.round(before.line + ratio * (after.line - before.line));
          }
          return before.line;
        },
      }),
      [anchors]
    );

    // Reports the top line as the preview is scrolled, coalesced to a frame.
    useEffect(() => {
      const body = bodyRef.current;
      if (!body) return;

      let frame = 0;
      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const found = anchors();
          if (found.length === 0) return;

          const offset = body.scrollTop;
          let before = found[0];
          let after: Anchor | null = null;
          for (const anchor of found) {
            if (anchor.top <= offset + 1) before = anchor;
            else {
              after = anchor;
              break;
            }
          }
          const line =
            after && after.top > before.top
              ? Math.round(
                  before.line +
                    ((offset - before.top) / (after.top - before.top)) *
                      (after.line - before.line)
                )
              : before.line;
          handlers.current.onScrollLine(line);
        });
      };

      body.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        if (frame) cancelAnimationFrame(frame);
        body.removeEventListener("scroll", onScroll);
      };
    }, [anchors]);

    /*
      The rail is dropped when the pane is too narrow for both, rather than
      squeezing the prose to a column. Watched rather than assumed: the preview
      is user-resizable and lives in a modal that itself resizes.
    */
    useEffect(() => {
      const pane = paneRef.current;
      if (!pane) return;
      const observer = new ResizeObserver(() => {
        setWideEnough(pane.clientWidth >= MIN_WIDTH_FOR_OUTLINE);
      });
      observer.observe(pane);
      setWideEnough(pane.clientWidth >= MIN_WIDTH_FOR_OUTLINE);
      return () => observer.disconnect();
    }, []);

    const showOutline = outlineWanted && wideEnough;

    return (
      <div ref={paneRef} className="editor-preview flex flex-col h-full min-h-0">
        <div className="editor-preview-head flex items-center gap-1.5 px-3 h-[26px] shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-wide">Preview</span>
          <span className="editor-preview-name text-[10px] truncate flex-1">{name}</span>
          {wideEnough && (
            <button
              className={`editor-icon-btn p-0.5 rounded shrink-0 ${
                showOutline ? "on" : ""
              }`}
              onClick={() => setOutlineWanted((want) => !want)}
              title={showOutline ? "Hide the outline" : "Show the outline"}
              aria-pressed={showOutline}
            >
              <ListTree size={12} />
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 flex">
          <div
            ref={bodyRef}
            className="editor-preview-body flex-1 min-w-0 min-h-0 overflow-y-auto px-5 py-4"
          >
            {source.trim() ? (
              /*
                Uncapped: the measure used to be limited to 68 characters, which
                made sense when the pane was only prose and left a dead strip
                down the right once the outline moved in here. The outline is
                that strip now, so the document takes the rest.
              */
              <Markdown source={source} variant="document" onFollowLink={onFollowLink} />
            ) : (
              <div className="editor-preview-empty text-[11px]">Nothing to preview yet.</div>
            )}
          </div>

          {showOutline && (
            <div
              className="editor-preview-rail shrink-0 min-h-0"
              style={{ width: OUTLINE_WIDTH }}
            >
              <MarkdownOutline
                source={source}
                activeLine={activeLine}
                onSelect={onSelectHeading}
                onClose={() => setOutlineWanted(false)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
);
