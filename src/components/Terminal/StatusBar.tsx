import { Terminal, Folder, Sun, Moon, Circle, Settings } from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";

interface StatusBarProps {
  cwd: string;
  shell: string;
  onOpenSettings?: () => void;
}

export function StatusBar({ cwd, shell, onOpenSettings }: StatusBarProps) {
  const shellName = shell.split("/").pop() ?? shell;
  const { theme, toggleTheme } = useThemeStore();

  const displayCwd = cwd || "~";

  return (
    <div className="flex items-center h-7 px-3 bg-ft-surface border-t border-ft-border-subtle text-[10px] text-ft-text-muted select-none gap-3">
      <div className="flex items-center gap-1.5">
        <Terminal size={10} className="opacity-50" />
        <span className="font-mono">{shellName}</span>
      </div>

      {displayCwd && (
        <div className="flex items-center gap-1.5">
          <Folder size={10} className="opacity-50" />
          <span className="font-mono truncate max-w-[500px]" title={displayCwd}>
            {displayCwd}
          </span>
        </div>
      )}

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Circle size={6} className="fill-ft-success text-ft-success opacity-80" />
          <span>Ready</span>
        </div>

        <div className="w-px h-3 bg-ft-border-subtle" />

        <button
          onClick={toggleTheme}
          className="flex items-center gap-1.5 h-5 px-1.5 rounded hover:bg-ft-elevated transition-colors"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? (
            <Moon size={10} className="text-ft-text-muted" />
          ) : (
            <Sun size={10} className="text-ft-text-muted" />
          )}
          <span className="capitalize">{theme}</span>
        </button>

        <div className="w-px h-3 bg-ft-border-subtle" />

        <button
          onClick={onOpenSettings}
          className="flex items-center justify-center w-5 h-5 rounded hover:bg-ft-elevated transition-colors"
          title="Settings (⌘,)"
        >
          <Settings size={11} className="text-ft-text-muted hover:text-ft-text" />
        </button>
      </div>
    </div>
  );
}
