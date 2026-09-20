/**
 * Per-request overrides of how the send behaves.
 *
 * Every field is optional and shows the default when it is unset, so the panel
 * reads as "this request is normal except…" rather than as a form somebody has
 * to fill in. An unset field is stored as absent rather than as the default
 * value, which matters when the defaults change: a request that never asked for
 * a 30-second timeout should not be pinned to one for ever.
 */

import { RequestSettings, DEFAULT_SEND_OPTIONS } from "../../types/api";

interface SettingsPanelProps {
  settings: RequestSettings;
  onChange: (settings: RequestSettings) => void;
}

/** Drops a key rather than storing `undefined`, so the JSON has no empty slots. */
function without(settings: RequestSettings, key: keyof RequestSettings): RequestSettings {
  const next = { ...settings };
  delete next[key];
  return next;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const toggle = (key: "followRedirects" | "verifyTls", value: boolean) => {
    // Back to the default means the key goes away, not that it is written with
    // the default's current value.
    const isDefault = value === DEFAULT_SEND_OPTIONS[key];
    onChange(isDefault ? without(settings, key) : { ...settings, [key]: value });
  };

  const number = (key: "timeoutMs" | "maxRedirects", text: string) => {
    const parsed = Number(text);
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      onChange(without(settings, key));
      return;
    }
    onChange({ ...settings, [key]: Math.max(0, Math.round(parsed)) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-3 py-3 text-[11px]">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
          checked={settings.followRedirects ?? DEFAULT_SEND_OPTIONS.followRedirects}
          onChange={(e) => toggle("followRedirects", e.target.checked)}
        />
        <span className="text-ft-text">Follow redirects</span>
        <span className="text-ft-text-muted">
          Off shows the 301 itself, with its `Location`.
        </span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="w-3.5 h-3.5 accent-[color:var(--ft-accent)]"
          checked={settings.verifyTls ?? DEFAULT_SEND_OPTIONS.verifyTls}
          onChange={(e) => toggle("verifyTls", e.target.checked)}
        />
        <span className="text-ft-text">Verify certificates</span>
        <span className="text-ft-text-muted">
          Leave on unless this host has a certificate you already know about.
        </span>
      </label>

      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-ft-text-muted">Timeout</span>
        <input
          className="api-url w-28"
          inputMode="numeric"
          value={settings.timeoutMs ?? ""}
          placeholder={String(DEFAULT_SEND_OPTIONS.timeoutMs)}
          onChange={(e) => number("timeoutMs", e.target.value)}
          aria-label="Timeout in milliseconds"
        />
        <span className="text-ft-text-muted">milliseconds, or 0 for no limit</span>
      </label>

      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-ft-text-muted">Max redirects</span>
        <input
          className="api-url w-28"
          inputMode="numeric"
          value={settings.maxRedirects ?? ""}
          placeholder={String(DEFAULT_SEND_OPTIONS.maxRedirects)}
          onChange={(e) => number("maxRedirects", e.target.value)}
          aria-label="Maximum redirects"
        />
      </label>

      <div className="text-ft-text-muted pt-1 border-t border-ft-border-subtle">
        These are saved with the request, and travel with it on export as the
        format's own behaviour block.
      </div>
    </div>
  );
}
