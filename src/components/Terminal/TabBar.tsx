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
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
  onPrevTab?: () => void;
  onNextTab?: () => void;
}

export function TabBar({ tabs, onTabClick, onTabClose, onNewTab, onRenameTab, onReorderTabs, onPrevTab, onNextTab }: TabBarProps) {
  const [renameModal, setRenameModal] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pointer-based drag (refs for event listener closures, state for rendering)
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const onReorderRef = useRef(onReorderTabs);
  onReorderRef.current = onReorderTabs;

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

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;

    dragStartX.current = e.clientX;
    dragStartY.current = e.clientY;
    dragActive.current = false;
    dragIndexRef.current = index;
    dropIndexRef.current = null;
    setDragIndex(index);
    setDropIndex(null);
    setGhostPos(null);

    const handlePointerMove = (ev: PointerEvent) => {
      const dx = Math.abs(ev.clientX - dragStartX.current);
      if (dx > 5 && !dragActive.current) {
        dragActive.current = true;
        document.body.style.cursor = "grabbing";
      }
      if (!dragActive.current || !tabContainerRef.current) return;

      setGhostPos({ x: ev.clientX, y: ev.clientY });

      const tabEls = tabContainerRef.current.querySelectorAll<HTMLElement>("[data-tab-index]");
      let target: number | null = null;

      for (const el of tabEls) {
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const tabIdx = Number(el.dataset.tabIndex);
        if (ev.clientX < midX) {
          target = tabIdx;
          break;
        }
        target = tabIdx + 1;
      }

      if (target !== null && target !== index && target !== index + 1) {
        dropIndexRef.current = target;
        setDropIndex(target);
      } else {
        dropIndexRef.current = null;
        setDropIndex(null);
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";

      const from = dragIndexRef.current;
      const drop = dropIndexRef.current;

      if (dragActive.current && from !== null && drop !== null) {
        const to = drop > from ? drop - 1 : drop;
        if (from !== to) {
          onReorderRef.current?.(from, to);
        }
      }

      dragIndexRef.current = null;
      dropIndexRef.current = null;
      dragActive.current = false;
      setDragIndex(null);
      setDropIndex(null);
      setGhostPos(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, []);

  const activeIndex = tabs.findIndex((t) => t.isActive);
  const canPrev = activeIndex > 0;
  const canNext = activeIndex < tabs.length - 1;

  return (
    <>
      <div className="tab-bar flex items-end h-[40px] pt-[6px] pl-[72px] pr-2 gap-0 overflow-x-auto no-drag drag-region select-none">
        {/* Logo */}
        <div className="flex items-center h-[32px] px-2 flex-shrink-0 no-drag">
          <img src="/logo.png" alt="FigyTerm" className="h-4 w-auto" />
        </div>

        {/* Global nav arrows */}
        {tabs.length > 1 && (
          <div className="flex items-center h-[32px] gap-0 mr-1 flex-shrink-0 no-drag">
            <button
              onClick={onPrevTab}
              disabled={!canPrev}
              className={`tab-nav-btn flex items-center justify-center w-5 h-5 rounded transition-colors ${!canPrev ? "opacity-25 cursor-default" : ""}`}
              title="Previous Tab (⌘⇧[)"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              onClick={onNextTab}
              disabled={!canNext}
              className={`tab-nav-btn flex items-center justify-center w-5 h-5 rounded transition-colors ${!canNext ? "opacity-25 cursor-default" : ""}`}
              title="Next Tab (⌘⇧])"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}

        {/* Tabs */}
        <div ref={tabContainerRef} className="flex items-end gap-[1px] min-w-0 overflow-x-auto no-drag">
          {tabs.map((tab, index) => {
          const isDragged = dragIndex === index && dropIndex !== null;
          const showDropBefore = dropIndex === index && dragIndex !== null && dragIndex !== index;
          const showDropAfter = dropIndex === tabs.length && index === tabs.length - 1 && dragIndex !== null && dragIndex !== index;

            return (
              <div
                key={tab.id}
                data-tab-index={index}
                onPointerDown={(e) => handlePointerDown(e, index)}
                onClick={() => { if (!dragActive.current) onTabClick(tab.id); }}
                onDoubleClick={() => openRename(tab)}
                onMouseEnter={() => setHoveredTab(tab.id)}
                onMouseLeave={() => setHoveredTab(null)}
                className={`tab-item group relative flex items-center h-[32px] px-3 rounded-t-lg text-[11px] font-medium transition-all duration-100 min-w-[130px] max-w-[220px] cursor-pointer no-drag select-none ${
                  tab.isActive ? "active" : ""
                } ${isDragged ? "dragging" : ""}`}
              >
                {/* Drop indicator — before this tab */}
                {showDropBefore && (
                  <div className="drop-indicator absolute -left-[1px] top-[4px] bottom-[4px] w-[2px] rounded-full" />
                )}
                {/* Drop indicator — after last tab */}
                {showDropAfter && (
                  <div className="drop-indicator absolute -right-[1px] top-[4px] bottom-[4px] w-[2px] rounded-full" />
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
                      title="Close tab"
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
        </div>

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

      {/* Floating drag ghost */}
      {ghostPos && dragIndex !== null && tabs[dragIndex] && (
        <div
          ref={ghostRef}
          className="drag-ghost fixed z-[500] pointer-events-none flex items-center gap-2 h-[30px] px-3 rounded-lg text-[11px] font-medium"
          style={{
            left: ghostPos.x - 60,
            top: ghostPos.y - 15,
          }}
        >
          <TerminalSquare size={12} className="text-ft-accent flex-shrink-0" />
          <span className="truncate">{tabs[dragIndex].title}</span>
        </div>
      )}

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
