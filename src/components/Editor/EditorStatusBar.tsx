import { useEffect, useRef, useState } from "react";
import { Check, WrapText } from "lucide-react";
import { scrollIntoViewWithin } from "../../services/scroll";
import { FileEncoding, LineEnding } from "../../services/editor-fs";
import { availableLanguages, labelFor } from "../../services/editor-lang";
import { EditorBuffer } from "../../stores/editorStore";

/**
 * The bar along the bottom: what the file is, where the cursor is, and the
 * resize grip.
 *
 * Language, line ending and encoding are all clickable, because all three are
 * things you occasionally need to change and nowhere else in the editor is a
 * sensible place to put them. Line ending especially: it's the setting that
 * silently turns a one-line change into a whole-file diff, so it's worth being
 * visible rather than buried.
 */

const LINE_ENDINGS: { value: LineEnding; label: string; detail: string }[] = [
  { value: "lf", label: "LF", detail: "Unix (\\n)" },
  { value: "crlf", label: "CRLF", detail: "Windows (\\r\\n)" },
];

const ENCODINGS: { value: FileEncoding; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-8-bom", label: "UTF-8 with BOM" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

interface EditorStatusBarProps {
  buffer: EditorBuffer | null;
  cursor: { line: number; column: number };
  wrapped: boolean;
  bufferCount: number;
  watcherMechanism: "native" | "poll" | null;
  onToggleWrap: () => void;
  onSetLanguage: (languageId: string) => void;
  onSetLineEnding: (lineEnding: LineEnding) => void;
  onSetEncoding: (encoding: FileEncoding) => void;
  onGoToLine: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
}

export function EditorStatusBar({
  buffer,
  cursor,
  wrapped,
  bufferCount,
  watcherMechanism,
  onToggleWrap,
  onSetLanguage,
  onSetLineEnding,
  onSetEncoding,
  onGoToLine,
  onResizeStart,
}: EditorStatusBarProps) {
  const [open, setOpen] = useState<"language" | "lineEnding" | "encoding" | null>(null);

  return (
    <div
      className="editor-chrome editor-statusbar flex items-center gap-2 px-2.5 h-[24px] shrink-0"
      onContextMenu={(e) => e.preventDefault()}
    >
      {buffer ? (
        <>
          <button
            className="editor-status-item text-[10px] tabular-nums"
            onClick={onGoToLine}
            title="Go to line (⌘G)"
          >
            Ln {cursor.line}, Col {cursor.column}
          </button>

          <Popup
            open={open === "language"}
            onOpenChange={(next) => setOpen(next ? "language" : null)}
            label={labelFor(buffer.languageId)}
            title="Select language mode"
            items={availableLanguages().map((language) => ({
              key: language.id,
              label: language.label,
              selected: language.id === buffer.languageId,
              onSelect: () => onSetLanguage(language.id),
            }))}
          />

          <Popup
            open={open === "lineEnding"}
            onOpenChange={(next) => setOpen(next ? "lineEnding" : null)}
            label={buffer.lineEnding.toUpperCase()}
            title="Line endings"
            items={LINE_ENDINGS.map((option) => ({
              key: option.value,
              label: option.label,
              detail: option.detail,
              selected: option.value === buffer.lineEnding,
              onSelect: () => onSetLineEnding(option.value),
            }))}
          />

          <Popup
            open={open === "encoding"}
            onOpenChange={(next) => setOpen(next ? "encoding" : null)}
            label={encodingLabel(buffer.encoding)}
            title="File encoding"
            items={ENCODINGS.map((option) => ({
              key: option.value,
              label: option.label,
              selected: option.value === buffer.encoding,
              onSelect: () => onSetEncoding(option.value),
            }))}
          />

          <button
            className={`editor-status-item ${wrapped ? "on" : ""}`}
            onClick={onToggleWrap}
            title={wrapped ? "Disable word wrap" : "Enable word wrap"}
            aria-pressed={wrapped}
          >
            <WrapText size={11} />
          </button>

          {buffer.readonly && (
            <span
              className="editor-status-tag text-[10px]"
              title={
                buffer.large
                  ? "This file is too large to edit comfortably, so it opened read-only"
                  : "This file is not writable"
              }
            >
              read-only
            </span>
          )}

          {buffer.disk !== "ok" && (
            <span
              className="editor-status-tag warn text-[10px]"
              title={
                buffer.disk === "missing"
                  ? "This file was not found on disk — saving will recreate it"
                  : "Changed on disk since it was opened"
              }
            >
              {buffer.disk === "missing" ? "not on disk" : "changed on disk"}
            </span>
          )}
        </>
      ) : (
        <span className="editor-status-text text-[10px]">No file open</span>
      )}

      <div className="flex-1" />

      {watcherMechanism === "poll" && (
        <span
          className="editor-status-tag warn text-[10px]"
          title="The system's file-change notifications were unavailable, so changes are polled every few seconds"
        >
          polling
        </span>
      )}

      <span className="editor-status-text text-[10px]">
        {bufferCount} {bufferCount === 1 ? "file" : "files"}
      </span>

      {/*
        The grip lives in the status bar for the same reason the browser's does:
        it needs somewhere nothing else is competing for the pointer.
      */}
      <div
        className="editor-resize-handle"
        onPointerDown={onResizeStart}
        title="Resize"
        role="separator"
        aria-orientation="horizontal"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="editor-resize-icon">
          <path
            d="M9 1L1 9M9 5L5 9"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

function encodingLabel(encoding: FileEncoding): string {
  return ENCODINGS.find((option) => option.value === encoding)?.label ?? encoding;
}

interface PopupItem {
  key: string;
  label: string;
  detail?: string;
  selected: boolean;
  onSelect: () => void;
}

/** A status-bar button whose menu opens upwards, since there's nothing below. */
function Popup({
  open,
  onOpenChange,
  label,
  title,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  title: string;
  items: PopupItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open, onOpenChange]);

  // The selected row is scrolled to when the menu opens — the language list is
  // long enough that otherwise the current value is often off-screen.
  useEffect(() => {
    if (!open) return;
    const list = ref.current?.querySelector<HTMLElement>("[role=listbox]") ?? null;
    const row = ref.current?.querySelector<HTMLElement>("[data-selected]") ?? null;
    scrollIntoViewWithin(list, row, { block: "center" });
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className={`editor-status-item text-[10px] ${open ? "on" : ""}`}
        onClick={() => onOpenChange(!open)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {label}
      </button>

      {open && (
        <div
          className="editor-status-popup absolute bottom-full mb-1.5 left-0 min-w-[150px] max-h-[220px] overflow-y-auto py-1 rounded-lg"
          role="listbox"
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="option"
              aria-selected={item.selected}
              data-selected={item.selected ? "" : undefined}
              className={`editor-status-option flex items-center gap-2 w-full px-2.5 py-1 text-[11px] text-left ${
                item.selected ? "selected" : ""
              }`}
              onClick={() => {
                item.onSelect();
                onOpenChange(false);
              }}
            >
              <span className="w-3 shrink-0">
                {item.selected && <Check size={11} />}
              </span>
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.detail && (
                <span className="editor-status-option-detail text-[10px] shrink-0">
                  {item.detail}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
