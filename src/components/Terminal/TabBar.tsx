import { useState, useRef, useEffect, Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { TerminalSquare, X, Plus, Pencil } from "lucide-react";

interface Tab {
  id: string;
  title: string;
  isActive: boolean;
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
      <div className="flex items-center h-9 bg-ft-surface border-b border-ft-border-subtle px-2 gap-0.5 overflow-x-auto no-drag">
        <div className="flex items-center gap-1.5 px-2 mr-1 flex-shrink-0 no-drag">
          <img src="/logo.png" alt="Figyterm" className="w-4 h-4 rounded-sm" />
        </div>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onTabClick(tab.id)}
            onDoubleClick={() => openRename(tab)}
            className={`group relative flex items-center gap-2 h-7 px-3 rounded-md text-xs font-medium transition-all duration-150 min-w-0 max-w-[200px] cursor-pointer ${
              tab.isActive
                ? "bg-ft-elevated text-ft-text shadow-sm"
                : "text-ft-text-muted hover:text-ft-text-secondary hover:bg-ft-elevated/50"
            }`}
          >
            <TerminalSquare size={10} className="flex-shrink-0 opacity-60" />
            <span className="truncate">{tab.title}</span>

            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 ml-auto pl-1 transition-all">
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  openRename(tab);
                }}
                className="text-ft-text-muted hover:text-ft-accent p-0.5 rounded hover:bg-ft-bg/50"
                title="Rename tab"
              >
                <Pencil size={8} />
              </span>
              {tabs.length > 1 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  className="text-ft-text-muted hover:text-ft-error p-0.5 rounded hover:bg-ft-bg/50"
                  title="Close tab"
                >
                  <X size={9} />
                </span>
              )}
            </div>

            {tab.isActive && (
              <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-ft-accent rounded-full" />
            )}
          </div>
        ))}
        <button
          onClick={onNewTab}
          className="flex items-center justify-center w-6 h-6 ml-1 rounded text-ft-text-muted hover:text-ft-text hover:bg-ft-elevated/50 transition-colors flex-shrink-0"
          title="New Tab (⌘T)"
        >
          <Plus size={12} />
        </button>
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
            <div className="fixed inset-0 bg-black/40" />
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
