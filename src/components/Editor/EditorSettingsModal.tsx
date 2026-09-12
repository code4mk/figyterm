import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Braces,
  Files,
  GitCompare,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  Type,
  X,
} from "lucide-react";
import { DiffLayout, DiffStyle, EditorSettings } from "../../services/editor-session";
import { lsp, LspServerState } from "../../services/lsp/manager";

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

type SettingsTab = "appearance" | "editing" | "lsp" | "files" | "diff";

/**
 * The tabs, in the order they are used rather than alphabetically.
 *
 * Appearance and Editing first because they are what people open this for;
 * Language Server has a tab of its own because it is the one page with real
 * content — a table of servers, their state, and where to get them — and it was
 * previously a four-line section wedged between "word wrap" and "show hidden
 * files", which is not where a feature like that belongs.
 */
const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Type size={13} /> },
  { id: "editing", label: "Editing", icon: <PenLine size={13} /> },
  { id: "lsp", label: "Language Server", icon: <Braces size={13} /> },
  { id: "files", label: "Files", icon: <Files size={13} /> },
  { id: "diff", label: "Diff", icon: <GitCompare size={13} /> },
];

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
  const [tab, setTab] = useState<SettingsTab>("appearance");

  // Focused on open so Escape and Tab work without a click first — the same
  // reason the editor itself takes focus when it opens.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /**
   * Arrow keys move between tabs, wrapping at both ends.
   *
   * The rail is a `tablist`, and a tablist that can only be operated with the
   * pointer is one that keyboard users have to Tab through item by item.
   */
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : e.key === "Home"
            ? -TABS.length
            : e.key === "End"
              ? TABS.length
              : 0;
    if (!step) return;

    e.preventDefault();
    e.stopPropagation();
    const at = TABS.findIndex((entry) => entry.id === tab);
    const next = Math.min(TABS.length - 1, Math.max(0, at + step));
    const wrapped = step === 1 && at === TABS.length - 1 ? 0 : step === -1 && at === 0 ? TABS.length - 1 : next;
    setTab(TABS[wrapped].id);
    // Focus follows selection, which is what makes the arrows feel like a
    // list rather than a set of separate buttons.
    requestAnimationFrame(() => {
      document.getElementById(`editor-settings-tab-${TABS[wrapped].id}`)?.focus();
    });
  };

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
        className="editor-settings w-[620px] max-w-[94%] h-[440px] max-h-[84%] rounded-xl overflow-hidden flex flex-col focus:outline-none"
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

        <div className="flex flex-1 min-h-0">
          {/*
            A sidebar rather than a strip of tabs along the top. Five labels do
            not fit across a modal this narrow without truncating to initials,
            and it matches the app's own Settings dialog — which is the window
            people will have seen first.
          */}
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            className="editor-settings-sidebar w-[132px] shrink-0 py-2 px-1.5 overflow-y-auto"
            onKeyDown={onTabKeyDown}
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                id={`editor-settings-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`editor-settings-panel-${entry.id}`}
                /*
                  Only the selected tab is in the tab order. That is the
                  standard for a tablist and it is what makes Tab move *past*
                  the rail into the controls rather than through five buttons
                  first; the arrows move between tabs.
                */
                tabIndex={tab === entry.id ? 0 : -1}
                className={`editor-settings-tab w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] mb-0.5 ${
                  tab === entry.id ? "active" : ""
                }`}
                onClick={() => setTab(entry.id)}
              >
                {entry.icon}
                <span className="truncate">{entry.label}</span>
              </button>
            ))}
          </div>

          <div className="editor-settings-body flex-1 min-h-0 overflow-y-auto px-3 py-2">
            {tab === "appearance" && (
              <Panel id="appearance" title="Appearance">
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
              </Panel>
            )}

            {tab === "editing" && (
              <Panel id="editing" title="Editing">
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
              </Panel>
            )}

            {tab === "lsp" && (
              <Panel
                id="lsp"
                title="Language Server"
                hint="Diagnostics, hover types, completion and go-to-definition, from the servers installed on this machine. Nothing is bundled and nothing is downloaded."
              >
                <Toggle
                  label="Use language servers"
                  hint="Off by default: a language server is a heavyweight process, and this is a terminal that starts fast"
                  checked={settings.lsp}
                  onChange={(lsp) => onChange({ lsp })}
                />
                {settings.lsp && (
                  <>
                    <Toggle
                      label="Format on save"
                      hint="Where the server has a formatter; applied as one undoable edit"
                      checked={settings.lspFormatOnSave}
                      onChange={(lspFormatOnSave) => onChange({ lspFormatOnSave })}
                    />
                    <LanguageServers settings={settings} onChange={onChange} />
                  </>
                )}
              </Panel>
            )}

            {tab === "files" && (
              <Panel id="files" title="Files">
                <Toggle
                  label="Show hidden files"
                  hint="Dotfiles in the tree and in quick open"
                  checked={showHidden}
                  onChange={onSetShowHidden}
                />
              </Panel>
            )}

            {tab === "diff" && (
              <Panel id="diff" title="Diff">
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
              </Panel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The language-server table, with what was found on `PATH`.
 *
 * **A missing server is a first-class state, not a silent no-op.** Without this
 * list the feature would appear broken to everyone who hasn't already installed
 * the right program — they would turn it on, see nothing happen, and have no
 * way to find out why. So each row says whether it is there, and the ones that
 * aren't show the one command that installs them.
 */
function LanguageServers({
  settings,
  onChange,
}: {
  settings: EditorSettings;
  onChange: (patch: Partial<EditorSettings>) => void;
}) {
  const [states, setStates] = useState<LspServerState[]>(() => lsp.states());
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = useCallback(() => setStates(lsp.states()), []);

  useEffect(() => {
    // The first check can take a moment — it may have to run a login shell to
    // find out what the user's real PATH is.
    setChecking(true);
    void lsp
      .detect()
      .then(refresh)
      .finally(() => setChecking(false));
    // Servers start, index and stop while this panel is open.
    return lsp.onStatusChange(refresh);
  }, [refresh]);

  const recheck = () => {
    setChecking(true);
    void lsp
      .detect(true)
      .then(refresh)
      .finally(() => setChecking(false));
  };

  const setEnabled = (id: string, enabled: boolean) => {
    const next = { ...settings.lspServers, [id]: { ...settings.lspServers[id], enabled } };
    onChange({ lspServers: next });
  };

  const installed = states.filter((state) => state.path).length;
  const shown = states.filter((state) => matchesQuery(state, query));

  return (
    <div className="editor-lsp-servers mt-2">
      {/*
        A heading for the table, with the re-check beside it rather than
        stranded under the last row. The count is the answer to the question
        people actually open this tab with — "is anything going to happen?"
      */}
      <div className="editor-settings-subhead flex items-center gap-2 px-1 pb-1 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide flex-1">
          Servers
        </span>
        <span className="editor-settings-hint text-[10px]">
          {checking
            ? "checking…"
            : query
              ? `${shown.length} of ${states.length}`
              : `${installed} of ${states.length} installed`}
        </span>
        <button
          className="editor-btn-text flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
          onClick={recheck}
          disabled={checking}
          title="Look again for installed language servers"
        >
          <RefreshCw size={11} className={checking ? "animate-spin" : undefined} />
          Check again
        </button>
      </div>

      {/*
        Twenty-four rows is past the point where scanning beats searching, and
        the thing people arrive knowing is usually the *file* — "what handles
        .tsx" — rather than the server's name. So the query matches extensions
        too; see `matchesQuery`.
      */}
      <div className="editor-lsp-search relative mb-1.5">
        <Search size={11} className="editor-lsp-search-icon" aria-hidden />
        <input
          className="editor-settings-input w-full text-[11px] pl-6 pr-6 py-1 rounded"
          placeholder="Search by language, program or extension…"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            /*
              Escape clears the box, but only while there is something in it —
              otherwise it falls through to the dialog and closes it, which is
              what Escape does everywhere else in the editor. A search field
              that swallows Escape is a field you have to click out of.
            */
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
          aria-label="Search language servers"
        />
        {query && (
          <button
            className="editor-lsp-search-clear"
            onClick={() => setQuery("")}
            title="Clear (Esc)"
            aria-label="Clear search"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {shown.map((state) => (
        <div
          key={state.def.id}
          className={`editor-settings-row px-1 py-1.5${
            state.phase === "missing" ? " is-unavailable" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              className="editor-scm-checkbox shrink-0"
              checked={settings.lspServers[state.def.id]?.enabled !== false}
              onChange={(e) => setEnabled(state.def.id, e.target.checked)}
              aria-label={`Use ${state.def.label}`}
            />
            <span
              className="text-[11px] min-w-0 truncate"
              /* What this server claims, without spending a row on it. */
              title={claims(state)}
            >
              {state.def.label}
            </span>
            {/*
              Says why this one does not appear in the status bar and does not
              answer go-to-definition: it runs *alongside* whatever else claims
              the file rather than instead of it.
            */}
            {state.def.companion && (
              <span
                className="editor-lsp-chip text-[9px] px-1 rounded shrink-0"
                title="Runs alongside the other server for these files, rather than replacing it"
              >
                companion
              </span>
            )}
            <span className="flex-1" />
            <StatusChip state={state} />
            {/*
              Only where a process exists (or died). "Restart" against a server
              that has never started does nothing, and a button that does
              nothing is worse than no button.
            */}
            {RESTARTABLE.has(state.phase) && (
              <button
                className="editor-btn-text px-1 py-0.5 rounded text-[10px]"
                onClick={() => void lsp.restart(state.def.id)}
                title={`Restart ${state.def.program}`}
              >
                Restart
              </button>
            )}
          </div>
          <div className="editor-settings-hint text-[10px] mt-0.5 pl-[21px] break-all">
            {state.phase === "missing" ? (
              <>
                <code>{state.def.program}</code> is not on your PATH — install it
                with <code>{state.def.install}</code>
              </>
            ) : state.error ? (
              /*
                The install line goes with the error, not instead of it.

                A program can be on `PATH` and still not be installed:
                `~/.cargo/bin/rust-analyzer` is a rustup shim that exists whether
                or not the component does, and it fails at startup with "Unknown
                binary 'rust-analyzer' in official toolchain". Detection cannot
                see that — the file is there and it is executable — so the
                server's own words are the diagnosis and this is the cure.
              */
              <>
                {state.error}
                <br />
                Try <code>{state.def.install}</code>
              </>
            ) : (
              <code>{state.path ?? state.def.program}</code>
            )}
          </div>
        </div>
      ))}

      {!shown.length && (
        <div className="editor-settings-hint text-[10px] px-1 py-3 text-center">
          Nothing matches “{query}”.
          <button
            className="editor-btn-text px-1.5 py-0.5 rounded text-[10px] ml-1"
            onClick={() => setQuery("")}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** The files a server claims, for the row's tooltip. */
function claims(state: LspServerState): string {
  const extensions = Object.keys(state.def.extensions).map((ext) => `.${ext}`);
  const names = Object.keys(state.def.filenames ?? {});
  return [...extensions, ...names].join("  ");
}

/**
 * Whether a server matches what was typed.
 *
 * Matches the label, the program, the id **and the files it claims**, because
 * the thing people know is often the file rather than the server: "what handles
 * `.tsx`" is a far more common question than "is `typescript-language-server`
 * installed". A leading dot is ignored so both `.py` and `py` work.
 *
 * Every term must match something, so `type script` narrows rather than
 * widening — which is what a space between words means everywhere else.
 */
function matchesQuery(state: LspServerState, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

  const haystack = [
    state.def.label,
    state.def.program,
    state.def.id,
    ...Object.keys(state.def.extensions),
    ...Object.keys(state.def.filenames ?? {}),
  ]
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term.replace(/^\./, "")));
}

/** Phases where a Restart button has something to act on. */
const RESTARTABLE = new Set<LspServerState["phase"]>([
  "starting",
  "indexing",
  "ready",
  "failed",
]);

/** One word for what a server is doing, colour-coded by how good the news is. */
function StatusChip({ state }: { state: LspServerState }) {
  const label =
    state.phase === "off"
      ? "off"
      : state.phase === "missing"
        ? "not installed"
        : state.phase === "indexing"
          ? state.detail ?? "indexing"
          : state.phase === "ready"
            ? "running"
            : state.phase === "starting"
              ? "starting"
              : state.phase === "failed"
                ? "failed"
                : "idle";

  return (
    <span className={`editor-lsp-chip is-${state.phase} text-[9px] px-1 rounded shrink-0`}>
      {label}
    </span>
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

/**
 * One tab's page: a heading, an optional line of context, then the controls.
 *
 * The heading is kept even though the sidebar already names the tab — it is
 * what the optional hint hangs off, and a page that starts straight into a row
 * of checkboxes reads as a fragment of something rather than a place.
 */
function Panel({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="editor-settings-panel"
      role="tabpanel"
      id={`editor-settings-panel-${id}`}
      aria-labelledby={`editor-settings-tab-${id}`}
    >
      <div className="editor-settings-panel-head pb-1.5 mb-1">
        <div className="text-[12px] font-semibold">{title}</div>
        {hint && (
          <div className="editor-settings-hint text-[10px] mt-1 leading-snug">{hint}</div>
        )}
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
