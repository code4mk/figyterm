import { Fragment, useEffect, useState, useMemo } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X, Moon, Sun, Palette, Check, Eye } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";

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

export function Settings({ isOpen, onClose, activeSessionId }: SettingsProps) {
  const { settings, updateSettings, resetSettings } = useSettingsStore();
  const { theme, setTheme } = useThemeStore();

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

      // Detect if a custom theme file is sourced
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

      // Load custom themes from ~/.oh-my-zsh/custom/themes/
      if (customListResult.status === 0 && customListResult.stdout.trim()) {
        const cThemes = customListResult.stdout
          .trim()
          .split("\n")
          .filter((f) => f.endsWith(".zsh-theme"))
          .map((f) => f.replace(".zsh-theme", ""))
          .sort();
        setCustomThemes(cThemes);
      }
    } catch {
      // oh-my-zsh may not be installed
    }
    setLoadingThemes(false);
  }

  async function reloadShellTheme(themeName: string, isCustomPath?: string) {
    if (!activeSessionId) return;
    const home = await getHomeDir();

    let cmd: string;
    if (isCustomPath) {
      // Directly source the custom file path
      cmd = `export ZSH_THEME="" && source "${isCustomPath}"\n`;
    } else {
      // Try custom/themes first, then built-in themes
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
      // Remove any existing custom source line
      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", "/^source.*\\.zsh-theme/d", `${home}/.zshrc`],
        cwd: null,
      });

      if (isFromCustomDir) {
        // For custom dir themes, set ZSH_THEME="" and source file directly
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
        // Built-in themes just use ZSH_THEME
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

    // Verify file exists using sh -c so path is properly resolved
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
      // Set ZSH_THEME to empty (disable built-in)
      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", `s/^ZSH_THEME=".*"/ZSH_THEME=""/`, `${home}/.zshrc`],
        cwd: null,
      });

      // Remove any existing custom source line
      await invoke<ShellCommandOutput>("execute_shell_command", {
        command: "sed",
        args: ["-i", "", "/^source.*\\.zsh-theme/d", `${home}/.zshrc`],
        cwd: null,
      });

      // Add source line for custom theme after ZSH_THEME line
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
            <Dialog.Panel className="w-full max-w-md bg-ft-elevated border border-ft-border rounded-xl shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-ft-border-subtle">
                <Dialog.Title className="text-sm font-semibold text-ft-text">Settings</Dialog.Title>
                <button
                  onClick={onClose}
                  className="flex items-center justify-center w-6 h-6 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-bg transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="p-5 space-y-6 max-h-[60vh] overflow-y-auto">
                {/* Live Terminal Preview */}
                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-ft-text mb-2 uppercase tracking-wider">
                    <Eye size={12} />
                    Preview
                  </label>
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

                {/* Appearance Section */}
                <div>
                  <label className="block text-xs font-semibold text-ft-text mb-2 uppercase tracking-wider">Appearance</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setTheme("dark")}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                        theme === "dark"
                          ? "bg-ft-accent/15 text-ft-accent border border-ft-accent/30"
                          : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text"
                      }`}
                    >
                      <Moon size={14} />
                      Dark
                    </button>
                    <button
                      onClick={() => setTheme("light")}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                        theme === "light"
                          ? "bg-ft-accent/15 text-ft-accent border border-ft-accent/30"
                          : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text"
                      }`}
                    >
                      <Sun size={14} />
                      Light
                    </button>
                  </div>
                </div>

                {/* Oh My Zsh Theme Section */}
                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-ft-text mb-2 uppercase tracking-wider">
                    <Palette size={12} />
                    Oh My Zsh Theme
                  </label>

                  {loadingThemes ? (
                    <div className="text-xs text-ft-text-muted py-2">Loading themes...</div>
                  ) : availableThemes.length === 0 ? (
                    <div className="text-xs text-ft-text-muted py-2 bg-ft-bg rounded-lg px-3">
                      oh-my-zsh not detected at ~/.oh-my-zsh
                    </div>
                  ) : (
                    <>
                      {/* Active theme badge */}
                      <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-ft-accent/10 border border-ft-accent/20">
                        <Check size={12} className="text-ft-accent" />
                        <span className="text-xs font-medium text-ft-accent">Active:</span>
                        <span className="text-xs font-mono text-ft-text">
                          {isCustomTheme ? `custom (${customThemePath.split("/").pop()})` : (zshTheme || "unknown")}
                        </span>
                      </div>

                      {/* Custom theme path */}
                      <div className="mb-3 p-3 rounded-lg border border-ft-border-subtle bg-ft-bg">
                        <div className="text-[10px] font-medium text-ft-text-secondary mb-1.5">Custom Theme File</div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={customThemePath}
                            onChange={(e) => { setCustomThemePath(e.target.value); setCustomThemeError(""); }}
                            placeholder="~/.oh-my-zsh/custom/themes/my-theme.zsh-theme"
                            className="flex-1 bg-ft-elevated border border-ft-border-subtle rounded-lg px-2.5 py-1.5 text-[10px] text-ft-text font-mono outline-none focus:border-ft-accent/50 transition-colors placeholder:text-ft-text-muted"
                          />
                          <button
                            onClick={applyCustomThemePath}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                              isCustomTheme
                                ? "bg-ft-accent/15 text-ft-accent border border-ft-accent/30"
                                : "bg-ft-accent text-white hover:bg-ft-accent-hover"
                            }`}
                          >
                            {isCustomTheme ? "Active" : "Apply"}
                          </button>
                        </div>
                        {customThemeError && (
                          <p className="mt-1 text-[9px] text-ft-error">{customThemeError}</p>
                        )}
                        <p className="mt-1 text-[9px] text-ft-text-muted">
                          Path to a .zsh-theme file (e.g. from powerlevel10k, spaceship, etc.)
                        </p>
                      </div>

                      {/* Custom themes from ~/.oh-my-zsh/custom/themes/ */}
                      {customThemes.length > 0 && (
                        <>
                          <div className="text-[10px] font-medium text-ft-text-secondary mb-1">Custom Themes</div>
                          <div className="mb-3 rounded-lg border border-ft-border-subtle bg-ft-bg overflow-hidden">
                            {customThemes.map((t) => (
                              <button
                                key={`custom-${t}`}
                                onClick={() => changeZshTheme(t, true)}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-colors hover:bg-ft-elevated ${
                                  t === zshTheme
                                    ? "text-ft-accent bg-ft-accent/5"
                                    : "text-ft-text-secondary"
                                }`}
                              >
                                {t === zshTheme && <Check size={10} className="text-ft-accent shrink-0" />}
                                <span className={t === zshTheme ? "font-medium" : ""}>{t}</span>
                                <span className="ml-auto text-[8px] text-ft-text-muted">custom</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}

                      {/* Built-in theme list */}
                      <div className="text-[10px] font-medium text-ft-text-secondary mb-1">Built-in Themes</div>
                      <div className="max-h-[140px] overflow-y-auto rounded-lg border border-ft-border-subtle bg-ft-bg">
                        {availableThemes.map((t) => (
                          <button
                            key={t}
                            onClick={() => changeZshTheme(t)}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-colors hover:bg-ft-elevated ${
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
                      <p className="mt-1.5 text-[9px] text-ft-text-muted">
                        Changes apply to new terminal sessions after restart.
                      </p>
                    </>
                  )}
                </div>

                {/* Terminal Section */}
                <div>
                  <label className="block text-xs font-semibold text-ft-text mb-2 uppercase tracking-wider">Terminal</label>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[10px] font-medium text-ft-text-secondary mb-1">Font Family</label>
                      <input
                        type="text"
                        value={settings.fontFamily}
                        onChange={(e) => updateSettings({ fontFamily: e.target.value })}
                        className="w-full bg-ft-bg border border-ft-border-subtle rounded-lg px-3 py-2 text-xs text-ft-text outline-none focus:border-ft-accent/50 transition-colors font-mono"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-medium text-ft-text-secondary mb-1">Font Size</label>
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
                        <label className="block text-[10px] font-medium text-ft-text-secondary mb-1">Line Height</label>
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
                    </div>

                    <div>
                      <label className="block text-[10px] font-medium text-ft-text-secondary mb-1">Cursor Style</label>
                      <div className="grid grid-cols-3 gap-2">
                        {(["block", "underline", "bar"] as const).map((style) => (
                          <button
                            key={style}
                            onClick={() => updateSettings({ cursorStyle: style })}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                              settings.cursorStyle === style
                                ? "bg-ft-accent/15 text-ft-accent border border-ft-accent/30"
                                : "bg-ft-bg border border-ft-border-subtle text-ft-text-secondary hover:text-ft-text"
                            }`}
                          >
                            {style.charAt(0).toUpperCase() + style.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between py-1">
                      <label className="text-[10px] font-medium text-ft-text-secondary">Cursor Blink</label>
                      <button
                        onClick={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
                        className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${
                          settings.cursorBlink ? "bg-ft-accent" : "bg-ft-border"
                        }`}
                      >
                        <div
                          className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            settings.cursorBlink ? "translate-x-[14px]" : ""
                          }`}
                        />
                      </button>
                    </div>

                    <div>
                      <label className="block text-[10px] font-medium text-ft-text-secondary mb-1">Scrollback Buffer</label>
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

              <div className="flex items-center justify-between px-5 py-3 border-t border-ft-border-subtle bg-ft-surface/50">
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
    const scale = Math.min(fontSize / 14, 1.2);
    return scale;
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
      {/* Window chrome */}
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
            Figyterm — zsh {zshTheme ? `(${zshTheme})` : ""}
          </span>
        </div>
      </div>

      {/* Terminal body */}
      <div
        className="px-3 py-2.5 overflow-hidden"
        style={{
          fontFamily,
          fontSize: `${Math.min(fontSize, 13) * previewScale}px`,
          lineHeight,
          color: c.text,
          minHeight: "80px",
        }}
      >
        {/* Line 1 - prompt with command */}
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

        {/* Line 2 - output */}
        <div className="whitespace-pre mt-0.5">
          <span style={{ color: c.textMuted }}>On branch </span>
          <span style={{ color: c.green }}>main</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: c.textMuted }}>Changes not staged:</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: c.red }}>  modified:  </span>
          <span style={{ color: c.text }}>src/app.tsx</span>
        </div>

        {/* Line 3 - new prompt with cursor */}
        <div className="whitespace-pre mt-1">
          <span style={{ color: c.green }}>user@mac</span>
          <span style={{ color: c.textMuted }}> in </span>
          <span style={{ color: c.blue }}>~/projects</span>
          <span style={{ color: c.yellow }}> (main)</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: c.magenta }}>❯ </span>
          {cursorEl}
        </div>
      </div>

      {/* Footer info */}
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
