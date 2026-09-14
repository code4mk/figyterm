/**
 * `/` to insert a block — the gesture the whole editor is organised around.
 *
 * Typing `/` at the start of an empty line opens a filterable list of block
 * types; typing narrows it, `↑`/`↓` move, `Enter` inserts, `Escape` dismisses.
 * All of that comes from Lexical's `LexicalTypeaheadMenuPlugin`, which owns the
 * keyboard and the anchoring; what lives here is the list of blocks, what each
 * one does, and how the menu looks.
 *
 * A query that matches nothing closes the menu rather than showing an empty
 * one: the plugin only mounts its portal while there is at least one option, so
 * there is no "no results" state to render into.
 *
 * The trigger deliberately does **not** fire mid-word: `and/or` is not a
 * command. `useBasicTypeaheadTriggerMatch` handles that, and the query is
 * capped so a stray `/` in a sentence stops matching after a word or two
 * instead of holding the menu open down the paragraph.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $createParagraphNode, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Table,
  Type,
} from "lucide-react";
import { scrollIntoViewWithin } from "../../../services/scroll";

/**
 * Sections, in the order they appear.
 *
 * Eleven flat rows is a list you read; three labelled groups is a list you
 * scan, and the labels are what let someone who has never opened the menu guess
 * where a block will be.
 */
type Group = "Basic" | "Lists" | "Advanced";

/** Replaces the current block with a new one of the given kind. */
function setBlock(editor: LexicalEditor, create: () => ReturnType<typeof $createParagraphNode>) {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) $setBlocksType(selection, create);
  });
}

class BlockOption extends MenuOption {
  constructor(
    public readonly title: string,
    public readonly hint: string,
    public readonly group: Group,
    public readonly glyph: React.ReactNode,
    /** Extra words that should match this block but are not in its name. */
    public readonly keywords: string[],
    public readonly run: (editor: LexicalEditor) => void
  ) {
    super(title);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildOptions(): BlockOption[] {
  return [
    new BlockOption("Text", "Plain paragraph", "Basic", <Type size={15} />, ["paragraph", "body"], (e) =>
      setBlock(e, () => $createParagraphNode() as any)
    ),
    new BlockOption("Heading 1", "Section title", "Basic", <Heading1 size={15} />, ["h1", "title", "big"], (e) =>
      setBlock(e, () => $createHeadingNode("h1") as any)
    ),
    new BlockOption("Heading 2", "Subsection", "Basic", <Heading2 size={15} />, ["h2", "subtitle"], (e) =>
      setBlock(e, () => $createHeadingNode("h2") as any)
    ),
    new BlockOption("Heading 3", "Minor heading", "Basic", <Heading3 size={15} />, ["h3"], (e) =>
      setBlock(e, () => $createHeadingNode("h3") as any)
    ),
    new BlockOption("To-do list", "Track tasks", "Lists", <ListTodo size={15} />, ["todo", "task", "check", "checkbox"], (e) =>
      e.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)
    ),
    new BlockOption("Bulleted list", "Unordered list", "Lists", <List size={15} />, ["ul", "bullet", "point"], (e) =>
      e.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
    ),
    new BlockOption("Numbered list", "Ordered list", "Lists", <ListOrdered size={15} />, ["ol", "number", "step"], (e) =>
      e.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
    ),
    new BlockOption("Table", "3 × 3 grid", "Advanced", <Table size={15} />, ["grid", "row", "column", "cell"], (e) =>
      // A header row and three columns: the shape almost every notes table
      // starts as, and one that is quick to cut down.
      e.dispatchCommand(INSERT_TABLE_COMMAND, { columns: "3", rows: "3", includeHeaders: true })
    ),
    new BlockOption("Quote", "Call something out", "Advanced", <Quote size={15} />, ["blockquote", "cite"], (e) =>
      setBlock(e, () => $createQuoteNode() as any)
    ),
    new BlockOption("Code", "Code block", "Advanced", <Code2 size={15} />, ["snippet", "pre", "monospace"], (e) =>
      setBlock(e, () => $createCodeNode() as any)
    ),
    new BlockOption("Divider", "Horizontal rule", "Advanced", <Minus size={15} />, ["hr", "rule", "separator", "line"], (e) =>
      e.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)
    ),
  ];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function SlashMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);

  const all = useMemo(buildOptions, []);

  const options = useMemo(() => {
    if (!query) return all;
    const needle = query.toLowerCase();
    // Name first, then keywords — so `/co` offers Code before it offers
    // anything that merely mentions code in its synonyms.
    return all.filter(
      (option) =>
        option.title.toLowerCase().includes(needle) ||
        option.keywords.some((word) => word.includes(needle))
    );
  }, [all, query]);

  // `minLength: 0` so the menu appears the moment `/` is typed rather than
  // after a character of query, which is what makes it feel like a menu and
  // not like a search box.
  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0, maxLength: 24 });

  const onSelectOption = useCallback(
    (option: BlockOption, nodeToRemove: { remove: () => void } | null, closeMenu: () => void) => {
      // The typed `/heading` has to go before the block is replaced, or it ends
      // up as the first line of the block it asked for.
      editor.update(() => {
        nodeToRemove?.remove();
      });
      option.run(editor);
      closeMenu();
    },
    [editor]
  );

  return (
    <LexicalTypeaheadMenuPlugin<BlockOption>
      options={options}
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      // The plugin portals its anchor into `document.body` and styles it
      // `position: absolute` with **no z-index**. The drawing window is an
      // overlay sitting at z-index 250-odd, so without a class of our own the
      // menu renders correctly and is painted underneath the window — present
      // in the DOM, invisible on screen, and apparently broken.
      anchorClassName="drawing-slash-anchor"
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
        if (!anchorRef.current) return null;
        return createPortal(
          <SlashMenu
            options={options}
            selectedIndex={selectedIndex}
            onPick={selectOptionAndCleanUp}
            onHighlight={setHighlightedIndex}
            query={query}
          />,
          anchorRef.current
        );
      }}
    />
  );
}

/**
 * The menu itself.
 *
 * A component rather than markup inlined into `menuRenderFn`, because keeping
 * the selected row in view needs a ref and an effect, and `menuRenderFn` is a
 * callback — hooks cannot live there.
 */
function SlashMenu({
  options,
  selectedIndex,
  onPick,
  onHighlight,
  query,
}: {
  options: BlockOption[];
  selectedIndex: number | null;
  onPick: (option: BlockOption) => void;
  onHighlight: (index: number) => void;
  query: string | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Arrowing past the bottom of the list has to bring the row with it.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${selectedIndex}"]`);
    scrollIntoViewWithin(listRef.current, row);
  }, [selectedIndex]);

  return (
    <div className="drawing-slash-menu" role="listbox" aria-label="Insert block">
      <div ref={listRef} className="drawing-slash-list">
        {options.map((option, index) => {
          // Headings are derived from runs in the list, so a filtered list
          // shows only the groups it still has anything in.
          const startsGroup = index === 0 || options[index - 1].group !== option.group;
          return (
            <div key={option.key}>
              {startsGroup && <div className="drawing-slash-group">{option.group}</div>}
              <button
                data-row={index}
                role="option"
                aria-selected={index === selectedIndex}
                className={`drawing-slash-item ${index === selectedIndex ? "selected" : ""}`}
                // `mousedown` rather than `click`: a click would first move
                // focus out of the editor and collapse the selection the
                // insertion depends on.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onHighlight(index);
                  onPick(option);
                }}
                onMouseEnter={() => onHighlight(index)}
              >
                <span className="drawing-slash-icon">{option.glyph}</span>
                <span className="drawing-slash-text">
                  <span className="drawing-slash-title">{option.title}</span>
                  <span className="drawing-slash-hint">{option.hint}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* The keys are the point: the menu is driven from the keyboard, and
          saying so is what stops people reaching for the mouse. */}
      <div className="drawing-slash-footer">
        <span className="drawing-slash-filter">
          {query ? (
            <>
              Filtering <strong>{query}</strong>
            </>
          ) : (
            "Type to filter"
          )}
        </span>
        <span className="drawing-slash-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <kbd>↵</kbd>
        </span>
      </div>
    </div>
  );
}
