/**
 * The other half of a project: what the drawing is *about*.
 *
 * A Lexical rich-text editor, sharing the canvas's shape exactly — handed a
 * project id, loads that project's document, reports changes back through the
 * store, and knows nothing about the project list. The same two rules that keep
 * the canvas honest apply here for the same reasons:
 *
 * - **The document is awaited before the editor mounts.** Lexical reads
 *   `initialConfig.editorState` once, when the composer is created; there is no
 *   second chance to hand it the content, so the pane holds its frame until the
 *   read lands.
 * - **A flush writes what `onChange` last reported.** See `useAutosave`.
 *
 * The editing model is Notion's, assembled from Lexical's own plugins:
 *
 * | Gesture | What it does |
 * |---|---|
 * | `/` | Opens the block menu — headings, lists, to-dos, quote, code, table, divider |
 * | Select text | A formatting bar comes to the selection |
 * | Hover a block | A grip appears in the margin; drag it to reorder |
 * | Hover a table | Column and row grips, and `+` on the right and bottom |
 * | `# `, `- `, `1. `, `> `, `` ` `` | Markdown shortcuts, for the keyboard-only path |
 *
 * There is no permanent toolbar above the document. For a pane this size that
 * is chrome you pay for on every line whether or not you are formatting, and
 * the two things it would hold — insert a block, format a selection — already
 * have a home that appears exactly when it is wanted.
 *
 * The three floating pieces live in `./notes/` and are all positioned against
 * the scrolling pane rather than the viewport, so they travel with the text and
 * cannot escape the modal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
// 0.50 marks these deprecated in favour of `HorizontalRuleExtension` in
// `@lexical/extension`. That belongs to Lexical's new extension architecture,
// which replaces `LexicalComposer` and every plugin here — a migration worth
// doing on its own terms, not as a side effect of wanting a divider. The plugin
// works; this is the one import to revisit when the rest moves.
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { TRANSFORMERS } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { $getRoot, type EditorState } from "lexical";
import { useDrawingStore } from "../../stores/drawingStore";
import { useAutosave } from "./useAutosave";
import { SlashMenuPlugin } from "./notes/SlashMenu";
import { FloatingToolbarPlugin } from "./notes/FloatingToolbar";
import { DragHandlePlugin } from "./notes/DragHandle";
import { TableControlsPlugin } from "./notes/TableControls";

interface DrawingNotesProps {
  projectId: string;
}

/** What one save needs. `state` doubles as the change mark — see `DrawingDoc`. */
interface NoteSnapshot {
  state: string;
  text: string;
}

/**
 * Class names Lexical hangs on the nodes it renders.
 *
 * Everything resolves to `.drawing-note-*` rules in `styles.css`, which are
 * written against the `--ft-*` tokens so the prose follows the app's theme
 * without a second palette.
 */
const THEME = {
  paragraph: "drawing-note-p",
  quote: "drawing-note-quote",
  heading: {
    h1: "drawing-note-h1",
    h2: "drawing-note-h2",
    h3: "drawing-note-h3",
  },
  list: {
    ul: "drawing-note-ul",
    ol: "drawing-note-ol",
    listitem: "drawing-note-li",
    nested: { listitem: "drawing-note-li-nested" },
    // The to-do list. Lexical draws the box itself from these classes; the
    // rules for them are in `styles.css`.
    listitemChecked: "drawing-note-check checked",
    listitemUnchecked: "drawing-note-check",
  },
  hr: "drawing-note-hr",
  table: "drawing-note-table",
  tableRow: "drawing-note-tr",
  tableCell: "drawing-note-td",
  tableCellHeader: "drawing-note-th",
  tableSelected: "drawing-note-table-selected",
  tableCellSelected: "drawing-note-td-selected",
  link: "drawing-note-link",
  code: "drawing-note-code-block",
  text: {
    bold: "drawing-note-bold",
    italic: "drawing-note-italic",
    strikethrough: "drawing-note-strike",
    code: "drawing-note-code",
  },
};

/** Every node type the transformers below can produce must be registered. */
const NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  CodeNode,
  CodeHighlightNode,
  HorizontalRuleNode,
  TableNode,
  TableRowNode,
  TableCellNode,
];

export function DrawingNotes({ projectId }: DrawingNotesProps) {
  const loadDoc = useDrawingStore((s) => s.loadDoc);
  const persistDoc = useDrawingStore((s) => s.persistDoc);

  /**
   * `undefined` while reading, then the serialised state or `null` for a
   * document that does not exist yet. The distinction matters: `null` is a
   * valid initial state for Lexical (an empty editor), so it cannot double as
   * "still loading".
   */
  const [initialState, setInitialState] = useState<string | null | undefined>(undefined);
  /**
   * The scrolling pane, which the slash menu, the toolbar and the drag handle
   * are all positioned against.
   *
   * State rather than a ref because they must re-render once it exists — a ref
   * assignment alone would leave them measuring `null` forever.
   */
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);

  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const autosave = useAutosave<NoteSnapshot>({
    mark: (snapshot) => snapshot.state,
    write: ({ state, text }) => void persistDoc(projectRef.current, state, text),
  });

  useEffect(() => {
    let cancelled = false;
    setInitialState(undefined);
    autosave.reset();

    void loadDoc(projectId).then((doc) => {
      if (cancelled) return;
      setInitialState(doc?.state ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, loadDoc, autosave]);

  const handleChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        autosave.record({
          state: JSON.stringify(editorState.toJSON()),
          // Stored beside the state so the rail can mark a project as having
          // notes without parsing the node tree back out.
          text: $getRoot().getTextContent(),
        });
      });
    },
    [autosave]
  );

  if (initialState === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[11px] text-ft-text-muted">
        Opening…
      </div>
    );
  }

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "figy-drawing-notes",
        theme: THEME,
        nodes: NODES,
        editorState: initialState,
        // A document that will not deserialise must not take the window down
        // with it. The pane recovers empty and the stored copy is left alone.
        onError: (error: Error) => console.error("Notes editor:", error),
      }}
    >
      {/*
        Typing must not reach the shell's shortcut handler: `⌘⇧X` in a
        paragraph is an X. Escape is deliberately let through — it belongs to
        the window, and closing it flushes on the way out.
      */}
      <div
        ref={setAnchor}
        className="drawing-notes relative h-full w-full overflow-y-auto"
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
        onPaste={(e) => e.stopPropagation()}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="drawing-note-input min-h-full outline-none"
              aria-label="Project notes"
            />
          }
          placeholder={
            <div className="drawing-note-placeholder pointer-events-none absolute select-none text-ft-text-muted">
              Write what this drawing is for, or press / for blocks…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        {/* Cell merging and row/column striping are off: this is a notes table,
            not a spreadsheet, and every extra affordance is another thing to
            style and keep working inside a modal. */}
        <TablePlugin hasCellMerge={false} hasCellBackgroundColor={false} />
        <LinkPlugin />
        <HorizontalRulePlugin />
        <TabIndentationPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <SlashMenuPlugin />
        <FloatingToolbarPlugin anchor={anchor} />
        <DragHandlePlugin anchor={anchor} />
        <TableControlsPlugin anchor={anchor} />
        {/* `ignoreSelectionChange` keeps a moving cursor from looking like an
            edit, which would otherwise schedule a write on every arrow key. */}
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      </div>
    </LexicalComposer>
  );
}
