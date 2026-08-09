import { useState, useEffect, useRef } from "react";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[480px] bg-ft-elevated border border-ft-border rounded-xl shadow-elevated overflow-hidden animate-fade-in">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-ft-border-subtle">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-ft-text-muted flex-shrink-0">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-ft-text text-sm placeholder-ft-text-muted outline-none"
          />
          <kbd className="text-[10px] text-ft-text-muted bg-ft-bg px-1.5 py-0.5 rounded border border-ft-border-subtle font-mono">
            ESC
          </kbd>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-1.5">
          {filtered.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors duration-100 ${
                idx === selectedIndex
                  ? "bg-ft-accent/10 text-ft-text"
                  : "text-ft-text-secondary hover:bg-ft-bg hover:text-ft-text"
              }`}
              onClick={() => {
                cmd.action();
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="text-[13px]">{cmd.label}</span>
              {cmd.shortcut && (
                <kbd className="text-[10px] text-ft-text-muted font-mono bg-ft-bg border border-ft-border-subtle px-1.5 py-0.5 rounded">
                  {cmd.shortcut}
                </kbd>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-ft-text-muted">
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
