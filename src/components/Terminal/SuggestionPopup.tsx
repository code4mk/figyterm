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
  fontFamily,
}: SuggestionPopupProps & { fontFamily?: string }) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedElRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      positionedRef.current = false;
      return;
    }
    if (!anchorRef.current || !popupRef.current) return;

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
        popupRef.current.style.visibility = "visible";
        positionedRef.current = true;
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
      style={{ top: 0, left: 0, visibility: "hidden" }}
    >
      <div className="suggestion-popup w-[300px] max-h-[220px] rounded-xl overflow-hidden">
        {/* Header */}
        <div className="suggestion-header flex items-center justify-between px-2.5 py-[6px]">
          <div className="flex items-center gap-1.5">
            <ChevronRight size={8} className="text-ft-accent" />
            <span className="text-[9px] font-semibold text-ft-text-secondary uppercase tracking-wider">
              Suggestions
            </span>
            <span className="text-[8px] text-ft-text-muted">
              ({items.length})
            </span>
          </div>
          <div className="flex items-center gap-1">
            <kbd className="suggestion-kbd">↑↓</kbd>
            <kbd className="suggestion-kbd">Tab</kbd>
            <kbd className="suggestion-kbd">↵</kbd>
          </div>
        </div>

        {/* Items */}
        <div ref={listRef} className="overflow-y-auto max-h-[180px] py-0.5 px-0.5">
          {items.map((item, idx) => (
            <div
              key={item.name + idx}
              ref={idx === selectedIndex ? selectedElRef : null}
              className={`suggestion-item flex items-center gap-2 px-2 py-[5px] mx-0.5 my-[1px] rounded-lg cursor-pointer transition-all duration-75 ${
                idx === selectedIndex ? "selected" : ""
              }`}
              onClick={() => onSelect(item)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <ItemIcon type={item.type} icon={item.icon} />

              <div className="flex-1 min-w-0">
                <span
                  className="suggestion-name text-[11px] font-medium truncate block"
                  style={fontFamily ? { fontFamily } : undefined}
                >
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
      <div className={`${base} bg-ft-surface`}>
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
    case "folder": return "icon-folder";
    case "file": return "icon-file";
    case "subcommand": return "icon-subcommand";
    case "option": return "icon-option";
    case "arg": return "icon-arg";
    case "special": return "icon-special";
    default: return "icon-file";
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
  const labels: Record<string, string> = {
    folder: "dir",
    file: "file",
    subcommand: "cmd",
    option: "opt",
    arg: "arg",
    special: "misc",
  };

  const text = labels[type];
  if (!text) return null;

  return (
    <span className={`flex-shrink-0 text-[7px] font-bold uppercase tracking-wider badge-${type}`}>
      {text}
    </span>
  );
}
