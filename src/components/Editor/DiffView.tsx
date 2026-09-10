import { useMemo } from "react";
import { CircleAlert, Columns2, FileText, Rows3, X } from "lucide-react";
import {
  DiffSegment,
  parseDiff,
  SplitRow,
  toSplit,
  toUnified,
  UnifiedRow,
} from "../../services/diff";
import { DiffLayout, DiffStyle } from "../../services/editor-session";

/**
 * A unified or split diff of the working tree against HEAD.
 *
 * Rendered from `git diff`'s own output rather than recomputed from two file
 * contents: the diff on screen is then exactly the one `git diff` prints in the
 * pane behind, including whatever `diff.algorithm`, `diff.wsErrorHighlight` and
 * `.gitattributes` have to say about it. A second diff implementation here
 * would disagree with git about rename detection, whitespace and word
 * boundaries — and the first thing anyone does when a diff looks wrong is check
 * it against `git diff`.
 *
 * What *is* computed locally is the word diff inside a changed line, because
 * git's line diff simply doesn't contain it. `services/diff.ts` does that, and
 * explains why it isn't asked of `git --word-diff`.
 *
 * Two axes, both remembered:
 *
 * - **Layout** — unified or split. Neither is better: unified is compact and
 *   reads top to bottom, split shows what a line *was* next to what it *is*,
 *   which matters when both sides are long.
 * - **Style** — whose conventions to follow. Not a colour scheme: the presets
 *   differ in what they show. `plain` has no row tint and no word highlight
 *   because that is what a terminal `git diff` looks like, `vscode` drops the
 *   `+`/`-` signs because the colour already says it, `delta` numbers both
 *   sides in their own columns. They exist so that whichever tool someone
 *   already reads diffs in, this one can look like it.
 */

const LAYOUTS: { value: DiffLayout; label: string; icon: React.ReactNode }[] = [
  { value: "unified", label: "Unified", icon: <Rows3 size={12} /> },
  { value: "split", label: "Split", icon: <Columns2 size={12} /> },
];

const STYLES: { value: DiffStyle; label: string; detail: string }[] = [
  { value: "github", label: "GitHub", detail: "Tinted rows, word highlight, ± signs" },
  { value: "gitlab", label: "GitLab", detail: "As GitHub, with underlined words" },
  { value: "vscode", label: "VS Code", detail: "Colour bands, no signs" },
  { value: "delta", label: "Delta", detail: "Boxed line numbers, no signs" },
  { value: "plain", label: "git diff", detail: "Coloured text, nothing else" },
];

interface DiffViewProps {
  /** The file's name, for the header. */
  name: string;
  /** Repo-relative, beside the name so two same-named files are tellable apart. */
  relative: string;
  diff: string | null;
  loading: boolean;
  error: string | null;
  fontFamily: string;
  fontSize: number;
  layout: DiffLayout;
  style: DiffStyle;
  onSetLayout: (layout: DiffLayout) => void;
  onSetStyle: (style: DiffStyle) => void;
  onOpenFile: () => void;
  onClose: () => void;
}

export function DiffView({
  name,
  relative,
  diff,
  loading,
  error,
  fontFamily,
  fontSize,
  layout,
  style,
  onSetLayout,
  onSetStyle,
  onOpenFile,
  onClose,
}: DiffViewProps) {
  const parsed = useMemo(() => (diff ? parseDiff(diff) : null), [diff]);

  const empty = !parsed || parsed.hunks.length === 0;

  return (
    <div className="editor-diff flex flex-col h-full min-h-0">
      <div className="editor-diff-header flex items-center gap-2 px-2.5 h-[30px] shrink-0">
        <FileText size={12} className="shrink-0 opacity-70" />
        <span className="text-[11px] font-semibold truncate">{name}</span>
        <span className="editor-diff-path text-[10px] truncate flex-1 min-w-0">{relative}</span>

        {parsed && !parsed.binary && (
          <span className="editor-diff-counts text-[10px] shrink-0 tabular-nums">
            <span className="editor-diff-plus">+{parsed.added}</span>{" "}
            <span className="editor-diff-minus">−{parsed.removed}</span>
          </span>
        )}

        <div className="editor-diff-switch flex shrink-0" role="tablist">
          {LAYOUTS.map((option) => (
            <button
              key={option.value}
              role="tab"
              aria-selected={layout === option.value}
              className={`editor-diff-tab px-1.5 py-0.5 ${
                layout === option.value ? "on" : ""
              }`}
              onClick={() => onSetLayout(option.value)}
              title={`${option.label} diff`}
              aria-label={`${option.label} diff`}
            >
              {option.icon}
            </button>
          ))}
        </div>

        {/* A plain `<select>`: five presets with no state of their own, and the
            platform's own menu is both keyboard-navigable and out of the way. */}
        <select
          className="editor-diff-style text-[10px] shrink-0 rounded"
          value={style}
          onChange={(e) => onSetStyle(e.target.value as DiffStyle)}
          title={STYLES.find((option) => option.value === style)?.detail}
          aria-label="Diff style"
        >
          {STYLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          className="editor-btn-text px-1.5 py-0.5 rounded shrink-0 text-[10px]"
          onClick={onOpenFile}
          title="Open the file for editing"
        >
          Edit
        </button>
        <button
          className="editor-btn p-1 rounded shrink-0"
          onClick={onClose}
          title="Close the diff"
          aria-label="Close the diff"
        >
          <X size={12} />
        </button>
      </div>

      <div
        className="editor-diff-body flex-1 min-h-0 overflow-auto"
        data-diff-style={style}
        style={{ fontFamily, fontSize }}
      >
        {error ? (
          <div className="editor-diff-message flex items-start gap-2 px-3 py-3 text-[11px]">
            <CircleAlert size={12} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : loading ? (
          <div className="editor-diff-message px-3 py-3 text-[11px]">Reading the diff…</div>
        ) : parsed?.binary ? (
          <div className="editor-diff-message px-3 py-3 text-[11px]">
            This is a binary file. Git can tell it changed but not how.
          </div>
        ) : empty ? (
          <div className="editor-diff-message px-3 py-3 text-[11px]">
            This file matches the last commit.
          </div>
        ) : (
          <>
            {parsed.notes.length > 0 && (
              <div className="editor-diff-notes px-3 py-1 text-[10px]">
                {parsed.notes.join(" · ")}
              </div>
            )}

            {parsed.hunks.map((hunk, index) => (
              <div key={index} className="editor-diff-hunk">
                <div className="editor-diff-hunkhead px-3 py-1">{hunk.header}</div>
                {layout === "split" ? (
                  toSplit(hunk).map((row, rowIndex) => (
                    <SplitLine key={rowIndex} row={row} />
                  ))
                ) : (
                  toUnified(hunk).map((row, rowIndex) => (
                    <UnifiedLine key={rowIndex} row={row} />
                  ))
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function UnifiedLine({ row }: { row: UnifiedRow }) {
  return (
    <div className={`editor-diff-row ${row.kind}`}>
      {/* Classed by side, so a preset that shows only one of them can hide
          the other outright — a zero-width grid column still spills its text. */}
      <span className="editor-diff-num old">{row.oldNumber ?? ""}</span>
      <span className="editor-diff-num new">{row.newNumber ?? ""}</span>
      <span className="editor-diff-sign" aria-hidden>
        {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
      </span>
      <Text segments={row.segments} kind={row.kind} />
    </div>
  );
}

function SplitLine({ row }: { row: SplitRow }) {
  return (
    <div className="editor-diff-split">
      <Side side={row.left} />
      <Side side={row.right} />
    </div>
  );
}

function Side({ side }: { side: SplitRow["left"] }) {
  // An absent side is the gap where lines were added or removed rather than
  // changed — the thing a split view is for — so it is drawn, not skipped.
  if (!side) {
    return (
      <div className="editor-diff-half filler" aria-hidden>
        <span className="editor-diff-num" />
        <span className="editor-diff-text" />
      </div>
    );
  }
  return (
    <div className={`editor-diff-half ${side.kind}`}>
      <span className="editor-diff-num">{side.number}</span>
      <Text segments={side.segments} kind={side.kind} />
    </div>
  );
}

/**
 * A line's text, with the changed words marked.
 *
 * `text || " "` because an empty added or removed line still has to occupy a
 * row — a blank line being added is a real change, and a zero-height row of
 * colour reads as a rendering bug.
 */
function Text({ segments, kind }: { segments: DiffSegment[]; kind: string }) {
  const blank = segments.every((segment) => !segment.text);
  return (
    <span className="editor-diff-text">
      {blank
        ? " "
        : segments.map((segment, index) =>
            segment.changed && kind !== "context" ? (
              <mark key={index} className="editor-diff-word">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
    </span>
  );
}
