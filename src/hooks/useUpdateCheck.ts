import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { checkForUpdates, UpdateInfo } from "../services/updater";

/** Wait before the automatic check so it never competes with terminal spawn. */
const STARTUP_DELAY_MS = 5000;
/** Don't hit the network more than once a day on the user's behalf. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useUpdateCheck() {
  const { settings, updateSettings } = useSettingsStore();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  // Settings are read inside callbacks that shouldn't re-fire when unrelated
  // preferences change, so keep a ref alongside the reactive value.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const runCheck = useCallback(
    async (options: { force: boolean; silent: boolean }) => {
      const { updateChannel } = settingsRef.current;

      if (!options.silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const result = await checkForUpdates(updateChannel, options.force);
        setInfo(result);
        setError(null);
        updateSettings({ lastUpdateCheck: result.checkedAt });

        if (
          options.silent &&
          result.updateAvailable &&
          result.latestVersion !== settingsRef.current.dismissedVersion
        ) {
          setToastVisible(true);
        }
        return result;
      } catch (e) {
        const message = typeof e === "string" ? e : "Something went wrong.";
        // A failed background check stays invisible — the user didn't ask.
        if (!options.silent) setError(message);
        return null;
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [updateSettings]
  );

  /** Explicit user action: bypass the cache and surface errors. */
  const checkNow = useCallback(() => {
    return runCheck({ force: true, silent: false });
  }, [runCheck]);

  const dismissToast = useCallback(() => {
    setToastVisible(false);
    if (info?.latestVersion) {
      updateSettings({ dismissedVersion: info.latestVersion });
    }
  }, [info, updateSettings]);

  /** Hide the toast without marking the version dismissed. */
  const hideToast = useCallback(() => setToastVisible(false), []);

  // `runCheck` is stable, so this only arms once on mount. The timer plus its
  // cleanup is what guarantees a single in-flight check — deliberately not a
  // "has run" ref, which would cancel itself under React StrictMode's
  // mount/unmount/remount and silently disable the check in development.
  useEffect(() => {
    const { autoCheckUpdates, lastUpdateCheck } = settingsRef.current;
    if (!autoCheckUpdates) return;
    if (lastUpdateCheck && Date.now() - lastUpdateCheck < CHECK_INTERVAL_MS) return;

    const timer = setTimeout(() => {
      runCheck({ force: false, silent: true });
    }, STARTUP_DELAY_MS);

    return () => clearTimeout(timer);
  }, [runCheck]);

  return {
    info,
    loading,
    error,
    checkNow,
    toastVisible,
    dismissToast,
    hideToast,
    updateAvailable:
      info?.updateAvailable === true &&
      info.latestVersion !== settings.dismissedVersion,
  };
}
