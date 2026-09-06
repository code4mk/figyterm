import { invoke } from "@tauri-apps/api/core";

export type UpdateChannel = "stable" | "prerelease";

export type UpdateStatus =
  | "up-to-date"
  | "update-available"
  /** Installed version is newer than any release — a local dev build, not an error. */
  | "dev-build";

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  isPrerelease: boolean;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string | null;
  downloadUrl: string | null;
  downloadSize: number | null;
  assetName: string | null;
  checkedAt: number;
}

export const RELEASES_URL = "https://github.com/code4mk/figyterm/releases";
export const XATTR_COMMAND = "xattr -cr /Applications/FigyTerm.app";

/**
 * `force` bypasses the one-hour backend cache. Use it for an explicit "Check Now",
 * not for the automatic background check.
 */
export async function checkForUpdates(
  channel: UpdateChannel,
  force = false
): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_updates", { channel, force });
}

export async function getCurrentVersion(): Promise<string> {
  return invoke<string>("get_current_version");
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatCheckedAt(timestamp: number | null): string {
  if (!timestamp) return "Never";

  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "Just now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
