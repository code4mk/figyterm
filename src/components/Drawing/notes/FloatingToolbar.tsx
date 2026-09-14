/**
 * The formatting bar that appears over a text selection.
 *
 * The other half of the no-toolbar decision: there is no permanent strip of
 * buttons above the document, because for a pane this size that is chrome you
 * pay for on every line whether or not you are formatting. Instead the controls
 * come to the selection and leave when it does.
 *
 * Positioned against the pane rather than the viewport, so it scrolls with the
 * text and cannot escape the modal. It clamps to the pane's left edge, which is
 * what stops it hanging off the side when you select something near the margin.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type TextFormatType,
} from "lexical";
import { Bold, Code, Italic, Link2, Strikethrough } from "lucide-react";

/** Distance above the selection, leaving room for the bar not to cover the text. */
const GAP = 8;

interface Placement {
  top: number;
  left: number;
  /** False when the bar had to go under the selection instead of over it. */
  above: boolean;
}

interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: boolean;
}

const NO_FORMATS: ActiveFormats = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
  link: false,
};

export function FloatingToolbarPlugin({ anchor }: { anchor: HTMLElement | null }) {
  const [editor] = useLexicalComposerContext();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [formats, setFormats] = useState<ActiveFormats>(NO_FORMATS);
  const barRef = useRef<HTMLDivElement>(null);

  const update = useCallback(() => {
    const selection = $getSelection();

    // Collapsed selections, non-text selections and a blurred editor all mean
    // there is nothing to format.
    if (
      !anchor ||
      !$isRangeSelection(selection) ||
      selection.isCollapsed() ||
      !editor.isEditable()
    ) {
      setPlacement(null);
      return;
    }

    const native = window.getSelection();
    if (!native || native.rangeCount === 0) {
      setPlacement(null);
      return;
    }

    const rect = native.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPlacement(null);
      return;
    }

    const host = anchor.getBoundingClientRect();
    const width = barRef.current?.offsetWidth ?? 0;
    const height = barRef.current?.offsetHeight ?? 28;

    // Coordinates are relative to the pane, and the pane scrolls, so the
    // scroll offset goes back in — otherwise the bar sits where the selection
    // *was* on screen rather than where it is in the document.
    const contentTop = rect.top - host.top + anchor.scrollTop;

    // Drawn with `translateY(-100%)`, so selecting on the first line would put
    // it at a negative offset in a pane that clips its overflow: correctly
    // placed and invisible. Below the selection when there is no room above.
    const above = contentTop >= height + GAP;

    const centred = rect.left - host.left + rect.width / 2 - width / 2;
    const left = Math.max(8, Math.min(centred, host.width - width - 8));

    setPlacement({
      top: above ? contentTop - GAP : contentTop + rect.height + GAP,
      left,
      above,
    });

    const node = selection.anchor.getNode();
    const parent = node.getParent();
    setFormats({
      bold: selection.hasFormat("bold"),
      italic: selection.hasFormat("italic"),
      strikethrough: selection.hasFormat("strikethrough"),
      code: selection.hasFormat("code"),
      link: $isLinkNode(parent) || $isLinkNode(node),
    });
  }, [anchor, editor]);

  useEffect(() => {
    // `editor.read` rather than `getEditorState().read`: the latter activates a
    // state but no editor, and any helper that needs the editor throws.
    const read = () => editor.read(update);

    // Two sources, because neither is sufficient: Lexical's command covers
    // keyboard selection, and the document event covers a drag that ends
    // outside the editor.
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        read();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    const unregisterUpdate = editor.registerUpdateListener(read);
    document.addEventListener("selectionchange", read);

    return () => {
      unregister();
      unregisterUpdate();
      document.removeEventListener("selectionchange", read);
    };
  }, [editor, update]);

  const format = (type: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, type);

  const toggleLink = () => {
    if (formats.link) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = window.prompt("Link to");
    if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
  };

  if (!placement) return null;

  return (
    <div
      ref={barRef}
      className={`drawing-note-toolbar ${placement.above ? "above" : ""}`}
      style={{ top: placement.top, left: placement.left }}
      // Keeps the selection alive: taking focus would collapse it and there
      // would be nothing left to embolden.
      onMouseDown={(e) => e.preventDefault()}
    >
      <ToolbarButton active={formats.bold} onClick={() => format("bold")} title="Bold  ⌘B">
        <Bold size={12} />
      </ToolbarButton>
      <ToolbarButton active={formats.italic} onClick={() => format("italic")} title="Italic  ⌘I">
        <Italic size={12} />
      </ToolbarButton>
      <ToolbarButton
        active={formats.strikethrough}
        onClick={() => format("strikethrough")}
        title="Strikethrough"
      >
        <Strikethrough size={12} />
      </ToolbarButton>
      <ToolbarButton active={formats.code} onClick={() => format("code")} title="Inline code">
        <Code size={12} />
      </ToolbarButton>
      <span className="drawing-note-toolbar-sep" />
      <ToolbarButton active={formats.link} onClick={toggleLink} title="Link">
        <Link2 size={12} />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`drawing-note-toolbar-btn ${active ? "active" : ""}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
