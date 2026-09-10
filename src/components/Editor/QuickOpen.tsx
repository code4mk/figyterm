import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { scrollIntoViewWithin } from "../../services/scroll";
import { joinPath, listFiles, relativeTo } from "../../services/editor-fs";
import { fuzzyFilter } from "../../services/fuzzy";
import { FileIcon } from "./fileIcons";

/**
 * Fuzzy file finder — ⌘P.
 *
 * The whole file list is fetched once when it opens (capped and `.gitignore`d
 * on the Rust side) and filtered in memory as the user types, because the
 * alternative — a round trip per keystroke — is exactly the latency that makes
 * a finder like this feel worse than scrolling the tree.
 */

/** Rows shown at once. More than this and the list is the wrong tool. */
const MAX_RESULTS = 60;

interface QuickOpenProps {
  root: string;
  showHidden: boolean;
  /** Paths of the currently open tabs, offered before anything is typed. */
  recentPaths: string[];
  onPick: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export function QuickOpen({
  root,
  showHidden,
  recentPaths,
  onPick,
  onClose,
  onError,
}: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listFiles(root, showHidden)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
        setTruncated(result.truncated);
      })
      .catch((error) => {
        if (cancelled) return;
        setFiles([]);
        onError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [root, showHidden, onError]);

  const results = useMemo(() => {
    if (!files) return [];

    // Nothing typed: the open tabs, which is what ⌘P is most often used to
    // flick between.
    if (!query.trim()) {
      return recentPaths
        .map((path) => ({
          item: relativeTo(root, path),
          score: 0,
          matches: [] as number[],
        }))
        .slice(0, MAX_RESULTS);
    }

    return fuzzyFilter(files, query.trim(), (file) => file, MAX_RESULTS);
  }, [files, query, recentPaths, root]);

  useEffect(() => setSelected(0), [query]);

  // Keeps the keyboard selection inside the scroll window.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[selected] as HTMLElement | undefined;
    scrollIntoViewWithin(list, row);
  }, [selected]);

  const choose = (relative: string) => {
    onPick(joinPath(root, relative));
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (results[selected]) choose(results[selected].item);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      className="editor-overlay-backdrop absolute inset-0 z-[260] flex items-start justify-center pt-[8%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="editor-palette w-[460px] max-w-[92%] rounded-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="editor-palette-field flex items-center gap-2 px-3 py-2">
          <Search size={13} className="editor-palette-icon shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.stopPropagation()}
            onPaste={(e) => e.stopPropagation()}
            placeholder={files ? "Go to file…" : "Reading the project…"}
            spellCheck={false}
            className="editor-palette-input flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          />
          {truncated && (
            <span
              className="editor-palette-hint text-[10px] shrink-0"
              title="Only the first 20,000 files were listed — narrow the folder to search all of them"
            >
              partial
            </span>
          )}
        </div>

        <div ref={listRef} className="editor-palette-list max-h-[300px] overflow-y-auto py-1">
          {results.map((result, index) => (
            <div
              key={result.item}
              className={`editor-palette-row flex items-center gap-2 px-3 py-1.5 ${
                index === selected ? "selected" : ""
              }`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(result.item)}
            >
              <FileIcon path={result.item} />
              <span className="flex-1 min-w-0 truncate text-[12px]">
                <Highlighted text={result.item} matches={result.matches} />
              </span>
            </div>
          ))}

          {files && results.length === 0 && (
            <div className="editor-palette-empty px-3 py-5 text-center text-[11px]">
              {query.trim() ? "No matching files" : "No files in this folder"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shows which characters the query matched.
 *
 * The directory part is dimmed and the filename left bright, so a list of
 * `src/components/Editor/…` paths can be read by its last segment.
 */
function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  const hits = new Set(matches);

  return (
    <>
      {[...text].map((char, index) => (
        <span
          key={index}
          className={`${index < cut ? "editor-palette-dim" : ""} ${
            hits.has(index) ? "editor-palette-match" : ""
          }`}
        >
          {char}
        </span>
      ))}
    </>
  );
}
