import { Fragment, useEffect, useState, useMemo } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {
  X,
  Moon,
  Sun,
  Palette,
  Check,
  Eye,
  Keyboard,
  Terminal as TerminalIcon,
  Command,
  SplitSquareHorizontal,
  Package,
  Download,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { Settings as SettingsType } from "../../services/settings";
import {
  fetchRegistry,
  installSpec,
  removeSpec,
  listInstalledSpecs,
  type RemoteSpecEntry,
  type InstalledSpec,
} from "../../services/spec-store";
import { specRegistry } from "../../services/figy-spec-registry";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  activeSessionId?: string | null;
}

interface ShellCommandOutput {
  stdout: string;
  stderr: string;
  status: number;
}

type SettingsTab = "general" | "terminal" | "theme" | "shortcuts" | "specs";

export function Settings({ isOpen, onClose, activeSessionId }: SettingsProps) {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const { theme, setTheme } = useThemeStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  const [zshTheme, setZshTheme] = useState<string>("");
  const [availableThemes, setAvailableThemes] = useState<string[]>([]);
  const [customThemes, setCustomThemes] = useState<string[]>([]);
  const [loadingThemes, setLoadingThemes] = useState(false);
  const [customThemePath, setCustomThemePath] = useState<string>("");
  const [customThemeError, setCustomThemeError] = useState<string>("");
  const [isCustomTheme, setIsCustomTheme] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    loadOhMyZshThemes();
  }, [isOpen]);

  async function getHomeDir(): Promise<string> {
    try {
      const result = await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sh",
        args: ["-c", "echo $HOME"],
        cwd: null,
      });
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    } catch {}
    return "/tmp";
  }

  async function loadOhMyZshThemes() {
    setLoadingThemes(true);
    try {
      const home = await getHomeDir();

      const [activeResult, listResult, customListResult, customSourceResult] = await Promise.all([
        invoke<ShellCommandOutput>("execute_shell_command", {
          command: "grep",
          args: ["-E", "^ZSH_THEME=", `${home}/.zshrc`],
          cwd: null,
        }),
        invoke<ShellCommandOutput>("execute_shell_command", {
          command: "ls",
          args: [`${home}/.oh-my-zsh/themes`],
          cwd: null,
        }),
        invoke<ShellCommandOutput>("execute_shell_command", {
          command: "sh",
          args: ["-c", `ls ${home}/.oh-my-zsh/custom/themes/ 2>/dev/null`],
          cwd: null,
        }),
        invoke<ShellCommandOutput>("execute_shell_command", {
          command: "grep",
          args: ["-E", "^source.*\\.zsh-theme", `${home}/.zshrc`],
          cwd: null,
        }),
      ]);

      if (activeResult.status === 0 && activeResult.stdout.trim()) {
        const match = activeResult.stdout.trim().match(/ZSH_THEME="([^"]+)"/);
        if (match) setZshTheme(match[1]);
      }

      if (customSourceResult.status === 0 && customSourceResult.stdout.trim()) {
        const srcMatch = customSourceResult.stdout.trim().match(/source\s+["']?([^"'\s]+\.zsh-theme)["']?/);
        if (srcMatch) {
          setCustomThemePath(srcMatch[1]);
          setIsCustomTheme(true);
        }
      }

      if (listResult.status === 0 && listResult.stdout.trim()) {
        const themes = listResult.stdout
          .trim()
          .split("\n")
          .filter((f) => f.endsWith(".zsh-theme"))
          .map((f) => f.replace(".zsh-theme", ""))
          .sort();
        setAvailableThemes(themes);
      }

      if (customListResult.status === 0 && customListResult.stdout.trim()) {
        const cThemes = customListResult.stdout
          .trim()
          .split("\n")
          .filter((f) => f.endsWith(".zsh-theme"))
          .map((f) => f.replace(".zsh-theme", ""))
          .sort();
        setCustomThemes(cThemes);
      }
    } catch {}
    setLoadingThemes(false);
  }

  async function reloadShellTheme(themeName: string, isCustomPath?: string) {
    if (!activeSessionId) return;
    const home = await getHomeDir();

    let cmd: string;
    if (isCustomPath) {
      cmd = `export ZSH_THEME="" && source "${isCustomPath}"\n`;
    } else {
      cmd = `export ZSH_THEME="${themeName}" && ` +
        `if [ -f "${home}/.oh-my-zsh/custom/themes/${themeName}.zsh-theme" ]; then ` +
        `source "${home}/.oh-my-zsh/custom/themes/${themeName}.zsh-theme"; ` +
        `elif [ -f "${home}/.oh-my-zsh/themes/${themeName}.zsh-theme" ]; then ` +
        `source "${home}/.oh-my-zsh/themes/${themeName}.zsh-theme"; fi\n`;
    }

    const data = Array.from(new TextEncoder().encode(cmd));
    try {
      await invoke("write_terminal_session", { sessionId: activeSessionId, data });
    } catch {}
  }

  async function changeZshTheme(newTheme: string, isFromCustomDir = false) {
    const home = await getHomeDir();
    try {
      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", "/^source.*\\.zsh-theme/d", `${home}/.zshrc`],
        cwd: null,
      });

      if (isFromCustomDir) {
        const themePath = `${home}/.oh-my-zsh/custom/themes/${newTheme}.zsh-theme`;
        await invoke<ShellCommandOutput>("execute_shell_command", {
          command: "sed",
          args: ["-i", "", `s/^ZSH_THEME=".*"/ZSH_THEME=""/`, `${home}/.zshrc`],
          cwd: null,
        });
        await invoke<ShellCommandOutput>("execute_shell_command", {
          command: "sed",
          args: ["-i", "", `/^ZSH_THEME=/a\\
source "${themePath}"`, `${home}/.zshrc`],
          cwd: null,
        });
        setZshTheme(newTheme);
        setIsCustomTheme(true);
        setCustomThemePath(themePath);
        setCustomThemeError("");
        await reloadShellTheme("", themePath);
      } else {
        await invoke<ShellCommandOutput>("execute_shell_command", {
          command: "sed",
          args: ["-i", "", `s/^ZSH_THEME=".*"/ZSH_THEME="${newTheme}"/`, `${home}/.zshrc`],
          cwd: null,
        });
        setZshTheme(newTheme);
        setIsCustomTheme(false);
        setCustomThemePath("");
        setCustomThemeError("");
        await reloadShellTheme(newTheme);
      }
    } catch {}
  }

  async function expandPath(p: string): Promise<string> {
    const home = await getHomeDir();
    if (p.startsWith("~/")) return home + p.slice(1);
    if (p.startsWith("$HOME/")) return home + p.slice(5);
    return p;
  }

  async function applyCustomThemePath() {
    setCustomThemeError("");
    const rawPath = customThemePath.trim();
    if (!rawPath) {
      setCustomThemeError("Please enter a file path");
      return;
    }
    if (!rawPath.endsWith(".zsh-theme")) {
      setCustomThemeError("File must end with .zsh-theme");
      return;
    }

    const resolvedPath = await expandPath(rawPath);

    const checkResult = await invoke<ShellCommandOutput>("execute_shell_command", {
      command: "sh",
      args: ["-c", `test -f "${resolvedPath}" && echo "ok"`],
      cwd: null,
    }).catch(() => null);

    if (!checkResult || checkResult.status !== 0) {
      setCustomThemeError(`File not found at: ${resolvedPath}`);
      return;
    }

    const home = await getHomeDir();
    try {
      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", `s/^ZSH_THEME=".*"/ZSH_THEME=""/`, `${home}/.zshrc`],
        cwd: null,
      });

      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", "/^source.*\\.zsh-theme/d", `${home}/.zshrc`],
        cwd: null,
      });

      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", `/^ZSH_THEME=/a\\
source "${resolvedPath}"`, `${home}/.zshrc`],
        cwd: null,
      });

      setIsCustomTheme(true);
      setZshTheme("custom");
      await reloadShellTheme("", resolvedPath);
    } catch {
      setCustomThemeError("Failed to update .zshrc");
    }
  }

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "General", icon: <Eye size={14} /> },
    { id: "terminal", label: "Terminal", icon: <TerminalIcon size={14} /> },
    { id: "theme", label: "Theme", icon: <Palette size={14} /> },
    { id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={14} /> },
    { id: "specs", label: "Specs", icon: <Package size={14} /> },
  ];

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
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
            <Dialog.Panel className="settings-modal w-full max-w-2xl rounded-xl overflow-hidden flex flex-col max-h-[80vh]">
              {/* Header */}
              <div className="settings-header flex items-center justify-between px-6 py-4 shrink-0">
                <Dialog.Title className="text-sm font-semibold text-ft-text">Settings</Dialog.Title>
                <button
                  onClick={onClose}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-surface transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Tabs + Content */}
              <div className="flex flex-1 min-h-0">
                {/* Sidebar tabs */}
                <div className="settings-sidebar w-44 py-3 px-2 shrink-0">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all mb-0.5 ${
                        activeTab === tab.id
                          ? "active"
                          : "text-ft-text-secondary hover:text-ft-text"
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Content area */}
                <div className="flex-1 overflow-y-auto p-6">
                  {activeTab === "general" && (
                    <GeneralTab
                      settings={settings}
                      theme={theme}
                      setTheme={setTheme}
                      zshTheme={zshTheme}
                    />
                  )}
                  {activeTab === "terminal" && (
                    <TerminalTab settings={settings} updateSettings={updateSettings} />
                  )}
                  {activeTab === "theme" && (
                    <ThemeTab
                      zshTheme={zshTheme}
                      availableThemes={availableThemes}
                      customThemes={customThemes}
                      loadingThemes={loadingThemes}
                      customThemePath={customThemePath}
                      customThemeError={customThemeError}
                      isCustomTheme={isCustomTheme}
                      setCustomThemePath={setCustomThemePath}
                      setCustomThemeError={setCustomThemeError}
                      applyCustomThemePath={applyCustomThemePath}
                      changeZshTheme={changeZshTheme}
                    />
                  )}
                  {activeTab === "shortcuts" && <ShortcutsTab />}
                  {activeTab === "specs" && <SpecsTab />}
                </div>
              </div>

              {/* Footer */}
              <div className="settings-footer flex items-center justify-between px-6 py-3 shrink-0">
                <button
                  onClick={resetSettings}
                  className="text-xs text-ft-text-muted hover:text-ft-text transition-colors"
                >
                  Reset Defaults
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-ft-accent rounded-lg hover:bg-ft-accent-hover transition-colors"
                >
                  Done
                </button>
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}

/* ---------- General Tab ---------- */

function GeneralTab({
  settings,
  theme,
  setTheme,
  zshTheme,
}: {
  settings: SettingsType;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  zshTheme: string;
}) {
  return (
    <div className="space-y-6">
      {/* Preview */}
      <div>
        <SectionHeader icon={<Eye size={13} />} title="Preview" />
        <TerminalPreview
          fontFamily={settings.fontFamily}
          fontSize={settings.fontSize}
          lineHeight={settings.lineHeight}
          cursorStyle={settings.cursorStyle}
          cursorBlink={settings.cursorBlink}
          theme={theme}
          zshTheme={zshTheme}
        />
      </div>

      {/* Appearance */}
      <div>
        <SectionHeader icon={<Sun size={13} />} title="Appearance" />
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setTheme("dark")}
            className={`settings-card flex items-center gap-2.5 px-4 py-3 text-xs font-medium transition-all ${
              theme === "dark" ? "active" : "text-ft-text-secondary hover:text-ft-text"
            }`}
          >
            <Moon size={15} />
            Dark Mode
          </button>
          <button
            onClick={() => setTheme("light")}
            className={`settings-card flex items-center gap-2.5 px-4 py-3 text-xs font-medium transition-all ${
              theme === "light" ? "active" : "text-ft-text-secondary hover:text-ft-text"
            }`}
          >
            <Sun size={15} />
            Light Mode
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Terminal Tab ---------- */

function TerminalTab({
  settings,
  updateSettings,
}: {
  settings: SettingsType;
  updateSettings: (partial: Partial<SettingsType>) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Font */}
      <div>
        <SectionHeader icon={<TerminalIcon size={13} />} title="Font" />
        <div className="space-y-3">
          <div>
            <FieldLabel>Font Family</FieldLabel>
            <input
              type="text"
              value={settings.fontFamily}
              onChange={(e) => updateSettings({ fontFamily: e.target.value })}
              placeholder="e.g. JetBrains Mono, Menlo, monospace"
              className="settings-input w-full rounded-lg px-3 py-2 text-xs font-mono"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <FieldLabel>Font Size</FieldLabel>
              <input
                type="number"
                value={settings.fontSize}
                onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                min={10}
                max={24}
                className="settings-input w-full rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div>
              <FieldLabel>Line Height</FieldLabel>
              <input
                type="number"
                value={settings.lineHeight}
                onChange={(e) => updateSettings({ lineHeight: Number(e.target.value) })}
                min={1}
                max={2.5}
                step={0.1}
                className="settings-input w-full rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div>
              <FieldLabel>Letter Spacing</FieldLabel>
              <input
                type="number"
                value={settings.letterSpacing ?? 0}
                onChange={(e) => updateSettings({ letterSpacing: Number(e.target.value) })}
                min={-3}
                max={5}
                step={0.5}
                className="settings-input w-full rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div>
              <FieldLabel>Scrollback</FieldLabel>
              <input
                type="number"
                value={settings.scrollback}
                onChange={(e) => updateSettings({ scrollback: Number(e.target.value) })}
                min={500}
                max={50000}
                step={500}
                className="settings-input w-full rounded-lg px-3 py-2 text-xs"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Cursor */}
      <div>
        <SectionHeader icon={<Command size={13} />} title="Cursor" />
        <div className="space-y-3">
          <div>
            <FieldLabel>Cursor Style</FieldLabel>
            <div className="grid grid-cols-3 gap-2">
              {(["block", "underline", "bar"] as const).map((style) => (
                <button
                  key={style}
                  onClick={() => updateSettings({ cursorStyle: style })}
                  className={`settings-card px-3 py-2 text-xs font-medium transition-all ${
                    settings.cursorStyle === style ? "active" : "text-ft-text-secondary hover:text-ft-text"
                  }`}
                >
                  {style.charAt(0).toUpperCase() + style.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-card flex items-center justify-between py-2.5 px-4">
            <label className="text-xs font-medium text-ft-text">Cursor Blink</label>
            <button
              onClick={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
              className={`toggle-switch relative w-9 h-5 rounded-full transition-colors duration-200 ${
                settings.cursorBlink ? "active" : ""
              }`}
            >
              <div
                className={`absolute top-[3px] left-[3px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  settings.cursorBlink ? "translate-x-[16px]" : ""
                }`}
              />
            </button>
          </div>

          <div className="settings-card flex items-center justify-between py-2.5 px-4">
            <div>
              <label className="text-xs font-medium text-ft-text">System Stats in Status Bar</label>
              <p className="text-[10px] text-ft-text-muted mt-0.5">Show live CPU & memory usage</p>
            </div>
            <button
              onClick={() => updateSettings({ showSystemStats: !settings.showSystemStats })}
              className={`toggle-switch relative w-9 h-5 rounded-full transition-colors duration-200 ${
                settings.showSystemStats ? "active" : ""
              }`}
            >
              <div
                className={`absolute top-[3px] left-[3px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  settings.showSystemStats ? "translate-x-[16px]" : ""
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Theme Tab ---------- */

function ThemeTab({
  zshTheme,
  availableThemes,
  customThemes,
  loadingThemes,
  customThemePath,
  customThemeError,
  isCustomTheme,
  setCustomThemePath,
  setCustomThemeError,
  applyCustomThemePath,
  changeZshTheme,
}: {
  zshTheme: string;
  availableThemes: string[];
  customThemes: string[];
  loadingThemes: boolean;
  customThemePath: string;
  customThemeError: string;
  isCustomTheme: boolean;
  setCustomThemePath: (v: string) => void;
  setCustomThemeError: (v: string) => void;
  applyCustomThemePath: () => void;
  changeZshTheme: (theme: string, isCustom?: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <SectionHeader icon={<Palette size={13} />} title="Oh My Zsh Theme" />

      {loadingThemes ? (
        <div className="text-xs text-ft-text-muted py-4 text-center">Loading themes...</div>
      ) : availableThemes.length === 0 ? (
        <div className="settings-card text-xs text-ft-text-muted py-4 px-4 text-center">
          oh-my-zsh not detected at ~/.oh-my-zsh
        </div>
      ) : (
        <>
          {/* Active theme badge */}
          <div className="active-badge flex items-center gap-2 px-4 py-2.5 rounded-lg">
            <Check size={13} className="text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Active:</span>
            <span className="text-xs font-mono text-ft-text">
              {isCustomTheme ? `custom (${customThemePath.split("/").pop()})` : (zshTheme || "unknown")}
            </span>
          </div>

          {/* Custom theme path */}
          <div className="settings-card p-4">
            <FieldLabel>Custom Theme File</FieldLabel>
            <div className="flex gap-2 mt-1.5">
              <input
                type="text"
                value={customThemePath}
                onChange={(e) => { setCustomThemePath(e.target.value); setCustomThemeError(""); }}
                placeholder="~/.oh-my-zsh/custom/themes/my-theme.zsh-theme"
                className="settings-input flex-1 rounded-lg px-3 py-2 text-xs font-mono"
              />
              <button
                onClick={applyCustomThemePath}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                  isCustomTheme
                    ? "bg-ft-accent/12 text-ft-accent border border-ft-accent/30"
                    : "bg-ft-accent text-white hover:bg-ft-accent-hover"
                }`}
              >
                {isCustomTheme ? "Active" : "Apply"}
              </button>
            </div>
            {customThemeError && (
              <p className="mt-1.5 text-[10px] text-ft-error">{customThemeError}</p>
            )}
            <p className="mt-1.5 text-[10px] text-ft-text-muted">
              Path to a .zsh-theme file (powerlevel10k, spaceship, etc.)
            </p>
          </div>

          {/* Custom themes */}
          {customThemes.length > 0 && (
            <div>
              <FieldLabel>Custom Themes</FieldLabel>
              <div className="spec-list mt-1.5 overflow-hidden rounded-lg max-h-[120px] overflow-y-auto">
                {customThemes.map((t) => (
                  <button
                    key={`custom-${t}`}
                    onClick={() => changeZshTheme(t, true)}
                    className={`spec-item w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono transition-colors theme-list-item ${
                      t === zshTheme ? "active" : ""
                    }`}
                  >
                    {t === zshTheme && <Check size={10} className="text-ft-accent shrink-0" />}
                    <span className={t === zshTheme ? "font-medium text-ft-text" : "text-ft-text-secondary"}>{t}</span>
                    <span className="ml-auto text-[9px] text-ft-text-muted/70 px-1.5 py-0.5 rounded custom-badge">custom</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Built-in theme list */}
          <div>
            <FieldLabel>Built-in Themes ({availableThemes.length})</FieldLabel>
            <div className="spec-list mt-1.5 rounded-lg max-h-[200px] overflow-y-auto">
              {availableThemes.map((t) => (
                <button
                  key={t}
                  onClick={() => changeZshTheme(t)}
                  className={`spec-item w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono transition-colors theme-list-item ${
                    t === zshTheme && !isCustomTheme ? "active" : ""
                  }`}
                >
                  {t === zshTheme && !isCustomTheme && <Check size={10} className="text-ft-accent shrink-0" />}
                  <span className={t === zshTheme && !isCustomTheme ? "font-medium text-ft-text" : "text-ft-text-secondary"}>{t}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-ft-text-muted">
              Changes apply in real-time to the active terminal session.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Shortcuts Tab ---------- */

interface ShortcutGroup {
  title: string;
  icon: React.ReactNode;
  shortcuts: { keys: string[]; description: string }[];
}

function ShortcutsTab() {
  const groups: ShortcutGroup[] = [
    {
      title: "Tabs",
      icon: <TerminalIcon size={13} />,
      shortcuts: [
        { keys: ["⌘", "T"], description: "New tab" },
        { keys: ["⌘", "W"], description: "Close active pane" },
        { keys: ["⌘", "1-9"], description: "Switch to tab N" },
        { keys: ["⌘", "⇧", "["], description: "Previous tab" },
        { keys: ["⌘", "⇧", "]"], description: "Next tab" },
      ],
    },
    {
      title: "Panes",
      icon: <SplitSquareHorizontal size={13} />,
      shortcuts: [
        { keys: ["⌘", "D"], description: "Split pane horizontally" },
        { keys: ["⌘", "⇧", "D"], description: "Split pane vertically" },
        { keys: ["⌘", "W"], description: "Close active pane" },
      ],
    },
    {
      title: "Terminal",
      icon: <Command size={13} />,
      shortcuts: [
        { keys: ["⌘", "F"], description: "Find in terminal" },
        { keys: ["⌘", "R"], description: "Search command history" },
        { keys: ["⌘", "⇧", "M"], description: "System Monitor" },
        { keys: ["⌘", "K"], description: "Clear terminal" },
        { keys: ["⌘", "C"], description: "Copy selection" },
        { keys: ["⌘", "V"], description: "Paste from clipboard" },
        { keys: ["Ctrl", "C"], description: "Interrupt / cancel process" },
        { keys: ["Ctrl", "D"], description: "End of input (EOF)" },
        { keys: ["Ctrl", "Z"], description: "Suspend process" },
        { keys: ["Ctrl", "L"], description: "Clear screen (shell built-in)" },
      ],
    },
    {
      title: "Application",
      icon: <Keyboard size={13} />,
      shortcuts: [
        { keys: ["⌘", ","], description: "Open settings" },
        { keys: ["⌘", "Q"], description: "Quit application" },
        { keys: ["⌘", "M"], description: "Minimize window" },
        { keys: ["⌘", "⇧", "F"], description: "Toggle fullscreen" },
      ],
    },
    {
      title: "Autocomplete",
      icon: <Eye size={13} />,
      shortcuts: [
        { keys: ["↑", "↓"], description: "Navigate suggestions" },
        { keys: ["Tab"], description: "Accept suggestion" },
        { keys: ["Esc"], description: "Dismiss suggestions" },
        { keys: ["Enter"], description: "Execute command / accept" },
      ],
    },
  ];

  return (
    <div className="space-y-5">
      <SectionHeader icon={<Keyboard size={13} />} title="Keyboard Shortcuts" />
      <p className="text-xs text-ft-text-muted -mt-2">
        Quick reference for all available keyboard shortcuts.
      </p>

      {groups.map((group) => (
        <div key={group.title}>
          <div className="flex items-center gap-2 mb-2">
            <span className="section-icon opacity-70">{group.icon}</span>
            <span className="text-[11px] font-semibold section-title uppercase tracking-wider">{group.title}</span>
          </div>
          <div className="shortcut-group overflow-hidden rounded-lg">
            {group.shortcuts.map((shortcut, i) => (
              <div
                key={i}
                className={`shortcut-row flex items-center justify-between px-4 py-2.5 ${
                  i < group.shortcuts.length - 1 ? "shortcut-divider" : ""
                }`}
              >
                <span className="text-xs shortcut-desc">{shortcut.description}</span>
                <div className="flex items-center gap-1">
                  {shortcut.keys.map((key, j) => (
                    <kbd
                      key={j}
                      className="shortcut-kbd inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[10px] font-medium rounded-md"
                    >
                      {key}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Shared Components ---------- */

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="section-icon">{icon}</span>
      <h3 className="text-xs font-semibold section-title uppercase tracking-wider">{title}</h3>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-medium field-label mb-1.5">{children}</label>
  );
}

/* ---------- Terminal Preview Component ---------- */

interface TerminalPreviewProps {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  theme: "dark" | "light";
  zshTheme: string;
}

/* ---------- Specs Tab ---------- */

function SpecsTab() {
  const [installed, setInstalled] = useState<InstalledSpec[]>([]);
  const [available, setAvailable] = useState<RemoteSpecEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");

  const builtinSpecs = ["git", "docker", "docker-compose", "npm", "pnpm", "yarn", "uv", "brew"];

  useEffect(() => {
    loadInstalled();
    loadAvailable();
  }, []);

  async function loadInstalled() {
    try {
      const specs = await listInstalledSpecs();
      // Only show root specs, not sub-specs (e.g., hide "aws/s3")
      setInstalled(specs.filter((s) => !s.name.includes("/")));
    } catch {}
  }

  async function loadAvailable() {
    setLoading(true);
    setError("");
    try {
      const registry = await fetchRegistry();
      setAvailable(registry.specs);
    } catch (err) {
      setError("Failed to fetch spec registry. Check your internet connection.");
    }
    setLoading(false);
  }

  async function handleInstall(name: string) {
    setInstalling(name);
    try {
      await installSpec(name);
      await specRegistry.loadUserSpecs();
      await loadInstalled();
    } catch (err) {
      setError(`Failed to install ${name}`);
    }
    setInstalling(null);
  }

  async function handleRemove(name: string) {
    setRemoving(name);
    try {
      await removeSpec(name);
      specRegistry.unregisterSpec(name);
      await loadInstalled();
    } catch (err) {
      setError(`Failed to remove ${name}`);
    }
    setRemoving(null);
  }

  const installedNames = new Set([...builtinSpecs, ...installed.map((s) => s.name)]);

  const filteredAvailable = available.filter(
    (s) => !installedNames.has(s.name) &&
      (searchQuery === "" ||
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.category.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const categories = [...new Set(filteredAvailable.map((s) => s.category))].sort();

  return (
    <div className="space-y-5">
      <SectionHeader icon={<Package size={13} />} title="Command Specs" />
      <p className="text-xs text-ft-text-muted -mt-2">
        Manage autocomplete specs. Built-in specs are always available.
      </p>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/8 border border-red-500/15 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Built-in specs */}
      <div>
        <FieldLabel>Built-in ({builtinSpecs.length})</FieldLabel>
        <div className="spec-list mt-1.5 overflow-hidden rounded-lg">
          <div className="grid grid-cols-2">
            {builtinSpecs.map((name) => (
              <div key={name} className="spec-item flex items-center gap-2 px-3 py-2.5">
                <img
                  src={`/icons/${name}.png`}
                  alt=""
                  className="w-4 h-4 object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <span className="text-xs font-mono text-ft-text">{name}</span>
                <span className="ml-auto text-[8px] text-emerald-400 font-semibold uppercase tracking-wide">built-in</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* User-installed specs */}
      {installed.length > 0 && (
        <div>
          <FieldLabel>Installed ({installed.length})</FieldLabel>
          <div className="spec-list mt-1.5 overflow-hidden rounded-lg">
            {installed.map((spec, i) => (
              <div key={spec.name} className={`spec-item flex items-center gap-2 px-3 py-2.5 ${i < installed.length - 1 ? "spec-divider" : ""}`}>
                <span className="text-xs font-mono text-ft-text">{spec.name}</span>
                <span className="text-[9px] text-ft-text-muted ml-1">
                  {(spec.fileSize / 1024).toFixed(1)}KB
                </span>
                <button
                  onClick={() => handleRemove(spec.name)}
                  disabled={removing === spec.name}
                  className="spec-remove-btn ml-auto flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded transition-colors"
                >
                  {removing === spec.name ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Available from remote */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <FieldLabel>Available from Repository</FieldLabel>
          <button
            onClick={loadAvailable}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-ft-accent hover:bg-ft-accent/10 rounded transition-colors"
          >
            {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            {available.length === 0 ? "Load Specs" : "Refresh"}
          </button>
        </div>

        {available.length > 0 && (
          <>
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ft-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search specs..."
                className="settings-input w-full rounded-lg pl-7 pr-3 py-1.5 text-xs"
              />
            </div>

            <div className="spec-list max-h-[240px] overflow-y-auto rounded-lg">
              {categories.map((cat) => {
                const catSpecs = filteredAvailable.filter((s) => s.category === cat);
                if (catSpecs.length === 0) return null;
                return (
                  <div key={cat}>
                    <div className="spec-category-header px-3 py-1.5">
                      <span className="text-[9px] font-bold uppercase tracking-wider">{cat}</span>
                    </div>
                    {catSpecs.map((spec) => (
                      <div key={spec.name} className="spec-item flex items-center gap-2 px-3 py-2 spec-divider last:border-0">
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-mono text-ft-text block">{spec.name}</span>
                          <span className="text-[9px] text-ft-text-muted block truncate">{spec.description}</span>
                        </div>
                        <button
                          onClick={() => handleInstall(spec.name)}
                          disabled={installing === spec.name}
                          className="spec-install-btn flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors shrink-0"
                        >
                          {installing === spec.name ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                          Install
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {filteredAvailable.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-ft-text-muted">
                  {searchQuery ? "No matching specs found" : "All available specs are already installed"}
                </div>
              )}
            </div>
          </>
        )}

        {available.length === 0 && !loading && (
          <div className="settings-card text-xs text-ft-text-muted px-4 py-3 text-center">
            Click "Load Specs" to browse available autocomplete specs from the community repository.
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalPreview({
  fontFamily,
  fontSize,
  lineHeight,
  cursorStyle,
  cursorBlink,
  theme,
  zshTheme,
}: TerminalPreviewProps) {
  const previewScale = useMemo(() => {
    return Math.min(fontSize / 14, 1.2);
  }, [fontSize]);

  const darkColors = {
    bg: "#0d0f14",
    text: "#e4e7ef",
    textMuted: "#5c6175",
    green: "#34d399",
    blue: "#60a5fa",
    cyan: "#67e8f9",
    yellow: "#fbbf24",
    red: "#f87171",
    magenta: "#c084fc",
  };

  const lightColors = {
    bg: "#f8f9fb",
    text: "#1a1d27",
    textMuted: "#7a8094",
    green: "#059669",
    blue: "#2563eb",
    cyan: "#0891b2",
    yellow: "#d97706",
    red: "#dc2626",
    magenta: "#9333ea",
  };

  const c = theme === "dark" ? darkColors : lightColors;

  const cursorEl = (() => {
    const blinkClass = cursorBlink ? "animate-pulse" : "";
    if (cursorStyle === "block")
      return <span className={`inline-block ${blinkClass}`} style={{ background: c.text, color: c.bg, width: "0.6em", textAlign: "center" }}>&nbsp;</span>;
    if (cursorStyle === "underline")
      return <span className={`inline-block ${blinkClass}`} style={{ borderBottom: `2px solid ${c.text}`, width: "0.6em" }}>&nbsp;</span>;
    return <span className={`inline-block ${blinkClass}`} style={{ borderLeft: `2px solid ${c.text}`, height: "1.1em" }}>&nbsp;</span>;
  })();

  return (
    <div
      className="rounded-lg overflow-hidden border border-ft-border-subtle"
      style={{ background: c.bg }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: theme === "dark" ? "#1e2230" : "#e4e7ec" }}
      >
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#f87171" }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#fbbf24" }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#34d399" }} />
        </div>
        <div className="flex-1 text-center">
          <span style={{ color: c.textMuted, fontSize: "9px", fontFamily }}>
            FigyTerm — zsh {zshTheme ? `(${zshTheme})` : ""}
          </span>
        </div>
      </div>

      <div
        className="px-3 py-2.5 overflow-hidden"
        style={{
          fontFamily,
          fontSize: `${Math.min(fontSize, 13) * previewScale}px`,
          lineHeight,
          color: c.text,
          minHeight: "72px",
        }}
      >
        <div className="whitespace-pre">
          <span style={{ color: c.green }}>user@mac</span>
          <span style={{ color: c.textMuted }}> in </span>
          <span style={{ color: c.blue }}>~/projects</span>
          <span style={{ color: c.yellow }}> (main)</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: c.magenta }}>❯ </span>
          <span style={{ color: c.text }}>git status</span>
        </div>
        <div className="whitespace-pre mt-0.5">
          <span style={{ color: c.textMuted }}>On branch </span>
          <span style={{ color: c.green }}>main</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: c.red }}>  modified:  </span>
          <span style={{ color: c.text }}>src/app.tsx</span>
        </div>
        <div className="whitespace-pre mt-1">
          <span style={{ color: c.magenta }}>❯ </span>
          {cursorEl}
        </div>
      </div>

      <div
        className="flex items-center justify-between px-3 py-1.5 border-t text-[9px]"
        style={{ borderColor: theme === "dark" ? "#1e2230" : "#e4e7ec", color: c.textMuted }}
      >
        <span>{fontFamily.split(",")[0].replace(/'/g, "").trim()} • {fontSize}px • {lineHeight}lh</span>
        <span>{theme === "dark" ? "Dark" : "Light"} • {cursorStyle}</span>
      </div>
    </div>
  );
}
