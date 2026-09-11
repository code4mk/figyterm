import { ReactNode, useEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";
import { DiffLayout, DiffStyle, EditorSettings } from "../../services/editor-session";

/**
 * The editor's own settings, in the editor's own window.
 *
 * Not a page in the app's Settings dialog, for two reasons that both come down
 * to where it lives. That dialog is Headless UI's, which makes `#root` inert
 * while it is open — the exact problem `OverlayPortal` exists to work around —
 * so opening it from inside the editor would freeze the editor behind it. And
 * these settings are about a window you are looking at: font size and line
 * height are judged by reading the code next to them, which needs the code
 * still on screen, not covered by a full-window dialog.
 *
 * So it is an overlay inside the editor, as quick open and go-to-line are, and
 * every control applies **immediately**. No Save button: there is nothing to
 * batch, and a checkbox you have to confirm is a checkbox that lies about what
 * the editor currently looks like.
 *
 * There is no chord for it. `⌘,` belongs to the app's own Settings, and on
 * macOS it is a native menu accelerator — translated before the webview sees
 * the key — so the editor could not claim it even if that were the right call.
 * The gear in the toolbar and the text surface's context menu are the way in.
 */

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
const LINE_HEIGHTS = [1.2, 1.35, 1.5, 1.55, 1.7, 2];
const INDENT_WIDTHS = [2, 4, 8];

const DIFF_LAYOUTS: { value: DiffLayout; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

const DIFF_STYLES: { value: DiffStyle; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "vscode", label: "VS Code" },
  { value: "delta", label: "Delta" },
  { value: "plain", label: "git diff" },
];

interface EditorSettingsModalProps {
  settings: EditorSettings;
  /** The terminal's font, shown as what "Match the terminal" resolves to. */
  terminalFont: { family: string; size: number };
  showHidden: boolean;
  diffLayout: DiffLayout;
  diffStyle: DiffStyle;
  onChange: (patch: Partial<EditorSettings>) => void;
  onSetShowHidden: (show: boolean) => void;
  onSetDiffLayout: (layout: DiffLayout) => void;
  onSetDiffStyle: (style: DiffStyle) => void;
  onReset: () => void;
  onClose: () => void;
}

export function EditorSettingsModal({
  settings,
  terminalFont,
  showHidden,
  diffLayout,
  diffStyle,
  onChange,
  onSetShowHidden,
  onSetDiffLayout,
  onSetDiffStyle,
  onReset,
  onClose,
}: EditorSettingsModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focused on open so Escape and Tab work without a click first — the same
  // reason the editor itself takes focus when it opens.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nothing in here is one of the editor's chords, and a keystroke reaching
    // the document behind would edit a file the user cannot see.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="editor-overlay-backdrop absolute inset-0 z-[260] flex items-start justify-center pt-[6%]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Editor settings"
        className="editor-settings w-[420px] max-w-[92%] max-h-[80%] rounded-xl overflow-hidden flex flex-col focus:outline-none"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div className="editor-settings-header flex items-center gap-2 px-3 h-[34px] shrink-0">
          <span className="text-[12px] font-semibold flex-1">Editor Settings</span>
          <button
            className="editor-btn-text flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
            onClick={onReset}
            title="Put every editor setting back to its default"
          >
            <RotateCcw size={11} />
            Reset
          </button>
          <button
            className="editor-btn p-1 rounded"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close settings"
          >
            <X size={12} />
          </button>
        </div>

        <div className="editor-settings-body flex-1 min-h-0 overflow-y-auto px-3 py-2">
          <Section title="Appearance">
            <Row
              label="Font"
              hint={
                settings.fontFamily
                  ? undefined
                  : `Matching the terminal — ${firstFamily(terminalFont.family)}`
              }
            >
              <input
                className="editor-settings-input flex-1 min-w-0 text-[11px] px-2 py-1 rounded"
                placeholder="Match the terminal"
                spellCheck={false}
                value={settings.fontFamily}
                onChange={(e) => onChange({ fontFamily: e.target.value })}
              />
            </Row>

            <Row
              label="Size"
              hint={
                settings.fontSize
                  ? undefined
                  : `Matching the terminal — ${terminalFont.size}px`
              }
            >
              <Select
                value={String(settings.fontSize)}
                onChange={(value) => onChange({ fontSize: Number(value) })}
                options={[
                  { value: "0", label: "Match the terminal" },
                  ...FONT_SIZES.map((size) => ({
                    value: String(size),
                    label: `${size}px`,
                  })),
                ]}
              />
            </Row>

            <Row label="Line height">
              <Select
                value={String(settings.lineHeight)}
                onChange={(value) => onChange({ lineHeight: Number(value) })}
                options={LINE_HEIGHTS.map((height) => ({
                  value: String(height),
                  label: height.toFixed(2).replace(/0$/, ""),
                }))}
              />
            </Row>

            <Toggle
              label="Indentation guides"
              hint="Faint lines down each level, with the block you are in brighter"
              checked={settings.indentGuides}
              onChange={(indentGuides) => onChange({ indentGuides })}
            />
          </Section>

          <Section title="Editing">
            <Row
              label="Indentation"
              hint="Used when a file's own indentation can't be detected"
            >
              <Select
                value={settings.useTabs ? "tabs" : "spaces"}
                onChange={(value) => onChange({ useTabs: value === "tabs" })}
                options={[
                  { value: "spaces", label: "Spaces" },
                  { value: "tabs", label: "Tabs" },
                ]}
              />
              <Select
                value={String(settings.indentWidth)}
                onChange={(value) => onChange({ indentWidth: Number(value) })}
                options={INDENT_WIDTHS.map((width) => ({
                  value: String(width),
                  label: String(width),
                }))}
              />
            </Row>

            <Toggle
              label="Word wrap"
              hint="Where new files start; the status bar still toggles it per file"
              checked={settings.wordWrap}
              onChange={(wordWrap) => onChange({ wordWrap })}
            />
            <Toggle
              label="Close brackets automatically"
              checked={settings.autoCloseBrackets}
              onChange={(autoCloseBrackets) => onChange({ autoCloseBrackets })}
            />
            <Toggle
              label="Complete words from the document"
              hint="There is no language server; this is what stands in for one"
              checked={settings.wordCompletion}
              onChange={(wordCompletion) => onChange({ wordCompletion })}
            />
          </Section>

          <Section title="Files">
            <Toggle
              label="Show hidden files"
              hint="Dotfiles in the tree and in quick open"
              checked={showHidden}
              onChange={onSetShowHidden}
            />
          </Section>

          <Section title="Diff">
            <Row label="Layout">
              <Select
                value={diffLayout}
                onChange={(value) => onSetDiffLayout(value as DiffLayout)}
                options={DIFF_LAYOUTS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </Row>
            <Row label="Style" hint="Whose diff conventions to follow">
              <Select
                value={diffStyle}
                onChange={(value) => onSetDiffStyle(value as DiffStyle)}
                options={DIFF_STYLES.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </Row>
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * The first family out of a CSS font stack.
 *
 * The stored value is a whole stack — `Menlo, Monaco, 'Courier New',
 * monospace` — and showing all of it as the answer to "what am I looking at"
 * is showing the fallbacks as though they were the choice.
 */
function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? stack).trim().replace(/^['"]|['"]$/g, "");
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="editor-settings-section">
      <div className="editor-settings-title text-[10px] font-semibold uppercase tracking-wide px-1 pb-1 pt-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="editor-settings-row px-1 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] flex-1 min-w-0 truncate">{label}</span>
        <div className="flex items-center gap-1.5 shrink-0 min-w-0">{children}</div>
      </div>
      {hint && <div className="editor-settings-hint text-[10px] mt-0.5">{hint}</div>}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="editor-settings-row block px-1 py-1.5 cursor-pointer">
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          className="editor-scm-checkbox shrink-0"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-[11px] flex-1 min-w-0">{label}</span>
      </span>
      {hint && (
        <span className="editor-settings-hint text-[10px] block mt-0.5 pl-[21px]">
          {hint}
        </span>
      )}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      className="editor-settings-select text-[11px] rounded px-1 py-0.5"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
