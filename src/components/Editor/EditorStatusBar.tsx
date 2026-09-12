import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, GitBranch, WrapText } from "lucide-react";
import { GitRepo } from "../../services/git";
import { lsp, LspServerState } from "../../services/lsp/manager";
import { installHint } from "../../services/lsp/servers";
import {
  defaultInterpreter,
  Interpreter,
  interpreterLabel,
} from "../../services/lsp/python";
import { scrollIntoViewWithin } from "../../services/scroll";
import { FileEncoding, LineEnding } from "../../services/editor-fs";
import { availableLanguages, labelFor } from "../../services/editor-lang";
import { EditorBuffer } from "../../stores/editorStore";

/**
 * The bar along the bottom: what the file is, where the cursor is, and the
 * resize grip.
 *
 * Language, line ending and encoding are all clickable, because all three are
 * things you occasionally need to change and nowhere else in the editor is a
 * sensible place to put them. Line ending especially: it's the setting that
 * silently turns a one-line change into a whole-file diff, so it's worth being
 * visible rather than buried.
 */

const LINE_ENDINGS: { value: LineEnding; label: string; detail: string }[] = [
  { value: "lf", label: "LF", detail: "Unix (\\n)" },
  { value: "crlf", label: "CRLF", detail: "Windows (\\r\\n)" },
];

const ENCODINGS: { value: FileEncoding; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-8-bom", label: "UTF-8 with BOM" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

/**
 * What the indent picker offers.
 *
 * Tabs have no width to choose — how wide one renders is `tabSize`, and the
 * options below set it — so "Tabs" appears once per width rather than as a
 * separate axis. Two, four and eight because those are the widths that exist
 * in the wild; a picker with every number from one to sixteen is a picker
 * nobody finds "4" in.
 */
const INDENTS: { useTabs: boolean; width: number; label: string; detail: string }[] = [
  { useTabs: false, width: 2, label: "2 spaces", detail: "Spaces" },
  { useTabs: false, width: 4, label: "4 spaces", detail: "Spaces" },
  { useTabs: false, width: 8, label: "8 spaces", detail: "Spaces" },
  { useTabs: true, width: 2, label: "Tabs, width 2", detail: "Tabs" },
  { useTabs: true, width: 4, label: "Tabs, width 4", detail: "Tabs" },
  { useTabs: true, width: 8, label: "Tabs, width 8", detail: "Tabs" },
];

export interface Indent {
  useTabs: boolean;
  width: number;
}

interface EditorStatusBarProps {
  buffer: EditorBuffer | null;
  cursor: { line: number; column: number };
  wrapped: boolean;
  bufferCount: number;
  watcherMechanism: "native" | "poll" | null;
  git: GitRepo;
  /** What a level of indentation currently is, for the picker's label. */
  indent: Indent;
  onSetIndent: (indent: Indent) => void;
  onOpenSourceControl: () => void;
  onToggleWrap: () => void;
  onSetLanguage: (languageId: string) => void;
  onSetLineEnding: (lineEnding: LineEnding) => void;
  onSetEncoding: (encoding: FileEncoding) => void;
  onGoToLine: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
  /** The workspace, for finding environments inside it. */
  pythonRoot: string | null;
  /** The interpreter the user chose for this workspace, if any. */
  pythonPath: string | null;
  /** Detected interpreters, owned by the modal so they are found once. */
  pythonInterpreters: Interpreter[];
  pythonLoading: boolean;
  onSetPythonPath: (path: string | null) => void;
  onRefreshInterpreters: () => void;
}

export function EditorStatusBar({
  buffer,
  cursor,
  wrapped,
  bufferCount,
  watcherMechanism,
  git,
  indent,
  onSetIndent,
  onOpenSourceControl,
  onToggleWrap,
  onSetLanguage,
  onSetLineEnding,
  onSetEncoding,
  onGoToLine,
  onResizeStart,
  pythonRoot,
  pythonPath,
  pythonInterpreters,
  pythonLoading,
  onSetPythonPath,
  onRefreshInterpreters,
}: EditorStatusBarProps) {
  const [open, setOpen] = useState<
    "language" | "lineEnding" | "encoding" | "indent" | null
  >(null);

  return (
    <div
      className="editor-chrome editor-statusbar flex items-center gap-2 px-2.5 h-[24px] shrink-0"
      onContextMenu={(e) => e.preventDefault()}
    >
      {buffer ? (
        <>
          <button
            className="editor-status-item text-[10px] tabular-nums"
            onClick={onGoToLine}
            title="Go to line (⌘G)"
          >
            Ln {cursor.line}, Col {cursor.column}
          </button>

          <Popup
            open={open === "language"}
            onOpenChange={(next) => setOpen(next ? "language" : null)}
            label={labelFor(buffer.languageId)}
            title="Select language mode"
            items={availableLanguages().map((language) => ({
              key: language.id,
              label: language.label,
              selected: language.id === buffer.languageId,
              onSelect: () => onSetLanguage(language.id),
            }))}
          />

          <Popup
            open={open === "lineEnding"}
            onOpenChange={(next) => setOpen(next ? "lineEnding" : null)}
            label={buffer.lineEnding.toUpperCase()}
            title="Line endings"
            items={LINE_ENDINGS.map((option) => ({
              key: option.value,
              label: option.label,
              detail: option.detail,
              selected: option.value === buffer.lineEnding,
              onSelect: () => onSetLineEnding(option.value),
            }))}
          />

          {/*
            Where the layout notes always said it should be, and the last of
            the four that was missing. It is also the setting that quietly
            turns a one-line change into a whole-file diff, so it is worth
            being visible rather than detected and never mentioned again.
          */}
          <Popup
            open={open === "indent"}
            onOpenChange={(next) => setOpen(next ? "indent" : null)}
            label={
              indent.useTabs ? `Tab ${indent.width}` : `Spaces ${indent.width}`
            }
            title="Indentation — applies to new indentation, not to lines already in the file"
            items={INDENTS.map((option) => ({
              key: `${option.useTabs ? "tab" : "space"}-${option.width}`,
              label: option.label,
              detail: option.detail,
              selected:
                option.useTabs === indent.useTabs && option.width === indent.width,
              onSelect: () =>
                onSetIndent({ useTabs: option.useTabs, width: option.width }),
            }))}
          />

          <Popup
            open={open === "encoding"}
            onOpenChange={(next) => setOpen(next ? "encoding" : null)}
            label={encodingLabel(buffer.encoding)}
            title="File encoding"
            items={ENCODINGS.map((option) => ({
              key: option.value,
              label: option.label,
              selected: option.value === buffer.encoding,
              onSelect: () => onSetEncoding(option.value),
            }))}
          />

          {buffer.languageId === "python" && (
            <PythonInterpreter
              root={pythonRoot}
              chosen={pythonPath}
              found={pythonInterpreters}
              loading={pythonLoading}
              onChoose={onSetPythonPath}
              onRefresh={onRefreshInterpreters}
            />
          )}

          <LspIndicator path={buffer.path} />

          <button
            className={`editor-status-item ${wrapped ? "on" : ""}`}
            onClick={onToggleWrap}
            title={wrapped ? "Disable word wrap" : "Enable word wrap"}
            aria-pressed={wrapped}
          >
            <WrapText size={11} />
          </button>

          {buffer.readonly && (
            <span
              className="editor-status-tag text-[10px]"
              title={
                buffer.large
                  ? "This file is too large to edit comfortably, so it opened read-only"
                  : "This file is not writable"
              }
            >
              read-only
            </span>
          )}

          {buffer.disk !== "ok" && (
            <span
              className="editor-status-tag warn text-[10px]"
              title={
                buffer.disk === "missing"
                  ? "This file was not found on disk — saving will recreate it"
                  : "Changed on disk since it was opened"
              }
            >
              {buffer.disk === "missing" ? "not on disk" : "changed on disk"}
            </span>
          )}
        </>
      ) : (
        <span className="editor-status-text text-[10px]">No file open</span>
      )}

      <div className="flex-1" />

      {/*
        The branch, where every editor and every shell prompt puts it. Clicking
        it opens the panel, which is the only chord-free way in — ⌘⇧G is
        CodeMirror's find-previous and taking it would cost more than it gave.
      */}
      {git.isRepo && (
        <button
          className="editor-status-item flex items-center gap-1 text-[10px]"
          onClick={onOpenSourceControl}
          title={
            git.ahead > 0
              ? `${git.ahead} commit${git.ahead === 1 ? "" : "s"} to push${
                  git.upstream ? ` to ${git.upstream}` : ""
                }`
              : git.upstream
                ? `Source control — tracking ${git.upstream}`
                : "Source control"
          }
        >
          <GitBranch size={10} />
          <span className="max-w-[140px] truncate">
            {git.detached ? "detached" : git.branch ?? "no branch"}
          </span>
          {/* Accented, because unlike the branch name this one is telling you
              something needs doing. */}
          {git.ahead > 0 && (
            <span className="editor-status-ahead flex items-center tabular-nums">
              <ArrowUp size={9} />
              {git.ahead}
            </span>
          )}
          {git.behind > 0 && (
            <span className="flex items-center tabular-nums">
              <ArrowDown size={9} />
              {git.behind}
            </span>
          )}
          {git.files.length > 0 && (
            <span className="editor-status-dot" aria-label="uncommitted changes" />
          )}
        </button>
      )}

      {watcherMechanism === "poll" && (
        <span
          className="editor-status-tag warn text-[10px]"
          title="The system's file-change notifications were unavailable, so changes are polled every few seconds"
        >
          polling
        </span>
      )}

      <span className="editor-status-text text-[10px]">
        {bufferCount} {bufferCount === 1 ? "file" : "files"}
      </span>

      {/*
        The grip lives in the status bar for the same reason the browser's does:
        it needs somewhere nothing else is competing for the pointer.
      */}
      <div
        className="editor-resize-handle"
        onPointerDown={onResizeStart}
        title="Resize"
        role="separator"
        aria-orientation="horizontal"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="editor-resize-icon">
          <path
            d="M9 1L1 9M9 5L5 9"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

/**
 * Which Python this project is analysed against.
 *
 * Shown only for Python files, next to the language — where VS Code puts it,
 * because that is where people already look for it. It exists because pyright
 * without an interpreter resolves against the system Python, and in a project
 * with a `.venv` that means every third-party import is reported as missing:
 * not a subtle degradation, a language server that appears broken.
 *
 * The list is detected each time it opens rather than cached, because creating
 * a `.venv` in the terminal behind is exactly when someone opens this.
 */
function PythonInterpreter({
  root,
  chosen,
  found,
  loading,
  onChoose,
  onRefresh,
}: {
  root: string | null;
  chosen: string | null;
  found: Interpreter[];
  loading: boolean;
  onChoose: (path: string | null) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);

  /*
    The list is owned by the modal, not fetched here.

    Both were detecting independently, which meant two passes of
    `python --version` subprocesses for one answer — and the modal's copy is the
    one that has to exist anyway, because the *manager* needs the interpreter
    before pyright resolves a single import, whether or not this picker is on
    screen.

    Opening still asks for a refresh: creating a `.venv` in the terminal behind
    and then reaching for this menu is exactly the sequence to support.
  */
  useEffect(() => {
    if (open) onRefresh();
    // `onRefresh` is stable; re-running on its identity would refetch per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const recommended = defaultInterpreter(found);
  const active = chosen ?? recommended?.path ?? null;
  const label = active ? interpreterLabel(active, root) : "Select interpreter";

  /*
    VS Code's shape: the version as the title, the environment or path beneath,
    and the in-project one marked. The mark matters more than it looks — with
    three Pythons listed and no guidance, the one that resolves the project's
    imports is indistinguishable from two that don't.
  */
  const items: PopupItem[] = found.map((entry) => ({
    key: entry.path,
    label: entry.environment ? `${entry.label} ('${entry.environment}')` : entry.label,
    detail: entry.detail,
    badge: entry.path === recommended?.path ? "Recommended" : undefined,
    selected: entry.path === active,
    onSelect: () => onChoose(entry.path),
  }));

  // Only meaningful once a choice has been made; before that it is what is
  // already happening.
  if (chosen) {
    items.push({
      key: "__auto",
      label: "Detect automatically",
      detail: recommended ? interpreterLabel(recommended.path, root) : "none found",
      selected: false,
      onSelect: () => onChoose(null),
    });
  }

  if (!found.length) {
    items.push({
      key: "__none",
      label: loading ? "Looking for interpreters…" : "No interpreters found",
      detail: loading ? undefined : "python3 -m venv .venv",
      selected: false,
      onSelect: () => {},
    });
  }

  return (
    <Popup
      open={open}
      onOpenChange={setOpen}
      label={label}
      title={
        active
          ? `Python interpreter — ${active}`
          : "No Python interpreter selected; imports will resolve against the system Python"
      }
      items={items}
    />
  );
}

/**
 * Which language server this file has, and what it is doing.
 *
 * **Visible cost.** A language server is a heavyweight process the user opted
 * into, and "rust-analyzer: indexing" is the difference between an editor that
 * is slow and one that looks broken. Silence here would mean a minute of cold
 * start indistinguishable from a feature that doesn't work.
 *
 * Nothing at all is rendered for a file no server claims — which is most of
 * them — so the bar doesn't grow a permanent empty slot for Markdown and TOML.
 */
function LspIndicator({ path }: { path: string | null }) {
  /*
    Keyed on the path, not the editor's language id. Those ids pick a
    *highlighting grammar* and are approximate — `.kt` is highlighted as `cpp`
    — so asking by language would report the C++ server's state on a Kotlin
    file. See `servers.ts`.
  */
  const [state, setState] = useState<LspServerState | null>(() =>
    path ? lsp.stateFor(path) : null
  );

  const refresh = useCallback(
    () => setState(path ? lsp.stateFor(path) : null),
    [path]
  );

  useEffect(() => {
    refresh();
    return lsp.onStatusChange(refresh);
  }, [refresh]);

  // `off` covers both "the master switch is off" and "this language is
  // switched off", and in neither case has the user asked to be told about it.
  if (!state || state.phase === "off" || state.phase === "idle") return null;

  /*
    Quiet when healthy, loud when not.

    A ready server shows the dot and nothing else: the language is already named
    by the picker immediately to the left, so spelling it out again is one more
    thing to read in a bar that is mostly numbers. Anything the user might need
    to act on — indexing, starting, missing, failed — says so in words.
  */
  const label =
    state.phase === "indexing"
      ? state.detail ?? "indexing"
      : state.phase === "ready"
        ? null
        : state.phase === "starting"
          ? "starting"
          : state.phase === "missing"
            ? "no server"
            : state.phase;

  const title =
    state.phase === "missing"
      ? `${state.def.program} is not on your PATH — install it with: ${installHint(state.def)}`
      : state.error
        ? `${state.def.program}: ${state.error}`
        : state.phase === "ready"
          ? `${state.def.program} is running — click to restart`
          : `${state.def.program} — click to restart`;

  return (
    <button
      className={`editor-status-item editor-lsp-status is-${state.phase} text-[10px]`}
      title={title}
      onClick={() => {
        if (state.phase !== "missing") void lsp.restart(state.def.id);
      }}
    >
      <span className="editor-lsp-dot" aria-hidden />
      {label}
    </button>
  );
}

function encodingLabel(encoding: FileEncoding): string {
  return ENCODINGS.find((option) => option.value === encoding)?.label ?? encoding;
}

interface PopupItem {
  key: string;
  label: string;
  detail?: string;
  /**
   * A short marker after the label — "Recommended".
   *
   * Distinct from `detail`, which is dimmed and right-aligned for a value; this
   * is a claim *about* the row and sits with the label it qualifies.
   */
  badge?: string;
  selected: boolean;
  onSelect: () => void;
}

/** A status-bar button whose menu opens upwards, since there's nothing below. */
function Popup({
  open,
  onOpenChange,
  label,
  title,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  title: string;
  items: PopupItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [open, onOpenChange]);

  // The selected row is scrolled to when the menu opens — the language list is
  // long enough that otherwise the current value is often off-screen.
  useEffect(() => {
    if (!open) return;
    const list = ref.current?.querySelector<HTMLElement>("[role=listbox]") ?? null;
    const row = ref.current?.querySelector<HTMLElement>("[data-selected]") ?? null;
    scrollIntoViewWithin(list, row, { block: "center" });
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className={`editor-status-item text-[10px] ${open ? "on" : ""}`}
        onClick={() => onOpenChange(!open)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {label}
      </button>

      {open && (
        <div
          className="editor-status-popup absolute bottom-full mb-1.5 left-0 min-w-[150px] max-h-[220px] overflow-y-auto py-1 rounded-lg"
          role="listbox"
        >
          {items.map((item) => (
            <button
              key={item.key}
              role="option"
              aria-selected={item.selected}
              data-selected={item.selected ? "" : undefined}
              className={`editor-status-option flex items-center gap-2 w-full px-2.5 py-1 text-[11px] text-left ${
                item.selected ? "selected" : ""
              }`}
              onClick={() => {
                item.onSelect();
                onOpenChange(false);
              }}
            >
              <span className="w-3 shrink-0">
                {item.selected && <Check size={11} />}
              </span>
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.badge && (
                <span className="editor-status-option-badge text-[9px] shrink-0">
                  {item.badge}
                </span>
              )}
              {item.detail && (
                <span className="editor-status-option-detail text-[10px] shrink-0">
                  {item.detail}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
