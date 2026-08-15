import { useState, useRef, useEffect, Fragment, useCallback } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { TerminalSquare, X, Plus, Pencil, Columns2, ChevronLeft, ChevronRight } from "lucide-react";

interface Tab {
  id: string;
  title: string;
  isActive: boolean;
  paneCount?: number;
}

interface TabBarProps {
  tabs: Tab[];
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
  onRenameTab?: (id: string, name: string) => void;
  onMoveTab?: (id: string, direction: "left" | "right") => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
}

export function TabBar({ tabs, onTabClick, onTabClose, onNewTab, onRenameTab, onMoveTab, onReorderTabs }: TabBarProps) {
  const [renameModal, setRenameModal] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (renameModal) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [renameModal]);

  const openRename = (tab: Tab) => {
    setRenameModal({ id: tab.id, title: tab.title });
    setRenameValue(tab.title);
  };

  const submitRename = () => {
    if (renameModal && renameValue.trim()) {
      onRenameTab?.(renameModal.id, renameValue.trim());
    }
    setRenameModal(null);
  };

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));

    const el = tabRefs.current.get(index);
    if (el) {
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.style.position = "absolute";
      ghost.style.top = "-9999px";
      ghost.style.opacity = "0.9";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 60, 15);
      requestAnimationFrame(() => ghost.remove());
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = draggedIndex;
    setDraggedIndex(null);
    setDropTargetIndex(null);
    if (fromIndex !== null && fromIndex !== toIndex) {
      onReorderTabs?.(fromIndex, toIndex);
    }
  }, [draggedIndex, onReorderTabs]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
  }, []);

  return (
    <>
      <div className="tab-bar flex items-end h-[40px] pt-[6px] pl-[72px] pr-2 gap-[1px] overflow-x-auto no-drag drag-region select-none">
        {/* Logo */}
        <div className="flex items-center h-[32px] px-2 flex-shrink-0 no-drag">
          <img src="/logo.png" alt="FigyTerm" className="h-4 w-auto" />
        </div>

        {/* Tabs */}
        {tabs.map((tab, index) => {
          const isDragged = draggedIndex === index;
          const isDropTarget = dropTargetIndex === index && draggedIndex !== null && draggedIndex !== index;
          const canMoveLeft = index > 0;
          const canMoveRight = index < tabs.length - 1;

          return (
            <div
              key={tab.id}
              ref={(el) => { if (el) tabRefs.current.set(index, el); }}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnter={(e) => { e.preventDefault(); setDropTargetIndex(index); }}
              onDragLeave={() => { if (dropTargetIndex === index) setDropTargetIndex(null); }}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => onTabClick(tab.id)}
              onDoubleClick={() => openRename(tab)}
              onMouseEnter={() => setHoveredTab(tab.id)}
              onMouseLeave={() => setHoveredTab(null)}
              className={`tab-item group relative flex items-center h-[32px] px-3 rounded-t-lg text-[11px] font-medium transition-all duration-100 min-w-[130px] max-w-[220px] cursor-pointer no-drag select-none ${
                tab.isActive ? "active" : ""
              } ${isDragged ? "dragging" : ""} ${isDropTarget ? "drop-target" : ""}`}
            >
              {/* Drop indicator line */}
              {isDropTarget && (
                <div className="drop-indicator absolute left-0 top-[4px] bottom-[4px] w-[2px] rounded-full" />
              )}

              <div className="flex items-center gap-2 flex-1 min-w-0">
                <TerminalSquare
                  size={12}
                  className={`flex-shrink-0 ${tab.isActive ? "text-ft-accent" : "tab-icon"}`}
                />
                <span className="truncate leading-none">{tab.title}</span>
                {tab.paneCount && tab.paneCount > 1 && (
                  <span className="flex items-center gap-0.5 text-[9px] tab-pane-count flex-shrink-0">
                    <Columns2 size={8} className="opacity-60" />
                    {tab.paneCount}
                  </span>
                )}
              </div>

              {/* Action buttons */}
              <div
                className={`flex items-center gap-0 flex-shrink-0 ml-1.5 transition-opacity duration-100 ${
                  hoveredTab === tab.id || tab.isActive ? "opacity-100" : "opacity-0"
                }`}
              >
                {/* Move left/right buttons — only on hover */}
                {hoveredTab === tab.id && tabs.length > 1 && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (canMoveLeft) onMoveTab?.(tab.id, "left"); }}
                      className={`tab-action-btn p-[2px] rounded transition-colors ${canMoveLeft ? "" : "opacity-30 cursor-default"}`}
                      title="Move tab left"
                    >
                      <ChevronLeft size={10} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (canMoveRight) onMoveTab?.(tab.id, "right"); }}
                      className={`tab-action-btn p-[2px] rounded transition-colors ${canMoveRight ? "" : "opacity-30 cursor-default"}`}
                      title="Move tab right"
                    >
                      <ChevronRight size={10} />
                    </button>
                  </>
                )}

                <button
                  onClick={(e) => { e.stopPropagation(); openRename(tab); }}
                  className="tab-action-btn p-[2px] rounded transition-colors"
                  title="Rename tab"
                >
                  <Pencil size={9} />
                </button>

                {tabs.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
                    className="tab-close-btn p-[2px] rounded transition-colors"
                    title="Close tab (⌘W)"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>

              {/* Active indicator */}
              {tab.isActive && (
                <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-ft-accent rounded-full" />
              )}
            </div>
          );
        })}

        {/* New tab button */}
        <button
          onClick={onNewTab}
          className="tab-new-btn flex items-center justify-center w-7 h-[30px] ml-1 mb-[1px] rounded-md transition-all duration-100 flex-shrink-0 no-drag"
          title="New Tab (⌘T)"
        >
          <Plus size={13} strokeWidth={2} />
        </button>

        <div className="flex-1 drag-region" />
      </div>

      {/* Rename Modal */}
      <Transition appear show={renameModal !== null} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-[300]"
          onClose={() => setRenameModal(null)}
        >
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
            />
          </Transition.Child>

          <div className="fixed inset-0 flex items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel
                className="w-full max-w-sm rounded-xl settings-modal shadow-2xl p-5"
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
              >
                <Dialog.Title className="text-sm font-semibold text-ft-text mb-3">
                  Rename Tab
                </Dialog.Title>

                <input
                  ref={inputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") setRenameModal(null);
                  }}
                  onPaste={(e) => e.stopPropagation()}
                  onKeyUp={(e) => e.stopPropagation()}
                  placeholder="Tab name..."
                  className="settings-input w-full rounded-lg px-3 py-2 text-sm"
                  autoFocus
                />

                <div className="flex items-center justify-end gap-2 mt-4">
                  <button
                    onClick={() => setRenameModal(null)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-ft-text-secondary hover:text-ft-text hover:bg-ft-surface transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitRename}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-ft-accent text-white hover:bg-ft-accent-hover transition-colors"
                  >
                    Rename
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </Dialog>
      </Transition>
    </>
  );
}
