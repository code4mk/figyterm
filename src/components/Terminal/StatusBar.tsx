import { useState, useEffect, useRef } from "react";
import { Terminal, Folder, Sun, Moon, Circle, Settings, Cpu, MemoryStick, Activity } from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { invoke } from "@tauri-apps/api/core";

interface StatusBarProps {
  cwd: string;
  shell: string;
  onOpenSettings?: () => void;
  onOpenMonitor?: () => void;
}

export interface SystemStats {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}M`;
}

function cpuColor(pct: number): string {
  if (pct > 80) return "text-red-400";
  if (pct > 50) return "text-yellow-400";
  return "text-ft-success";
}

function memColor(pct: number): string {
  if (pct > 85) return "text-red-400";
  if (pct > 60) return "text-yellow-400";
  return "text-ft-success";
}

export function StatusBar({ cwd, shell, onOpenSettings, onOpenMonitor }: StatusBarProps) {
  const shellName = shell.split("/").pop() ?? shell;
  const { theme, toggleTheme } = useThemeStore();
  const { settings } = useSettingsStore();
  const displayCwd = cwd || "~";

  const [stats, setStats] = useState<SystemStats | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const fetchStats = () => {
      invoke<SystemStats>("get_system_stats")
        .then(setStats)
        .catch(() => {});
    };

    fetchStats();
    intervalRef.current = setInterval(fetchStats, 2000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

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
        {/* System stats (optional) */}
        {settings.showSystemStats && stats && (
          <>
            <div className="status-stats flex items-center gap-2.5">
              <div className="flex items-center gap-1" title={`CPU: ${stats.cpuUsage.toFixed(1)}%`}>
                <Cpu size={10} className={`opacity-70 ${cpuColor(stats.cpuUsage)}`} />
                <span className={`font-mono tabular-nums ${cpuColor(stats.cpuUsage)}`}>
                  {stats.cpuUsage.toFixed(0)}%
                </span>
              </div>
              <div
                className="flex items-center gap-1"
                title={`Memory: ${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)} (${stats.memoryPercent.toFixed(1)}%)`}
              >
                <MemoryStick size={10} className={`opacity-70 ${memColor(stats.memoryPercent)}`} />
                <span className={`font-mono tabular-nums ${memColor(stats.memoryPercent)}`}>
                  {stats.memoryPercent.toFixed(0)}%
                </span>
                <span className="opacity-40 font-mono">
                  {formatBytes(stats.memoryUsed)}
                </span>
              </div>
            </div>
            <div className="w-px h-3 bg-ft-border-subtle" />
          </>
        )}

        {/* System Monitor button */}
        <button
          onClick={onOpenMonitor}
          className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ft-elevated transition-colors"
          title="System Monitor (⌘⇧M)"
        >
          <Activity size={10} className="text-ft-text-muted" />
        </button>

        <div className="w-px h-3 bg-ft-border-subtle" />

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
