import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

/**
 * Install side of the update system.
 *
 * Discovery stays with the GitHub Releases API (see `updater.ts`) because it
 * gives us rich release notes, dates and asset sizes. This module is only the
 * mechanism that actually swaps the app bundle, via Tauri's updater plugin.
 *
 * The plugin verifies a minisign signature on the payload, which is unrelated
 * to Apple code signing — it works fine for an unsigned app. And because the
 * plugin downloads over HTTP rather than through a browser, the installed
 * bundle carries no macOS quarantine flag, so updates need no `xattr` step.
 */

export interface InstallProgress {
  downloaded: number;
  /** Null when the server didn't send a content length. */
  total: number | null;
}

/** Thrown when the release has no `latest.json` the plugin can use. */
export const NO_MANIFEST = "NO_MANIFEST";

/** Thrown when the manifest advertises a different version than the UI showed. */
export const VERSION_MISMATCH = "VERSION_MISMATCH";

export async function downloadAndInstallUpdate(
  expectedVersion: string,
  onProgress: (progress: InstallProgress) => void
): Promise<void> {
  const update = await check();

  // Releases published before the updater shipped have no manifest, and
  // `tauri dev` has no bundle to replace. Both land here.
  if (!update) throw new Error(NO_MANIFEST);

  // The updater endpoint resolves to the latest *stable* release, so on the
  // prerelease channel it can advertise a different version than the one the
  // user is looking at. Never silently install something other than what was
  // shown — hand those cases to the manual flow instead.
  if (update.version !== expectedVersion) throw new Error(VERSION_MISMATCH);

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress({ downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded: total ?? downloaded, total });
        break;
    }
  });
}

/** Relaunches into the newly installed version. Does not return. */
export async function restartApp(): Promise<void> {
  await invoke("restart_app");
}

/**
 * Commands running in any pane right now. Restarting kills them, so the UI
 * confirms before installing when this is non-empty.
 */
export async function runningCommands(): Promise<string[]> {
  try {
    return await invoke<string[]>("running_foreground_commands");
  } catch {
    return [];
  }
}
