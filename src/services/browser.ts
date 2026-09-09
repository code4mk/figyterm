import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export const BROWSER_HOME_URL = "https://www.google.com";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Device pixels per CSS pixel, as the app's own webview reports it.
   *
   * The rect above is CSS pixels, and something has to turn those into the
   * device pixels a native child webview is placed in. Letting the Rust side
   * work it out from the window handle is what put the browser 12% adrift on
   * Windows: wry's `set_bounds` derives its factor from `hwnd_dpi`, and that
   * disagreed with the factor WebView2 had actually laid the page out at. The
   * two cannot disagree if the number comes from the same webview that produced
   * the rect.
   */
  scale: number;
}

export interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface PopupPayload {
  openerTabId: string;
  url: string;
}

interface ClosedPayload {
  tabId: string;
}

/**
 * Creating a child webview is the one call here that can fail by never
 * answering rather than by returning an error: it hands off to the platform's
 * own webview engine, which on Windows means WebView2 spinning a nested message
 * pump. When that doesn't come back, the modal used to sit on "No page loaded"
 * forever with nothing to show for it.
 *
 * Generous, because a cold WebView2 environment on a slow or virtualised
 * machine genuinely can take several seconds to come up.
 */
const OPEN_TIMEOUT_MS = 15_000;

export function openBrowserTab(
  tabId: string,
  url: string,
  bounds: BrowserBounds
): Promise<BrowserTabState> {
  const open = invoke<BrowserTabState>("browser_open_tab", { tabId, url, bounds });

  return new Promise<BrowserTabState>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `the webview did not open within ${OPEN_TIMEOUT_MS / 1000}s — ` +
              "the platform's browser engine did not respond"
          )
        ),
      OPEN_TIMEOUT_MS
    );
    open.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function closeBrowserTab(tabId: string): Promise<void> {
  return invoke("browser_close_tab", { tabId });
}

export function closeAllBrowserTabs(): Promise<void> {
  return invoke("browser_close_all");
}

export function setBrowserBounds(tabId: string, bounds: BrowserBounds): Promise<void> {
  return invoke("browser_set_bounds", { tabId, bounds });
}

export function setBrowserVisible(
  tabId: string,
  visible: boolean,
  bounds?: BrowserBounds
): Promise<void> {
  return invoke("browser_set_visible", { tabId, visible, bounds: bounds ?? null });
}

export function navigateBrowser(tabId: string, url: string): Promise<void> {
  return invoke("browser_navigate", { tabId, url });
}

export function browserGoBack(tabId: string): Promise<void> {
  return invoke("browser_go_back", { tabId });
}

export function browserGoForward(tabId: string): Promise<void> {
  return invoke("browser_go_forward", { tabId });
}

export function reloadBrowser(tabId: string): Promise<void> {
  return invoke("browser_reload", { tabId });
}

export function stopBrowser(tabId: string): Promise<void> {
  return invoke("browser_stop", { tabId });
}

export function focusBrowser(tabId: string): Promise<void> {
  return invoke("browser_focus", { tabId });
}

export function setBrowserZoom(tabId: string, factor: number): Promise<void> {
  return invoke("browser_set_zoom", { tabId, factor });
}

export function setBrowserTheme(theme: "light" | "dark"): Promise<void> {
  return invoke("browser_set_theme", { theme });
}

export function onBrowserState(
  handler: (state: BrowserTabState) => void
): Promise<UnlistenFn> {
  return listen<BrowserTabState>("browser://state", (event) => handler(event.payload));
}

export function onBrowserPopup(
  handler: (openerTabId: string, url: string) => void
): Promise<UnlistenFn> {
  return listen<PopupPayload>("browser://popup", (event) =>
    handler(event.payload.openerTabId, event.payload.url)
  );
}

export function onBrowserClosed(handler: (tabId: string) => void): Promise<UnlistenFn> {
  return listen<ClosedPayload>("browser://closed", (event) => handler(event.payload.tabId));
}

export function rectToBounds(rect: DOMRect): BrowserBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    // `|| 1` because a devicePixelRatio of 0 would collapse the webview to
    // nothing; no browser reports that, but neither does anything guarantee it.
    scale: window.devicePixelRatio || 1,
  };
}

/** Short, host-only label for a URL, used for tab titles before the real title arrives. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function faviconUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}
