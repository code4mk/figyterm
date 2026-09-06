import { Fragment, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {
  X,
  Download,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  Copy,
  TerminalSquare,
  Sparkles,
  FlaskConical,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Markdown } from "./Markdown";
import {
  UpdateInfo,
  RELEASES_URL,
  XATTR_COMMAND,
  formatBytes,
  formatReleaseDate,
} from "../../services/updater";
import {
  downloadAndInstallUpdate,
  restartApp,
  runningCommands,
  NO_MANIFEST,
  VERSION_MISMATCH,
  type InstallProgress,
} from "../../services/installer";

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  info: UpdateInfo | null;
  loading: boolean;
  error: string | null;
  onCheck: () => void;
  /** Pane session to paste the xattr command into, when one is focused. */
  activeSessionId?: string | null;
}

export function UpdateModal({
  isOpen,
  onClose,
  info,
  loading,
  error,
  onCheck,
  activeSessionId,
}: UpdateModalProps) {
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
            <Dialog.Panel className="settings-modal w-full max-w-lg rounded-xl overflow-hidden flex flex-col max-h-[80vh]">
              <div className="settings-header flex items-center justify-between px-6 py-4 shrink-0">
                <Dialog.Title className="text-sm font-semibold text-ft-text">
                  Software Update
                </Dialog.Title>
                <button
                  onClick={onClose}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-surface transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                {loading && <CheckingState />}
                {!loading && error && <ErrorState message={error} onRetry={onCheck} />}
                {!loading && !error && info && (
                  <ResultState info={info} activeSessionId={activeSessionId} />
                )}
                {!loading && !error && !info && <IdleState />}
              </div>

              <div className="settings-footer flex items-center justify-between px-6 py-3 shrink-0">
                <button
                  onClick={onCheck}
                  disabled={loading}
                  className="flex items-center gap-1.5 text-xs text-ft-text-muted hover:text-ft-text transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
                  Check Again
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

function CheckingState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3">
      <Loader2 size={22} className="animate-spin text-ft-accent" />
      <p className="text-xs text-ft-text-secondary">Checking for updates…</p>
    </div>
  );
}

function IdleState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3">
      <RefreshCw size={22} className="text-ft-text-muted" />
      <p className="text-xs text-ft-text-secondary">
        Check whether a newer version of FigyTerm is available.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
      <AlertCircle size={22} className="text-red-400" />
      <div>
        <p className="text-xs font-medium text-ft-text">Couldn't check for updates</p>
        <p className="text-[11px] text-ft-text-muted mt-1 max-w-xs">{message}</p>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={onRetry}
          className="px-3 py-1.5 text-[11px] font-medium text-white bg-ft-accent rounded-lg hover:bg-ft-accent-hover transition-colors"
        >
          Try Again
        </button>
        <button
          onClick={() => openExternal(RELEASES_URL).catch(() => {})}
          className="px-3 py-1.5 text-[11px] font-medium text-ft-text-secondary hover:text-ft-text transition-colors"
        >
          Open Releases Page
        </button>
      </div>
    </div>
  );
}

function ResultState({
  info,
  activeSessionId,
}: {
  info: UpdateInfo;
  activeSessionId?: string | null;
}) {
  if (info.status === "up-to-date") {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
        <div className="flex items-center justify-center w-11 h-11 rounded-full bg-ft-success/10">
          <Check size={20} className="text-ft-success" />
        </div>
        <div>
          <p className="text-xs font-medium text-ft-text">FigyTerm is up to date</p>
          <p className="text-[11px] text-ft-text-muted mt-1">
            You're running version {info.currentVersion}.
          </p>
        </div>
      </div>
    );
  }

  if (info.status === "dev-build") {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
        <div className="flex items-center justify-center w-11 h-11 rounded-full bg-ft-accent/10">
          <FlaskConical size={20} className="text-ft-accent" />
        </div>
        <div>
          <p className="text-xs font-medium text-ft-text">You're on a development build</p>
          <p className="text-[11px] text-ft-text-muted mt-1 max-w-xs">
            Version {info.currentVersion} is newer than the latest release (
            {info.latestVersion}).
          </p>
        </div>
      </div>
    );
  }

  return <UpdateAvailable info={info} activeSessionId={activeSessionId} />;
}

type InstallPhase = "idle" | "confirm" | "downloading" | "installed" | "failed";

function explainInstallFailure(message: string, version: string): string {
  if (message === NO_MANIFEST) {
    return `FigyTerm ${version} doesn't support one-click updates. Install it manually — after that, updates are automatic.`;
  }
  if (message === VERSION_MISMATCH) {
    return `The updater offered a different version than the one shown here, so nothing was installed. Use the manual download to get ${version} specifically.`;
  }
  return `The update couldn't be installed automatically (${message}). You can install it manually instead.`;
}

function UpdateAvailable({
  info,
  activeSessionId,
}: {
  info: UpdateInfo;
  activeSessionId?: string | null;
}) {
  const released = formatReleaseDate(info.publishedAt);

  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [busyCommands, setBusyCommands] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const install = async () => {
    setPhase("downloading");
    setProgress(null);
    setFailure(null);
    try {
      await downloadAndInstallUpdate(info.latestVersion, setProgress);
      setPhase("installed");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFailure(explainInstallFailure(message, info.latestVersion));
      setPhase("failed");
      setShowManual(true);
    }
  };

  // Restarting kills every pane, so check for running commands first.
  const startInstall = async () => {
    const running = await runningCommands();
    if (running.length > 0) {
      setBusyCommands(running);
      setPhase("confirm");
      return;
    }
    install();
  };

  const percent =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="space-y-5">
      {/* Version header */}
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-ft-accent/10 shrink-0">
          <Sparkles size={16} className="text-ft-accent" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-semibold text-ft-text">
              FigyTerm {info.latestVersion} is available
            </p>
            {info.isPrerelease && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-ft-elevated text-ft-text-muted">
                Pre-release
              </span>
            )}
          </div>
          <p className="text-[11px] text-ft-text-muted mt-0.5">
            You have {info.currentVersion}
            {released ? ` · Released ${released}` : ""}
            {info.downloadSize ? ` · ${formatBytes(info.downloadSize)}` : ""}
          </p>
        </div>
      </div>

      {phase === "idle" && (
        <div className="flex items-center gap-2">
          <button
            onClick={startInstall}
            className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-medium text-white bg-ft-accent rounded-lg hover:bg-ft-accent-hover transition-colors"
          >
            <Download size={13} />
            Install Update
          </button>
          <button
            onClick={() => openExternal(info.releaseUrl).catch(() => {})}
            className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-medium text-ft-text-secondary hover:text-ft-text rounded-lg hover:bg-ft-elevated transition-colors"
          >
            <ExternalLink size={13} />
            View on GitHub
          </button>
        </div>
      )}

      {phase === "confirm" && (
        <div className="settings-card rounded-lg px-4 py-3 space-y-2.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-yellow-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-[11px] font-medium text-ft-text">
                Something is still running
              </p>
              <p className="text-[10px] text-ft-text-muted mt-1 leading-relaxed">
                Installing restarts FigyTerm, which will end{" "}
                <span className="font-mono text-ft-text-secondary">
                  {busyCommands.join(", ")}
                </span>
                . Finish up first if you need to.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPhase("idle")}
              className="px-3 py-1.5 text-[11px] font-medium text-white bg-ft-accent rounded-lg hover:bg-ft-accent-hover transition-colors"
            >
              Wait
            </button>
            <button
              onClick={install}
              className="px-3 py-1.5 text-[11px] font-medium text-ft-text-secondary hover:text-ft-text transition-colors"
            >
              Install Anyway
            </button>
          </div>
        </div>
      )}

      {phase === "downloading" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ft-text-secondary">Downloading…</span>
            <span className="text-ft-text-muted tabular-nums">
              {percent !== null
                ? `${percent}%`
                : progress
                ? formatBytes(progress.downloaded)
                : ""}
            </span>
          </div>
          <div className="h-1 rounded-full bg-ft-elevated overflow-hidden">
            <div
              className="h-full bg-ft-accent transition-all duration-200"
              style={{ width: percent !== null ? `${percent}%` : "35%" }}
            />
          </div>
        </div>
      )}

      {phase === "installed" && (
        <div className="settings-card rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <Check size={14} className="text-ft-success shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-ft-text">
                FigyTerm {info.latestVersion} is installed
              </p>
              <p className="text-[10px] text-ft-text-muted mt-1">
                Restart to finish. Your open panes will close.
              </p>
              <button
                onClick={() => restartApp().catch(() => {})}
                className="mt-2.5 px-3 py-1.5 text-[11px] font-medium text-white bg-ft-accent rounded-lg hover:bg-ft-accent-hover transition-colors"
              >
                Restart Now
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "failed" && failure && (
        <div className="flex items-start gap-2">
          <AlertCircle size={14} className="text-yellow-400 shrink-0 mt-0.5" />
          <p className="text-[10px] text-ft-text-muted leading-relaxed">{failure}</p>
        </div>
      )}

      {/* Manual install stays one click away, and opens itself if auto-install fails. */}
      {phase !== "downloading" && phase !== "installed" && (
        <div>
          {!showManual ? (
            <button
              onClick={() => setShowManual(true)}
              className="text-[10px] text-ft-text-muted hover:text-ft-text transition-colors"
            >
              Install manually instead
            </button>
          ) : (
            <ManualInstall info={info} activeSessionId={activeSessionId} />
          )}
        </div>
      )}

      {/* Release notes */}
      {info.releaseNotes.trim() && (
        <div>
          <h4 className="text-[10px] font-semibold text-ft-text-muted uppercase tracking-wider mb-2">
            What's New
          </h4>
          <div className="settings-card rounded-lg px-4 py-3 max-h-52 overflow-y-auto">
            <Markdown source={info.releaseNotes} />
          </div>
        </div>
      )}
    </div>
  );
}

function ManualInstall({
  info,
  activeSessionId,
}: {
  info: UpdateInfo;
  activeSessionId?: string | null;
}) {
  return (
    <div className="space-y-3">
      <button
        onClick={() => openExternal(info.downloadUrl || info.releaseUrl).catch(() => {})}
        className="flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-medium text-ft-text-secondary hover:text-ft-text rounded-lg bg-ft-elevated transition-colors"
      >
        <Download size={13} />
        {info.downloadUrl ? "Download .dmg" : "Get It on GitHub"}
      </button>

      {!info.downloadUrl && (
        <p className="text-[10px] text-ft-text-muted">
          No installer matching this Mac was found on the release. The GitHub page
          lists every available download.
        </p>
      )}

      <InstallInstructions activeSessionId={activeSessionId} />
    </div>
  );
}

/**
 * FigyTerm ships unsigned, so macOS quarantines the downloaded DMG and refuses
 * to launch the app until the flag is cleared. Rather than burying that in a
 * release body nobody reads, it lives right next to the download button.
 */
function InstallInstructions({ activeSessionId }: { activeSessionId?: string | null }) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(XATTR_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable; the command is visible and selectable anyway.
    }
  };

  // Paste, but deliberately do not send a newline — the user presses Enter
  // themselves, so nothing runs in their shell without their say-so.
  const sendToTerminal = async () => {
    if (!activeSessionId) return;
    try {
      await invoke("write_terminal_session", {
        sessionId: activeSessionId,
        data: Array.from(new TextEncoder().encode(XATTR_COMMAND)),
      });
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch {
      // Non-fatal: the copy button remains available.
    }
  };

  return (
    <div>
      <h4 className="text-[10px] font-semibold text-ft-text-muted uppercase tracking-wider mb-2">
        Installing
      </h4>
      <div className="settings-card rounded-lg px-4 py-3 space-y-2.5">
        <ol className="space-y-1.5 text-[11px] text-ft-text-secondary list-decimal ml-4">
          <li>Open the downloaded .dmg file</li>
          <li>
            Drag <span className="text-ft-text font-medium">FigyTerm</span> into your{" "}
            <span className="text-ft-text font-medium">Applications</span> folder
          </li>
          <li>Run this command in a terminal:</li>
        </ol>

        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded-md bg-ft-elevated font-mono text-[11px] text-ft-text overflow-x-auto whitespace-nowrap">
            {XATTR_COMMAND}
          </code>
          <button
            onClick={copy}
            title="Copy command"
            className="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-elevated transition-colors"
          >
            {copied ? <Check size={13} className="text-ft-success" /> : <Copy size={13} />}
          </button>
          {activeSessionId && (
            <button
              onClick={sendToTerminal}
              title="Paste into the active terminal (you press Enter)"
              className="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-ft-text-muted hover:text-ft-text hover:bg-ft-elevated transition-colors"
            >
              {sent ? (
                <Check size={13} className="text-ft-success" />
              ) : (
                <TerminalSquare size={13} />
              )}
            </button>
          )}
        </div>

        <p className="text-[10px] text-ft-text-muted leading-relaxed">
          FigyTerm isn't code-signed with an Apple Developer ID, so macOS quarantines
          it on download. This command clears that flag. If macOS still blocks the
          app, open{" "}
          <span className="text-ft-text-secondary">
            System Settings → Privacy &amp; Security
          </span>{" "}
          and click <span className="text-ft-text-secondary">Open Anyway</span>.
        </p>
      </div>
    </div>
  );
}
