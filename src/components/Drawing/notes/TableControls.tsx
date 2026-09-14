/**
 * Notion's table chrome: a grip over every column, a grip beside every row, and
 * a `+` on the right and bottom edges.
 *
 * ```
 *      ┌────┬────┬────┐        ← column grips
 *    ┌ ├────┼────┼────┤ ┐
 *    │ │    │    │    │ │ +    ← add a column
 *    │ ├────┼────┼────┤ │
 *    └ └────┴────┴────┘ ┘
 *      └────── + ──────┘       ← add a row
 * ```
 *
 * Clicking a grip selects that row or column and opens its menu — insert either
 * side, delete, or delete the table. The `+` edges add at the end without a
 * menu, which is the common case and should not cost a click more than it has
 * to.
 *
 * Everything is an overlay measured from the table's own DOM. Nothing is
 * injected into the document, so the serialised note holds a plain table and
 * none of this chrome.
 *
 * The actions are node- and index-addressed (`$insertTableColumnAtNode`,
 * `$removeTableRowAtIndex`) rather than selection-based: a grip acts on the row
 * or column you pointed at, which is not necessarily the one the cursor happens
 * to be in. Column deletion is the exception — see `deleteColumn`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $deleteTableColumnAtSelection,
  $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $insertTableColumnAtNode,
  $insertTableRowAtNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  $removeTableRowAtIndex,
  type TableCellNode,
  type TableNode,
} from "@lexical/table";
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";

/**
 * Thickness of a grip.
 *
 * Deliberately thin: a grip is drawn as a thickened gridline in the table's own
 * border colour, so it reads as part of the table. Making it button-sized makes
 * it a toolbar parked against the edge.
 */
const GRIP = 7;
/** Thickness of the `+` strips, which do need a target you can hit. */
const ADD = 13;
/** Space between the table and its chrome. */
const GAP = 4;

interface Band {
  /** Offset along the axis, from the table's own top-left. */
  start: number;
  size: number;
}

interface Frame {
  tableKey: string;
  /** The table's position in the pane's content coordinates. */
  top: number;
  left: number;
  width: number;
  height: number;
  columns: Band[];
  rows: Band[];
}

type MenuTarget = { axis: "row" | "column"; index: number; top: number; left: number };

/** An element's position in `container`'s content coordinates — no scroll term. */
function offsetWithin(element: HTMLElement, container: HTMLElement): { top: number; left: number } | null {
  let top = 0;
  let left = 0;
  let node: HTMLElement | null = element;
  while (node && node !== container) {
    top += node.offsetTop;
    left += node.offsetLeft;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === container ? { top, left } : null;
}

/**
 * Column and row bands, read off the rendered table.
 *
 * Measured with rectangles rather than `offsetLeft`, because a `<td>`'s offset
 * parent is not reliably the table and the difference is silent.
 */
function measure(table: HTMLTableElement, anchor: HTMLElement, tableKey: string): Frame | null {
  const offset = offsetWithin(table, anchor);
  const firstRow = table.rows[0];
  if (!offset || !firstRow) return null;

  const tableRect = table.getBoundingClientRect();

  const columns: Band[] = Array.from(firstRow.cells).map((cell) => {
    const rect = cell.getBoundingClientRect();
    return { start: rect.left - tableRect.left, size: rect.width };
  });

  const rows: Band[] = Array.from(table.rows).map((row) => {
    const rect = row.getBoundingClientRect();
    return { start: rect.top - tableRect.top, size: rect.height };
  });

  return {
    tableKey,
    top: offset.top,
    left: offset.left,
    width: table.offsetWidth,
    height: table.offsetHeight,
    columns,
    rows,
  };
}

export function TableControlsPlugin({ anchor }: { anchor: HTMLElement | null }) {
  const [editor] = useLexicalComposerContext();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /** Bumped by anything that can change the table's geometry. */
  const [version, setVersion] = useState(0);

  /** The table under the pointer, and the table holding the cursor. Either one
   * is reason enough to show the chrome; the pointer wins when both apply. */
  const hoveredRef = useRef<HTMLTableElement | null>(null);
  const [hovered, setHovered] = useState<HTMLTableElement | null>(null);
  const [selected, setSelected] = useState<HTMLTableElement | null>(null);

  // ─── Which table ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!anchor) return;

    const onPointerMove = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Moving onto the chrome itself must not read as leaving the table, or
      // the grips vanish the moment you reach for one.
      if (target.closest(".drawing-tbl-layer")) return;

      const table = target.closest("table");
      const next = table instanceof HTMLTableElement ? table : null;
      if (next !== hoveredRef.current) {
        hoveredRef.current = next;
        setHovered(next);
      }
    };

    const onPointerLeave = () => {
      hoveredRef.current = null;
      setHovered(null);
    };

    anchor.addEventListener("pointermove", onPointerMove);
    anchor.addEventListener("pointerleave", onPointerLeave);
    return () => {
      anchor.removeEventListener("pointermove", onPointerMove);
      anchor.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [anchor]);

  useEffect(() => {
    const read = () =>
      // `editor.read` throughout, for the reason given on `tableKeyFor`.
      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) && !$isTableSelection(selection)) {
          setSelected(null);
          return;
        }
        const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
        if (!cell) {
          setSelected(null);
          return;
        }
        const key = $getTableNodeFromLexicalNodeOrThrow(cell).getKey();
        const element = editor.getElementByKey(key);
        setSelected(element instanceof HTMLTableElement ? element : null);
      });

    const unregisterCommand = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        read();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    // Also on every update: a new row changes every measurement below it.
    const unregisterUpdate = editor.registerUpdateListener(() => {
      read();
      setVersion((v) => v + 1);
    });

    return () => {
      unregisterCommand();
      unregisterUpdate();
    };
  }, [editor]);

  const target = hovered ?? selected;

  // ─── Geometry ────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    if (!anchor || !target) {
      setFrame(null);
      setMenu(null);
      return;
    }

    // The node key is recovered from the element rather than carried alongside
    // it, so a frame can never describe a table that has since been replaced.
    const tableKey = tableKeyFor(editor, target);
    if (!tableKey) {
      setFrame(null);
      return;
    }

    setFrame(measure(target, anchor, tableKey));
  }, [anchor, target, editor, version]);

  // A window resize reflows the table and every band with it.
  useEffect(() => {
    const onResize = () => setVersion((v) => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ─── Actions ─────────────────────────────────────────────────────────────

  /** Runs `mutate` against the table this frame describes. */
  const withTable = useCallback(
    (mutate: (table: TableNode) => void) => {
      if (!frame) return;
      editor.update(() => {
        const node = $getNodeByKey(frame.tableKey);
        if ($isTableNode(node)) mutate(node);
      });
      setMenu(null);
    },
    [editor, frame]
  );

  /** Any cell in a given column, which is what the insert helpers address. */
  const cellInColumn = (table: TableNode, column: number): TableCellNode | null => {
    const row = table.getChildren()[0];
    if (!$isTableRowNode(row)) return null;
    const cell = row.getChildren()[column];
    return $isTableCellNode(cell) ? cell : null;
  };

  const cellInRow = (table: TableNode, rowIndex: number): TableCellNode | null => {
    const row = table.getChildren()[rowIndex];
    if (!$isTableRowNode(row)) return null;
    const cell = row.getChildren()[0];
    return $isTableCellNode(cell) ? cell : null;
  };

  const insertColumn = (index: number, after: boolean) =>
    withTable((table) => {
      const cell = cellInColumn(table, index);
      if (cell) $insertTableColumnAtNode(cell, after, false);
    });

  const insertRow = (index: number, after: boolean) =>
    withTable((table) => {
      const cell = cellInRow(table, index);
      if (cell) $insertTableRowAtNode(cell, after);
    });

  /**
   * Deleted by putting the caret in the column first.
   *
   * `$deleteTableColumn(table, index)` would say it more directly but is
   * deprecated in 0.50; the supported helper reads the selection, so the
   * selection is what gets pointed at the column the grip belongs to.
   */
  const deleteColumn = (index: number) =>
    withTable((table) => {
      const cell = cellInColumn(table, index);
      if (!cell) return;
      cell.selectStart();
      $deleteTableColumnAtSelection();
    });
  const deleteRow = (index: number) => withTable((table) => $removeTableRowAtIndex(table, index));
  const deleteTable = () => withTable((table) => table.remove());

  if (!anchor || !frame) return null;

  const { top, left, width, height, columns, rows } = frame;

  return (
    <div
      className="drawing-tbl-layer"
      // The layer is chrome, not content: it must never take the caret out of
      // the cell being edited.
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Column grips */}
      {columns.map((column, index) => (
        <button
          key={`c${index}`}
          className={`drawing-tbl-grip col ${menu?.axis === "column" && menu.index === index ? "open" : ""}`}
          style={{
            top: top - GRIP - GAP,
            // Inset by a pixel so neighbouring grips read as separate bars
            // rather than as one unbroken rule across the table.
            left: left + column.start + 1,
            width: Math.max(4, column.size - 2),
            height: GRIP,
          }}
          title="Column options"
          aria-label={`Column ${index + 1} options`}
          onClick={() =>
            setMenu({
              axis: "column",
              index,
              top: top - GRIP - GAP,
              left: left + column.start,
            })
          }
        />
      ))}

      {/* Row grips */}
      {rows.map((row, index) => (
        <button
          key={`r${index}`}
          className={`drawing-tbl-grip row ${menu?.axis === "row" && menu.index === index ? "open" : ""}`}
          style={{
            top: top + row.start + 1,
            left: left - GRIP - GAP,
            width: GRIP,
            height: Math.max(4, row.size - 2),
          }}
          title="Row options"
          aria-label={`Row ${index + 1} options`}
          onClick={() =>
            setMenu({ axis: "row", index, top: top + row.start, left: left - GRIP - GAP })
          }
        />
      ))}

      {/* Add a column on the right */}
      <button
        className="drawing-tbl-add col"
        style={{ top, left: left + width + GAP, width: ADD, height }}
        title="Add column"
        aria-label="Add column"
        onClick={() => insertColumn(columns.length - 1, true)}
      >
        <Plus size={10} />
      </button>

      {/* Add a row underneath */}
      <button
        className="drawing-tbl-add row"
        style={{ top: top + height + GAP, left, width, height: ADD }}
        title="Add row"
        aria-label="Add row"
        onClick={() => insertRow(rows.length - 1, true)}
      >
        <Plus size={10} />
      </button>

      {/* Where the two strips meet. Adds both at once, which is Notion's
          corner and the quickest way to grow a table diagonally. */}
      <button
        className="drawing-tbl-corner"
        style={{ top: top + height + GAP, left: left + width + GAP, width: ADD, height: ADD }}
        title="Add row and column"
        aria-label="Add row and column"
        onClick={() => {
          insertColumn(columns.length - 1, true);
          insertRow(rows.length - 1, true);
        }}
      >
        <Plus size={9} />
      </button>

      {menu && (
        <>
          {/* Click-away. Transparent, and under the menu. */}
          <div className="drawing-tbl-scrim" onClick={() => setMenu(null)} />
          <div
            className="drawing-tbl-menu"
            style={{ top: menu.top + GRIP + 4, left: menu.left }}
            role="menu"
          >
            {menu.axis === "column" ? (
              <>
                <MenuItem icon={<ArrowLeft size={11} />} label="Insert left" onClick={() => insertColumn(menu.index, false)} />
                <MenuItem icon={<ArrowRight size={11} />} label="Insert right" onClick={() => insertColumn(menu.index, true)} />
                <span className="drawing-tbl-menu-sep" />
                <MenuItem
                  icon={<Trash2 size={11} />}
                  label="Delete column"
                  danger
                  onClick={() => deleteColumn(menu.index)}
                />
              </>
            ) : (
              <>
                <MenuItem icon={<ArrowUp size={11} />} label="Insert above" onClick={() => insertRow(menu.index, false)} />
                <MenuItem icon={<ArrowDown size={11} />} label="Insert below" onClick={() => insertRow(menu.index, true)} />
                <span className="drawing-tbl-menu-sep" />
                <MenuItem
                  icon={<Trash2 size={11} />}
                  label="Delete row"
                  danger
                  onClick={() => deleteRow(menu.index)}
                />
              </>
            )}
            <MenuItem icon={<Trash2 size={11} />} label="Delete table" danger onClick={deleteTable} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The `TableNode` key behind a rendered `<table>`.
 *
 * `$getNearestNodeFromDOMNode` is Lexical's own way back from the DOM, which
 * beats reading the `__lexicalKey_` property it stamps on elements — that is an
 * implementation detail, and it is keyed by editor instance.
 */
function tableKeyFor(editor: LexicalEditor, element: HTMLElement): string | null {
  // `editor.read`, **not** `editor.getEditorState().read`. The latter makes an
  // editor *state* active but no editor, and `$getNearestNodeFromDOMNode`
  // reaches for the editor to map a DOM node back to a key — it throws
  // "Unable to find an active editor", which the overlay boundary turns into a
  // closed window.
  return editor.read(() => {
    const node = $getNearestNodeFromDOMNode(element);
    if (!node) return null;
    if ($isTableNode(node)) return node.getKey();
    // A `<table>` whose nearest node is a cell or row still belongs to one
    // table, and that is the one being pointed at.
    const cell = $getTableCellNodeFromLexicalNode(node);
    return cell ? $getTableNodeFromLexicalNodeOrThrow(cell).getKey() : null;
  });
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`drawing-tbl-menu-item ${danger ? "danger" : ""}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
