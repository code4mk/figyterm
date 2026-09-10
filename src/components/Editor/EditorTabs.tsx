import { useRef, useState } from "react";
import { Plus, TriangleAlert, X } from "lucide-react";
import { EditorBuffer } from "../../stores/editorStore";
import { FileIcon } from "./fileIcons";

/**
 * The file tab strip, which doubles as the modal's drag handle — the same
 * arrangement the browser modal uses, and the one a real title bar has.
 *
 * A dirty tab shows a dot in place of its close button until hovered, so the
 * strip can be read at a glance without the close targets moving around.
 */

interface EditorTabsProps {
  buffers: EditorBuffer[];
  activeBufferId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewScratch: () => void;
  onReorder: (from: number, to: number) => void;
  onDragHandle: (e: React.PointerEvent) => void;
}

export function EditorTabs({
  buffers,
  activeBufferId,
  onSelect,
  onClose,
  onNewScratch,
  onReorder,
  onDragHandle,
}: EditorTabsProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="editor-chrome editor-tabstrip flex items-center gap-1 px-2 pt-1.5 select-none cursor-grab active:cursor-grabbing"
      onPointerDown={onDragHandle}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={stripRef}
        className="flex items-end gap-1 flex-1 min-w-0 overflow-x-auto editor-tabstrip-scroll"
      >
        {buffers.map((buffer, index) => (
          <div
            key={buffer.id}
            role="tab"
            aria-selected={buffer.id === activeBufferId}
            title={buffer.path ?? buffer.name}
            className={`editor-tab group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-t-lg shrink-0 max-w-[190px] ${
              buffer.id === activeBufferId ? "active" : ""
            } ${overIndex === index && dragIndex !== index ? "drop-target" : ""}`}
            // Tabs are reordered by dragging, so the pointer-down that would
            // otherwise start a window drag has to stop here.
            onPointerDown={(e) => e.stopPropagation()}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onClick={() => onSelect(buffer.id)}
            onAuxClick={(e) => {
              // Middle click closes, as in every editor and browser.
              if (e.button === 1) {
                e.preventDefault();
                onClose(buffer.id);
              }
            }}
          >
            {buffer.disk !== "ok" ? (
              <TriangleAlert
                size={11}
                className="editor-tab-conflict shrink-0"
                aria-label={
                  buffer.disk === "missing" ? "Not found on disk" : "Changed on disk"
                }
              />
            ) : buffer.path ? (
              <FileIcon path={buffer.path} size={12} />
            ) : (
              <FileIcon path="untitled.txt" size={12} />
            )}

            <span className="editor-tab-title text-[11px] truncate flex-1 min-w-0">
              {buffer.name}
            </span>

            <button
              className={`editor-tab-close p-0.5 rounded shrink-0 ${
                buffer.dirty ? "dirty" : ""
              }`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(buffer.id);
              }}
              title={buffer.dirty ? "Unsaved changes — close" : "Close"}
              aria-label="Close file"
            >
              {/* The dot and the cross occupy the same box, so hovering a
                  dirty tab doesn't shift the strip. */}
              <span className="editor-tab-dot" aria-hidden />
              <X size={11} className="editor-tab-cross" />
            </button>
          </div>
        ))}

        <button
          className="editor-newtab-btn shrink-0 p-1 rounded mb-0.5"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onNewScratch}
          title="New untitled file"
          aria-label="New untitled file"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
