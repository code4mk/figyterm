import { useState, useRef, useEffect, Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { TerminalSquare, X, Plus, Pencil, Columns2 } from "lucide-react";

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
  onDuplicateTab?: (id: string) => void;
}

export function TabBar({ tabs, onTabClick, onTabClose, onNewTab, onRenameTab }: TabBarProps) {
  const [renameModal, setRenameModal] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renameModal && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
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

  return (
    <>
      <div className="flex items-end h-[38px] bg-ft-tab pt-[6px] pl-[72px] pr-2 gap-[2px] overflow-x-auto no-drag drag-region select-none">
        <div className="flex items-center h-[30px] px-2 flex-shrink-0 no-drag">
          <img src="/logo.png" alt="Figyterm" className="w-4 h-4 rounded-sm" />
        </div>
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            draggable={false}
            onClick={() => onTabClick(tab.id)}
            onDoubleClick={() => openRename(tab)}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab(null)}
            className={`group relative flex items-center h-[30px] px-3 rounded-t-lg text-[11px] font-medium transition-all duration-100 min-w-[120px] max-w-[200px] cursor-pointer no-drag select-none ${
              tab.isActive
                ? "bg-ft-bg text-ft-text z-10"
                : "text-ft-text-muted hover:text-ft-text-secondary hover:bg-ft-tab-active/60"
            }`}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <TerminalSquare
                size={12}
                className={`flex-shrink-0 ${
                  tab.isActive ? "text-ft-accent" : "opacity-50"
                }`}
              />
              <span className="truncate leading-none">{tab.title}</span>
              {tab.paneCount && tab.paneCount > 1 && (
                <span className="flex items-center gap-0.5 text-[9px] text-ft-text-muted flex-shrink-0">
                  <Columns2 size={8} className="opacity-60" />
                  {tab.paneCount}
                </span>
              )}
            </div>

            <div
              className={`flex items-center gap-0.5 flex-shrink-0 ml-2 transition-opacity duration-100 ${
                hoveredTab === tab.id || tab.isActive ? "opacity-100" : "opacity-0"
              }`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openRename(tab);
                }}
                className="p-[3px] rounded text-ft-text-muted hover:text-ft-accent hover:bg-ft-elevated/80 transition-colors"
                title="Rename tab"
              >
                <Pencil size={9} />
              </button>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  className="p-[3px] rounded text-ft-text-muted hover:text-ft-error hover:bg-ft-error/10 transition-colors"
                  title="Close tab (⌘W)"
                >
                  <X size={10} />
                </button>
              )}
            </div>

            {tab.isActive && (
              <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-ft-accent rounded-full" />
            )}

            {!tab.isActive && index < tabs.length - 1 && !tabs[index + 1]?.isActive && (
              <div className="absolute right-0 top-[7px] bottom-[7px] w-px bg-ft-border-subtle/50" />
            )}
          </div>
        ))}

        <button
          onClick={onNewTab}
          className="flex items-center justify-center w-7 h-7 ml-1 mb-[1px] rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-tab-active/80 transition-all duration-100 flex-shrink-0 no-drag"
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
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
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
              <Dialog.Panel className="w-full max-w-sm rounded-xl bg-ft-elevated border border-ft-border shadow-2xl p-5">
                <Dialog.Title className="text-sm font-semibold text-ft-text mb-3">
                  Rename Tab
                </Dialog.Title>

                <input
                  ref={inputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") setRenameModal(null);
                  }}
                  placeholder="Tab name..."
                  className="w-full px-3 py-2 rounded-lg bg-ft-bg border border-ft-border-subtle text-sm text-ft-text placeholder:text-ft-text-muted focus:outline-none focus:ring-2 focus:ring-ft-accent/50 focus:border-ft-accent"
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
