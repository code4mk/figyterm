import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export const BROWSER_HOME_URL = "https://www.google.com";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
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

export function openBrowserTab(
  tabId: string,
  url: string,
  bounds: BrowserBounds
): Promise<BrowserTabState> {
  return invoke<BrowserTabState>("browser_open_tab", { tabId, url, bounds });
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
