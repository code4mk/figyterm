import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, PictureInPicture2, Maximize2, Cpu, MemoryStick, HardDrive } from "lucide-react";
import Chart from "react-apexcharts";
import { useThemeStore } from "../../stores/themeStore";

interface SystemStats {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
}

interface SystemMonitorProps {
  visible: boolean;
  onClose: () => void;
}

const CHART_POINTS = 60;
const POLL_MS = 1000;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function SystemMonitor({ visible, onClose }: SystemMonitorProps) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<{ x: number; y: number }[]>([]);
  const [memHistory, setMemHistory] = useState<{ x: number; y: number }[]>([]);
  const [pipMode, setPipMode] = useState(false);
  const [activeChart, setActiveChart] = useState<"cpu" | "memory">("cpu");
  const modalRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 520, h: 400 });
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!visible) return;

    setCpuHistory([]);
    setMemHistory([]);
    setPos(null);
    setPipMode(false);
    setSize({ w: 520, h: 400 });

    const fetchStats = () => {
      invoke<SystemStats>("get_system_stats")
        .then((s) => {
          const now = Date.now();
          setStats(s);
          setCpuHistory((prev) => {
            const next = [...prev, { x: now, y: Math.round(s.cpuUsage * 10) / 10 }];
            return next.length > CHART_POINTS ? next.slice(-CHART_POINTS) : next;
          });
          setMemHistory((prev) => {
            const next = [...prev, { x: now, y: Math.round(s.memoryPercent * 10) / 10 }];
            return next.length > CHART_POINTS ? next.slice(-CHART_POINTS) : next;
          });
        })
        .catch(() => {});
    };

    fetchStats();
    intervalRef.current = setInterval(fetchStats, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [visible]);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const modal = modalRef.current;
    if (!modal) return;
    const rect = modal.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos?.x ?? rect.left, origY: pos?.y ?? rect.top };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      setPos({ x: Math.max(0, dragRef.current.origX + (ev.clientX - dragRef.current.startX)), y: Math.max(0, dragRef.current.origY + (ev.clientY - dragRef.current.startY)) });
    };
    const onUp = () => { dragRef.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [pos]);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      setSize({ w: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeRef.current.origW + (ev.clientX - resizeRef.current.startX))), h: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, resizeRef.current.origH + (ev.clientY - resizeRef.current.startY))) });
    };
    const onUp = () => { resizeRef.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [size]);

  const togglePip = useCallback(() => {
    setPipMode((prev) => {
      if (!prev) { setSize({ w: 440, h: 340 }); setPos({ x: window.innerWidth - 460, y: window.innerHeight - 380 }); }
      else { setPos(null); setSize({ w: 520, h: 400 }); }
      return !prev;
    });
  }, []);

  const isDark = theme === "dark";

  const chartOptions = useMemo((): ApexCharts.ApexOptions => ({
    chart: {
      type: "area",
      sparkline: { enabled: false },
      toolbar: { show: false },
      zoom: { enabled: false },
      animations: { enabled: true, easing: "smooth", dynamicAnimation: { speed: 400 } },
      background: "transparent",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    dataLabels: { enabled: false },
    stroke: {
      curve: "smooth",
      width: 2,
      colors: [activeChart === "cpu" ? "#84cc16" : "#38bdf8"],
    },
    fill: {
      type: "gradient",
      gradient: {
        shade: isDark ? "dark" : "light",
        type: "vertical",
        opacityFrom: 0.35,
        opacityTo: 0.02,
        stops: [0, 100],
        colorStops: [{
          offset: 0,
          color: activeChart === "cpu" ? "#84cc16" : "#38bdf8",
          opacity: 0.3,
        }, {
          offset: 100,
          color: activeChart === "cpu" ? "#84cc16" : "#38bdf8",
          opacity: 0.02,
        }],
      },
    },
    xaxis: {
      type: "datetime",
      labels: {
        datetimeUTC: false,
        format: "HH:mm:ss",
        style: {
          colors: isDark ? "#4a4f5a" : "#9ca3af",
          fontSize: "9px",
        },
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      crosshairs: {
        stroke: { color: isDark ? "#333" : "#d1d5db", width: 1, dashArray: 3 },
      },
    },
    yaxis: {
      min: 0,
      max: 100,
      tickAmount: 4,
      labels: {
        formatter: (v: number) => `${v}%`,
        style: {
          colors: isDark ? "#4a4f5a" : "#9ca3af",
          fontSize: "9px",
        },
      },
    },
    grid: {
      borderColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)",
      strokeDashArray: 3,
      xaxis: { lines: { show: true } },
      yaxis: { lines: { show: true } },
      padding: { left: 4, right: 4, top: 0, bottom: 0 },
    },
    tooltip: {
      enabled: true,
      theme: isDark ? "dark" : "light",
      x: { format: "HH:mm:ss" },
      y: { formatter: (v: number) => `${v.toFixed(1)}%` },
      style: { fontSize: "10px" },
    },
    markers: { size: 0, hover: { size: 4 } },
  }), [isDark, activeChart]);

  const chartSeries = useMemo(() => [{
    name: activeChart === "cpu" ? "CPU" : "Memory",
    data: activeChart === "cpu" ? cpuHistory : memHistory,
  }], [activeChart, cpuHistory, memHistory]);

  if (!visible) return null;

  const chartHeight = size.h - 170;
  const currentCpu = stats?.cpuUsage ?? 0;
  const currentMem = stats?.memoryPercent ?? 0;

  const modalStyle: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: size.w }
    : { width: size.w };

  const modal = (
    <div
      ref={modalRef}
      className={`monitor-modal rounded-xl overflow-hidden shadow-2xl ${pipMode ? "monitor-pip" : ""}`}
      style={modalStyle}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="monitor-header flex items-center justify-between px-3 py-2 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={handleDragStart}
      >
        <span className="text-xs font-semibold monitor-title">System Monitor</span>
        <div className="flex items-center gap-1">
          <button
            className="monitor-btn p-1 rounded transition-colors"
            onClick={(e) => { e.stopPropagation(); togglePip(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title={pipMode ? "Exit PiP" : "PiP mode"}
          >
            {pipMode ? <Maximize2 size={12} /> : <PictureInPicture2 size={12} />}
          </button>
          <button
            className="monitor-btn p-1 rounded transition-colors"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="flex gap-2 px-3 py-2">
        <button
          className={`monitor-stat-card flex-1 rounded-lg px-3 py-2 transition-colors ${activeChart === "cpu" ? "active cpu" : ""}`}
          onClick={() => setActiveChart("cpu")}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Cpu size={12} className="monitor-stat-icon" />
            <span className="text-[10px] font-medium monitor-stat-label">CPU</span>
          </div>
          <div className="text-lg font-bold font-mono tabular-nums monitor-stat-value">
            {currentCpu.toFixed(1)}%
          </div>
        </button>

        <button
          className={`monitor-stat-card flex-1 rounded-lg px-3 py-2 transition-colors ${activeChart === "memory" ? "active mem" : ""}`}
          onClick={() => setActiveChart("memory")}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <MemoryStick size={12} className="monitor-stat-icon" />
            <span className="text-[10px] font-medium monitor-stat-label">Memory</span>
          </div>
          <div className="text-lg font-bold font-mono tabular-nums monitor-stat-value">
            {currentMem.toFixed(1)}%
          </div>
          {stats && (
            <div className="text-[9px] font-mono monitor-stat-sub mt-0.5">
              {formatBytes(stats.memoryUsed)} / {formatBytes(stats.memoryTotal)}
            </div>
          )}
        </button>

        <div className="monitor-stat-card flex-1 rounded-lg px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <HardDrive size={12} className="monitor-stat-icon" />
            <span className="text-[10px] font-medium monitor-stat-label">Info</span>
          </div>
          <div className="text-[9px] font-mono monitor-stat-sub mt-1">
            Interval: {POLL_MS / 1000}s
          </div>
          <div className="text-[9px] font-mono monitor-stat-sub">
            Window: {CHART_POINTS}s
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="px-3 pb-2">
        <div className="monitor-chart-container rounded-lg overflow-hidden" style={{ height: Math.max(100, chartHeight) }}>
          <Chart
            type="area"
            height={Math.max(100, chartHeight)}
            width="100%"
            options={chartOptions}
            series={chartSeries}
          />
        </div>
      </div>

      {/* Resize handle */}
      <div className="monitor-resize-handle" onPointerDown={handleResizeStart}>
        <svg width="10" height="10" viewBox="0 0 10 10" className="monitor-resize-icon">
          <path d="M9 1L1 9M9 5L5 9M9 9L9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );

  if (pipMode) return modal;

  return (
    <div
      className="fixed inset-0 z-[250] flex items-start justify-center pt-[10vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {modal}
    </div>
  );
}
