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
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { Settings as SettingsType } from "../../services/settings";

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

type SettingsTab = "general" | "terminal" | "theme" | "shortcuts";

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
            <Dialog.Panel className="w-full max-w-2xl bg-ft-elevated border border-ft-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-ft-border-subtle shrink-0">
                <Dialog.Title className="text-sm font-semibold text-ft-text">Settings</Dialog.Title>
                <button
                  onClick={onClose}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-bg transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Tabs + Content */}
              <div className="flex flex-1 min-h-0">
                {/* Sidebar tabs */}
                <div className="w-44 border-r border-ft-border-subtle bg-ft-surface/30 py-3 px-2 shrink-0">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all mb-0.5 ${
                        activeTab === tab.id
                          ? "bg-ft-accent/10 text-ft-accent"
                          : "text-ft-text-secondary hover:text-ft-text hover:bg-ft-bg/50"
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
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-6 py-3 border-t border-ft-border-subtle bg-ft-surface/30 shrink-0">
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
            className={`flex items-center gap-2.5 px-4 py-3 rounded-lg text-xs font-medium transition-all ${
              theme === "dark"
                ? "bg-ft-accent/12 text-ft-accent border border-ft-accent/30 shadow-sm shadow-ft-accent/5"
                : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text hover:border-ft-border"
            }`}
          >
            <Moon size={15} />
            Dark Mode
          </button>
          <button
            onClick={() => setTheme("light")}
            className={`flex items-center gap-2.5 px-4 py-3 rounded-lg text-xs font-medium transition-all ${
              theme === "light"
                ? "bg-ft-accent/12 text-ft-accent border border-ft-accent/30 shadow-sm shadow-ft-accent/5"
                : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text hover:border-ft-border"
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
              className="w-full bg-ft-bg border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text outline-none focus:border-ft-accent/50 transition-colors font-mono"
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
                className="w-full bg-ft-bg border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text outline-none focus:border-ft-accent/50 transition-colors"
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
                className="w-full bg-ft-bg border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text outline-none focus:border-ft-accent/50 transition-colors"
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
                className="w-full bg-ft-bg border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text outline-none focus:border-ft-accent/50 transition-colors"
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
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    settings.cursorStyle === style
                      ? "bg-ft-accent/12 text-ft-accent border border-ft-accent/30"
                      : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text hover:border-ft-border"
                  }`}
                >
                  {style.charAt(0).toUpperCase() + style.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-ft-bg border border-ft-border-subtle">
            <label className="text-xs font-medium text-ft-text-secondary">Cursor Blink</label>
            <button
              onClick={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
              className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
                settings.cursorBlink ? "bg-ft-accent" : "bg-ft-border"
              }`}
            >
              <div
                className={`absolute top-[3px] left-[3px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  settings.cursorBlink ? "translate-x-[16px]" : ""
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
        <div className="text-xs text-ft-text-muted py-4 px-4 bg-ft-bg rounded-lg border border-ft-border-subtle text-center">
          oh-my-zsh not detected at ~/.oh-my-zsh
        </div>
      ) : (
        <>
          {/* Active theme badge */}
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-ft-accent/8 border border-ft-accent/20">
            <Check size={13} className="text-ft-accent" />
            <span className="text-xs font-medium text-ft-accent">Active:</span>
            <span className="text-xs font-mono text-ft-text">
              {isCustomTheme ? `custom (${customThemePath.split("/").pop()})` : (zshTheme || "unknown")}
            </span>
          </div>

          {/* Custom theme path */}
          <div className="p-4 rounded-lg border border-ft-border-subtle bg-ft-bg">
            <FieldLabel>Custom Theme File</FieldLabel>
            <div className="flex gap-2 mt-1.5">
              <input
                type="text"
                value={customThemePath}
                onChange={(e) => { setCustomThemePath(e.target.value); setCustomThemeError(""); }}
                placeholder="~/.oh-my-zsh/custom/themes/my-theme.zsh-theme"
                className="flex-1 bg-ft-elevated border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text font-mono outline-none focus:border-ft-accent/50 transition-colors placeholder:text-ft-text-muted"
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
              <div className="mt-1.5 rounded-lg border border-ft-border-subtle bg-ft-bg overflow-hidden max-h-[120px] overflow-y-auto">
                {customThemes.map((t) => (
                  <button
                    key={`custom-${t}`}
                    onClick={() => changeZshTheme(t, true)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono transition-colors hover:bg-ft-elevated ${
                      t === zshTheme
                        ? "text-ft-accent bg-ft-accent/5"
                        : "text-ft-text-secondary"
                    }`}
                  >
                    {t === zshTheme && <Check size={10} className="text-ft-accent shrink-0" />}
                    <span className={t === zshTheme ? "font-medium" : ""}>{t}</span>
                    <span className="ml-auto text-[9px] text-ft-text-muted px-1.5 py-0.5 rounded bg-ft-elevated">custom</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Built-in theme list */}
          <div>
            <FieldLabel>Built-in Themes ({availableThemes.length})</FieldLabel>
            <div className="mt-1.5 max-h-[200px] overflow-y-auto rounded-lg border border-ft-border-subtle bg-ft-bg">
              {availableThemes.map((t) => (
                <button
                  key={t}
                  onClick={() => changeZshTheme(t)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono transition-colors hover:bg-ft-elevated ${
                    t === zshTheme && !isCustomTheme
                      ? "text-ft-accent bg-ft-accent/5"
                      : "text-ft-text-secondary"
                  }`}
                >
                  {t === zshTheme && !isCustomTheme && <Check size={10} className="text-ft-accent shrink-0" />}
                  <span className={t === zshTheme && !isCustomTheme ? "font-medium" : ""}>{t}</span>
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
      <p className="text-xs text-ft-text-muted -mt-3">
        Quick reference for all available keyboard shortcuts.
      </p>

      {groups.map((group) => (
        <div key={group.title}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-ft-text-muted">{group.icon}</span>
            <span className="text-[11px] font-semibold text-ft-text uppercase tracking-wider">{group.title}</span>
          </div>
          <div className="rounded-lg border border-ft-border-subtle bg-ft-bg overflow-hidden">
            {group.shortcuts.map((shortcut, i) => (
              <div
                key={i}
                className={`flex items-center justify-between px-4 py-2.5 ${
                  i < group.shortcuts.length - 1 ? "border-b border-ft-border-subtle/50" : ""
                }`}
              >
                <span className="text-xs text-ft-text-secondary">{shortcut.description}</span>
                <div className="flex items-center gap-1">
                  {shortcut.keys.map((key, j) => (
                    <kbd
                      key={j}
                      className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[10px] font-medium text-ft-text bg-ft-elevated border border-ft-border-subtle rounded-md shadow-sm"
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
      <span className="text-ft-accent">{icon}</span>
      <h3 className="text-xs font-semibold text-ft-text uppercase tracking-wider">{title}</h3>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] font-medium text-ft-text-secondary mb-1">{children}</label>
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
