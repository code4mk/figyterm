import { useEffect, useRef } from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { ChevronRight, Folder, FileText, Terminal, Hash, Circle, Sparkles } from "lucide-react";

function resolveIcon(icon?: string): string | null {
  if (!icon) return null;
  const match = icon.match(/(?:figy|fig):\/\/icon\?type=([\w-]+)/);
  if (match) return `/icons/${match[1]}.png`;
  if (icon.startsWith("/") || icon.startsWith("http")) return icon;
  return null;
}

export interface SuggestionItem {
  name: string;
  description?: string;
  type: "file" | "folder" | "subcommand" | "option" | "arg" | "special";
  icon?: string;
  insertValue?: string;
  isDir?: boolean;
  path?: string;
  isHidden?: boolean;
}

interface SuggestionPopupProps {
  items: SuggestionItem[];
  selectedIndex: number;
  visible: boolean;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (item: SuggestionItem) => void;
}

export function SuggestionPopup({
  items,
  selectedIndex,
  visible,
  anchorRef,
  onSelect,
}: SuggestionPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedElRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible || !anchorRef.current || !popupRef.current) return;

    const container = anchorRef.current;
    const textarea = container.querySelector(".xterm-helper-textarea") as HTMLElement;
    if (!textarea) return;

    const virtualEl = {
      getBoundingClientRect: () => textarea.getBoundingClientRect(),
    };

    computePosition(virtualEl, popupRef.current, {
      placement: "bottom-start",
      middleware: [
        offset(4),
        flip({ fallbackPlacements: ["top-start"] }),
        shift({ padding: 8 }),
      ],
    }).then(({ x, y }) => {
      if (popupRef.current) {
        popupRef.current.style.left = `${x}px`;
        popupRef.current.style.top = `${y}px`;
      }
    });
  }, [visible, anchorRef, items, selectedIndex]);

  useEffect(() => {
    if (selectedElRef.current && listRef.current) {
      selectedElRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!visible || items.length === 0) return null;

  return (
    <div
      ref={popupRef}
      className="fixed z-[200]"
      style={{ top: 0, left: 0 }}
    >
      <div
        className="w-[300px] max-h-[200px] bg-ft-elevated border border-ft-border rounded-xl overflow-hidden animate-slide-up shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-2.5 py-[5px] bg-ft-surface border-b border-ft-border-subtle">
          <div className="flex items-center gap-1.5">
            <ChevronRight size={8} className="text-ft-accent" />
            <span className="text-[9px] font-bold text-ft-text-secondary uppercase tracking-wider">
              Suggestions
            </span>
            <span className="text-[8px] text-ft-text-secondary/70">({items.length})</span>
          </div>
          <div className="flex items-center gap-1">
            <kbd className="text-[7px] text-ft-text-secondary bg-ft-bg px-[3px] py-[1px] rounded border border-ft-border-subtle font-mono">↑↓</kbd>
            <kbd className="text-[7px] text-ft-text-secondary bg-ft-bg px-[3px] py-[1px] rounded border border-ft-border-subtle font-mono">Tab</kbd>
          </div>
        </div>

        {/* Items */}
        <div ref={listRef} className="overflow-y-auto max-h-[160px] py-0.5 px-0.5">
          {items.map((item, idx) => (
            <div
              key={item.name + idx}
              ref={idx === selectedIndex ? selectedElRef : null}
              className={`flex items-center gap-2 px-2 py-[5px] mx-0.5 my-[1px] rounded-lg cursor-pointer transition-all duration-[50ms] ${
                idx === selectedIndex
                  ? "bg-ft-accent/[0.12] ring-1 ring-inset ring-ft-accent/25 text-ft-text"
                  : "text-ft-text hover:bg-ft-surface"
              }`}
              onClick={() => onSelect(item)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <ItemIcon type={item.type} icon={item.icon} />

              <div className="flex-1 min-w-0">
                <span className="text-[11px] font-medium truncate block">
                  {item.name}{item.type === "folder" && <span className="opacity-30">/</span>}
                </span>
                {item.description && (
                  <span className="text-[9px] text-ft-text-muted truncate block leading-tight">
                    {item.description}
                  </span>
                )}
              </div>

              <TypeBadge type={item.type} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ItemIcon({ type, icon }: { type: SuggestionItem["type"]; icon?: string }) {
  const base = "flex-shrink-0 w-[20px] h-[20px] flex items-center justify-center rounded-md p-[3px]";
  const resolved = resolveIcon(icon);

  if (resolved) {
    return (
      <div className={`${base} bg-ft-bg/60`}>
        <img
          src={resolved}
          alt=""
          className="w-[13px] h-[13px] object-contain"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            img.style.display = "none";
            const wrapper = img.parentElement as HTMLElement;
            wrapper.className = `${base} ${bgForType(type)}`;
            const fallback = img.nextElementSibling as HTMLElement;
            if (fallback) fallback.style.display = "block";
          }}
        />
        <span className="hidden">
          <DefaultTypeIcon type={type} />
        </span>
      </div>
    );
  }

  return (
    <div className={`${base} ${bgForType(type)}`}>
      <DefaultTypeIcon type={type} />
    </div>
  );
}

function bgForType(type: SuggestionItem["type"]): string {
  switch (type) {
    case "folder": return "bg-blue-500/10 text-blue-400";
    case "file": return "bg-gray-500/10 text-gray-400";
    case "subcommand": return "bg-purple-500/10 text-purple-400";
    case "option": return "bg-amber-500/10 text-amber-400";
    case "arg": return "bg-emerald-500/10 text-emerald-400";
    case "special": return "bg-pink-500/10 text-pink-400";
    default: return "bg-gray-500/10 text-gray-400";
  }
}

function DefaultTypeIcon({ type }: { type: SuggestionItem["type"] }) {
  switch (type) {
    case "folder": return <Folder size={11} />;
    case "file": return <FileText size={10} />;
    case "subcommand": return <Terminal size={11} />;
    case "option": return <Hash size={11} />;
    case "arg": return <Circle size={10} />;
    case "special": return <Sparkles size={10} />;
    default: return <FileText size={10} />;
  }
}

function TypeBadge({ type }: { type: SuggestionItem["type"] }) {
  const labels: Record<string, { text: string; cls: string }> = {
    folder: { text: "dir", cls: "text-blue-400/80" },
    file: { text: "file", cls: "text-gray-400/80" },
    subcommand: { text: "cmd", cls: "text-purple-400/80" },
    option: { text: "opt", cls: "text-amber-400/80" },
    arg: { text: "arg", cls: "text-emerald-400/80" },
    special: { text: "misc", cls: "text-pink-400/80" },
  };

  const label = labels[type];
  if (!label) return null;

  return (
    <span className={`flex-shrink-0 text-[7px] font-bold uppercase tracking-wider ${label.cls}`}>
      {label.text}
    </span>
  );
}
