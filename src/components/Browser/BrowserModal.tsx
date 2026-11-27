import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FigyMark } from "../Shared/FigyMark";
import { MakePrimary, PrimaryHome } from "../AppShell/PrimaryChrome";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useThemeStore } from "../../stores/themeStore";
import { OverlayPortal } from "../Overlay/OverlayPortal";
import {
  claimFront,
  isCovered,
  releaseFront,
  subscribeOverlayStack,
} from "../../services/overlay-stack";
import { useOverlayZSync } from "../../hooks/useOverlayZSync";
import {
  baseSlotRect,
  fullscreenRect,
} from "../../hooks/useDraggableModal";
import { BASE_SLOT_Z } from "../../hooks/useBaseSlot";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Plus,
  Globe,
  ExternalLink,
  Maximize2,
  Minimize2,
  Lock,
  TriangleAlert,
} from "lucide-react";
import {
  BROWSER_HOME_URL,
  BrowserTabState,
  browserGoBack,
  browserGoForward,
  closeAllBrowserTabs,
  closeBrowserTab,
  faviconUrl,
  hostLabel,
  navigateBrowser,
  onBrowserClosed,
  onBrowserPopup,
  onBrowserState,
  openBrowserTab,
  rectToBounds,
  reloadBrowser,
  setBrowserVisible,
  stopBrowser,
  setBrowserTheme,
} from "../../services/browser";

interface BrowserModalProps {
  visible: boolean;
  onClose: () => void;
  /**
   * This is the base: it fills the slot above the status bar, never moves and
   * cannot be put away. See `useBaseSlot`.
   */
  docked?: boolean;
}

const MIN_WIDTH = 520;
const MIN_HEIGHT = 380;
const MAX_WIDTH = 1800;
const MAX_HEIGHT = 1200;
const DEFAULT_SIZE = { w: 940, h: 620 };
const MAX_TABS = 10;

export function BrowserModal({
  visible,
  onClose,
  docked = false,
}: BrowserModalProps) {
  const [tabs, setTabs] = useState<BrowserTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const theme = useThemeStore((s) => s.theme);

  // The native webview is repositioned over a one-way IPC hop, so it visibly lags a
  // modal that is being dragged or resized. It gets hidden for the duration instead.
  const [interacting, setInteracting] = useState(false);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>(DEFAULT_SIZE);

  const modalRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const creatingRef = useRef(false);
  const tabCountRef = useRef(0);

  /**
   * Keeps this window in front when it's opened or clicked.
   *
   * See `services/overlay-stack.ts` — several overlays can float at once, and
   * the raised value has to land on the outermost fixed element to count.
   */
  const [frontZ, setFrontZ] = useState<number | null>(null);
  // The base never joins the stack — there is nothing for it to be raised
  // above, and claiming a rank would put it over every open window.
  const raise = useCallback(() => {
    if (docked) return;
    setFrontZ(claimFront("browser"));
  }, [docked]);
  // A claim by any overlay renumbers the rest; this re-reads ours.
  useOverlayZSync("browser", setFrontZ);

  useEffect(() => {
    /*
      Becoming the primary gives up the claim.

      A window that is promoted was in the overlay stack, and `if (docked)
      return` left its rank there — so the stack still believed a floating
      window was open and frontmost. `noOverlayOpen()` then said no for the
      primary's own Escape, and the browser went on hiding its native page
      behind a window that had become the thing underneath.
    */
    if (docked) {
      releaseFront("browser");
      setFrontZ(null);
      return;
    }
    if (visible) {
      raise();
      return;
    }
    // Released on close, so whatever is still open becomes frontmost.
    releaseFront("browser");
    setFrontZ(null);
  }, [docked, visible, raise]);

  /*
    Pinned to the base slot while it is the base.

    This window keeps its own `pos`/`size` rather than using
    `useDraggableModal`, so it cannot use `useBaseSlot` — but it is the same
    rectangle, kept up to date the same way, and for the same reason: the
    native child webview is positioned from this element's geometry, so the
    page lands wrong if the frame is anywhere but where it says it is.
  */
  const wasDocked = useRef(false);

  useEffect(() => {
    if (!docked) {
      /*
        Back to a window's own geometry when something else takes the slot.
        Being primary means being pinned to the whole of it, and that position
        and size outlive the promotion — so without this the browser would
        reopen as a "popup" at 0,0 the size of the screen, covering whatever
        replaced it, with a native webview stretched over the lot.
      */
      if (!wasDocked.current) return;
      wasDocked.current = false;
      setFullscreen(false);
      setPos(null);
      setSize(DEFAULT_SIZE);
      return;
    }

    wasDocked.current = true;
    const follow = () => {
      const rect = baseSlotRect();
      setSize({ w: rect.w, h: rect.h });
      setPos({ x: rect.x, y: rect.y });
    };
    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [docked]);

  /**
   * Whether something is actually on top of the page.
   *
   * It matters far more here than anywhere else. The page is a *native child
   * webview*, which the platform composites above the app's own webview
   * entirely — no CSS z-index, stacking context or opacity can put anything
   * over it. So with the editor in front, the browser's chrome correctly went
   * behind while the page itself carried on painting straight through the
   * middle of the editor.
   *
   * The only thing that occludes a child webview is hiding it. What this used
   * to ask was "am I frontmost?", and the answer blanked the page the moment
   * any other overlay was clicked — including the editor sitting *beside* it in
   * picture-in-picture, overlapping nowhere, which looks exactly like the
   * browser has broken. So the question is now "is anything in front of me over
   * *this rectangle*", and the rectangle is the page's, not the window's: an
   * overlay lying across the toolbar is not over the page.
   *
   * Recomputed from a subscription because another overlay coming forward, or
   * being dragged, has to re-render *this* one.
   */
  const [stackVersion, setStackVersion] = useState(0);
  useEffect(() => subscribeOverlayStack(() => setStackVersion((v) => v + 1)), []);

  // `stackVersion` and the geometry are the dependencies that matter: between
  // them they change whenever this answer can.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const covered = useMemo(() => {
    const element = viewportRef.current;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    // A page with no area is not covered, it is collapsed — and reporting it
    // as covered would hide it while the modal is animating open.
    if (rect.width <= 0 || rect.height <= 0) return false;
    return isCovered("browser", {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [frontZ, stackVersion, pos, size]);


  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeTabId) ?? null,
    [tabs, activeTabId]
  );
  const tabIdsKey = useMemo(() => tabs.map((t) => t.tabId).join("|"), [tabs]);

  useEffect(() => {
    tabCountRef.current = tabs.length;
  }, [tabs.length]);

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return rectToBounds(rect);
  }, []);

  const suppressContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  /**
   * Waits for the reserved viewport to have a size, then opens a tab in it.
   *
   * The measurement can legitimately come back empty on the frame the modal
   * first renders. It used to return early there and say nothing, which left
   * the modal sitting on "No page loaded" with no tab, no error and no way
   * forward — clicking "+" measured the same zero rect and gave up just as
   * quietly. A few animation frames is all it takes, and if the rect is still
   * empty after that it's a real fault worth showing.
   */
  const createTab = useCallback(
    async (url: string) => {
      let bounds = measure();
      for (let attempt = 0; !bounds && attempt < 10; attempt++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        bounds = measure();
      }
      if (!bounds) {
        setError("The browser viewport has no size yet — try reopening the browser.");
        return;
      }

      const tabId = crypto.randomUUID();
      try {
        const state = await openBrowserTab(tabId, url, bounds);
        setTabs((prev) => [...prev, state]);
        setActiveTabId(tabId);
        setError(null);
      } catch (e) {
        // Also logged: the message is the only clue to a webview that the
        // platform refused to create, and the error bar truncates.
        console.error("browser: could not open a tab", e);
        setError(String(e));
      }
    },
    [measure]
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      try {
        await closeBrowserTab(tabId);
      } catch {
        // The webview may already be gone; local state is reconciled below either way.
      }
      setTabs((prev) => {
        const remaining = prev.filter((t) => t.tabId !== tabId);
        if (tabId === activeTabId) {
          const idx = prev.findIndex((t) => t.tabId === tabId);
          const next = remaining[Math.min(idx, remaining.length - 1)];
          setActiveTabId(next ? next.tabId : null);
        }
        return remaining;
      });
    },
    [activeTabId]
  );

  // --- Backend events ---------------------------------------------------------

  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [
      onBrowserState((state) =>
        setTabs((prev) =>
          prev.map((t) => (t.tabId === state.tabId ? { ...t, ...state } : t))
        )
      ),
      onBrowserPopup((_openerTabId, url) => {
        if (tabCountRef.current >= MAX_TABS) return;
        void createTab(url);
      }),
      onBrowserClosed((tabId) =>
        setTabs((prev) => prev.filter((t) => t.tabId !== tabId))
      ),
    ];

    return () => {
      unlisteners.forEach((p) => p.then((off) => off()).catch(() => {}));
    };
  }, [createTab]);

  // --- Lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (!visible) return;
    setBrowserTheme(theme).catch(() => {});
  }, [visible, theme]);

  useEffect(() => {
    if (!visible || tabs.length > 0 || creatingRef.current) return;
    creatingRef.current = true;
    const raf = requestAnimationFrame(() => {
      void createTab(BROWSER_HOME_URL).finally(() => {
        creatingRef.current = false;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, tabs.length, createTab]);

  useEffect(() => {
    return () => {
      void closeAllBrowserTabs().catch(() => {});
    };
  }, []);

  /**
   * Keeps exactly one native webview visible and aligned with the reserved viewport
   * rect. Runs on every geometry or visibility change.
   */
  useEffect(() => {
    const ids = tabIdsKey ? tabIdsKey.split("|") : [];
    if (ids.length === 0) return;

    // `covered`: see the note on it above — a child webview can only be
    // occluded by being hidden, so being covered means being hidden.
    if (!visible || interacting || covered) {
      ids.forEach((id) => void setBrowserVisible(id, false).catch(() => {}));
      return;
    }

    const bounds = measure();
    if (!bounds) return;

    ids.forEach((id) => {
      void setBrowserVisible(id, id === activeTabId, id === activeTabId ? bounds : undefined).catch(
        () => {}
      );
    });
  }, [visible, interacting, covered, activeTabId, tabIdsKey, pos, size, measure]);

  useEffect(() => {
    if (!visible) return;
    const onResize = () => {
      const bounds = measure();
      if (bounds && activeTabId && !interacting && !covered) {
        void setBrowserVisible(activeTabId, true, bounds).catch(() => {});
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [visible, activeTabId, interacting, covered, measure]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!visible || !el) return;

    const observer = new ResizeObserver(() => {
      const bounds = measure();
      if (bounds && activeTabId && !interacting && !covered) {
        void setBrowserVisible(activeTabId, true, bounds).catch(() => {});
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, activeTabId, interacting, covered, measure]);

  useEffect(() => {
    if (!editingAddress) setDraft(activeTab?.url ?? "");
  }, [activeTab?.url, editingAddress]);

  // --- Drag & resize ---------------------------------------------------------

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const modal = modalRef.current;
      if (!modal) return;

      const rect = modal.getBoundingClientRect();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pos?.x ?? rect.left,
        origY: pos?.y ?? rect.top,
      };
      setInteracting(true);

      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        setPos({
          x: Math.max(0, dragRef.current.origX + (ev.clientX - dragRef.current.startX)),
          y: Math.max(0, dragRef.current.origY + (ev.clientY - dragRef.current.startY)),
        });
      };
      const onUp = () => {
        dragRef.current = null;
        setInteracting(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pos]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
      setInteracting(true);

      const onMove = (ev: PointerEvent) => {
        if (!resizeRef.current) return;
        setSize({
          w: Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, resizeRef.current.origW + (ev.clientX - resizeRef.current.startX))
          ),
          h: Math.min(
            MAX_HEIGHT,
            Math.max(MIN_HEIGHT, resizeRef.current.origH + (ev.clientY - resizeRef.current.startY))
          ),
        });
      };
      const onUp = () => {
        resizeRef.current = null;
        setInteracting(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [size]
  );

  /**
   * Fullscreen: the modal takes the whole window.
   *
   * The geometry comes from the shared helper, so this mode matches the
   * editor's exactly.
   */
  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => {
      if (prev) {
        setPos(null);
        setSize(DEFAULT_SIZE);
      } else {
        const rect = fullscreenRect();
        setSize({ w: rect.w, h: rect.h });
        setPos({ x: rect.x, y: rect.y });
      }
      return !prev;
    });
  }, []);

  /** Keeps a fullscreen modal the size of the window it's filling. */
  useEffect(() => {
    if (!fullscreen) return;
    const follow = () => {
      const rect = fullscreenRect();
      setSize({ w: rect.w, h: rect.h });
      setPos({ x: rect.x, y: rect.y });
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [fullscreen]);

  // --- Actions ---------------------------------------------------------------

  const submitAddress = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      addressRef.current?.blur();
      setEditingAddress(false);
      // With no tab there is nothing to navigate, and returning here is what
      // made the address bar look broken: type a URL, press Enter, nothing.
      // Opening a tab on the typed address is what the user asked for anyway.
      if (!activeTabId) {
        void createTab(draft);
        return;
      }
      void navigateBrowser(activeTabId, draft).catch((err) => setError(String(err)));
    },
    [activeTabId, draft, createTab]
  );

  /**
   * The browser's own chords, and only those.
   *
   * Propagation is stopped per branch rather than up front. Swallowing every
   * keystroke meant that while the browser was open none of the app's
   * shortcuts worked — ⌘T did nothing, because the chord was consumed here
   * before it reached the window handler in `AppShell`. Anything the browser
   * doesn't claim now bubbles, so a new terminal tab still opens with the
   * browser in front of it.
   *
   * Plain typing is unaffected: every app shortcut requires a modifier, so
   * text going into the address bar matches none of them.
   */
  const handleModalKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        e.stopPropagation();
        if (editingAddress) {
          setEditingAddress(false);
          setDraft(activeTab?.url ?? "");
          addressRef.current?.blur();
        } else if (!docked) {
          // The base has nothing to close to; the key is still swallowed so it
          // does not travel on to the shell behind.
          onClose();
        }
      } else if (isMod && !e.shiftKey && !e.altKey && e.key === "l") {
        e.preventDefault();
        e.stopPropagation();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (isMod && !e.shiftKey && !e.altKey && e.key === "r" && activeTabId) {
        e.preventDefault();
        e.stopPropagation();
        void reloadBrowser(activeTabId).catch(() => {});
      }
    },
    [editingAddress, activeTab?.url, activeTabId, onClose]
  );

  // The base is never hidden; that is what being the base means.
  if (!visible && !docked) return null;

  const isSecure = activeTab?.url.startsWith("https://") ?? false;
  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)/.test(activeTab?.url ?? "");

  const modalStyle: React.CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y, width: size.w, height: size.h }
    : { width: size.w, height: size.h };

  const modal = (
    <div
      ref={modalRef}
      /*
        A window, and it says so — the last of the three to. The label names the
        page rather than just the window, because "Browser" alone does not say
        which of four tabs is on screen.
      */
      role="dialog"
      aria-modal={false}
      aria-label={
        activeTab ? `Figy Browser — ${activeTab.title || hostLabel(activeTab.url)}` : "Figy Browser"
      }
      className={`browser-modal overflow-hidden shadow-2xl flex flex-col ${
        fullscreen || docked ? "browser-fullscreen" : "rounded-xl"
      }`}
      style={modalStyle}
      onPointerDownCapture={raise}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleModalKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      onContextMenu={suppressContextMenu}
    >
      {/* Tab strip doubles as the drag handle, the way a real browser title bar does. */}
      <div
        className={`browser-chrome browser-tabstrip flex items-center gap-1 px-2 pt-1.5 pb-0 select-none ${
          docked ? "" : "cursor-grab active:cursor-grabbing"
        }`}
        onPointerDown={docked ? undefined : handleDragStart}
        onContextMenu={suppressContextMenu}
      >
        {/*
          Names the window, as the editor's does. Inside the strip rather than
          beside it, so it picks up the strip's own background and the drag
          handler already on the parent.
        */}
        {docked && <PrimaryHome className="mr-1 self-center" />}
        <div className="browser-brand flex items-center gap-2 pl-1 pr-2.5 mr-1 pb-1.5 shrink-0">
          <FigyMark size={16} />
          <span className="browser-brand-title text-[11px] font-semibold whitespace-nowrap">
            Figy Browser
          </span>
        </div>

        <div className="flex items-end gap-1 flex-1 min-w-0 overflow-x-auto browser-tabstrip-scroll">
          {tabs.map((tab) => (
            <div
              key={tab.tabId}
              role="tab"
              aria-selected={tab.tabId === activeTabId}
              className={`browser-tab group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-t-lg shrink-0 max-w-[180px] ${
                tab.tabId === activeTabId ? "active" : ""
              }`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setActiveTabId(tab.tabId)}
            >
              <TabIcon tab={tab} />
              <span className="browser-tab-title text-[11px] truncate flex-1 min-w-0">
                {tab.title || hostLabel(tab.url) || "New Tab"}
              </span>
              <button
                className="browser-tab-close p-0.5 rounded shrink-0"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.tabId);
                }}
                title="Close tab"
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          ))}

          {tabs.length < MAX_TABS && (
            <button
              className="browser-newtab-btn shrink-0 p-1 rounded mb-0.5"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void createTab(BROWSER_HOME_URL)}
              title="New tab"
              aria-label="New tab"
            >
              <Plus size={13} />
            </button>
          )}
        </div>

        {/*
          A hairline between the tabs and the window's own controls, the way the
          Claude window separates its two clusters: ✛ and ✕ are a few pixels
          apart and mean "one more tab" and "put the whole window away", and a
          gap of 2px is not enough to say so.
        */}
        <span className="browser-sep shrink-0" />

        <div className="flex items-center gap-0.5 shrink-0 pb-0.5">
          {/*
            No window controls on the base: these move or dismiss a window, and
            the base is neither moved nor dismissed. Changing it is a settings
            decision.
          */}
          {!docked && (
            <>
              <MakePrimary id="figy-browser" />
              <button
                className={`browser-btn p-1 rounded ${fullscreen ? "on" : ""}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={toggleFullscreen}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button
                className="browser-btn browser-btn-close p-1 rounded"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onClose}
                title="Close browser"
                aria-label="Close browser"
              >
                <X size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div
        className="browser-chrome browser-toolbar relative flex items-center gap-1 px-2 py-1.5"
        onContextMenu={suppressContextMenu}
      >
        <button
          className="browser-btn p-1.5 rounded"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTabId && void browserGoBack(activeTabId).catch(() => {})}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="browser-btn p-1.5 rounded"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTabId && void browserGoForward(activeTabId).catch(() => {})}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="browser-btn p-1.5 rounded"
          onClick={() => {
            if (!activeTabId) return;
            const action = activeTab?.loading ? stopBrowser : reloadBrowser;
            void action(activeTabId).catch(() => {});
          }}
          title={activeTab?.loading ? "Stop" : "Reload"}
          aria-label={activeTab?.loading ? "Stop" : "Reload"}
        >
          {activeTab?.loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>

        <form onSubmit={submitAddress} className="flex-1 min-w-0">
          <div className="browser-address flex items-center gap-2 px-2.5 py-1 rounded-md">
            {isSecure ? (
              <Lock size={11} className="browser-address-icon secure shrink-0" />
            ) : isLocal ? (
              <Globe size={11} className="browser-address-icon shrink-0" />
            ) : (
              <TriangleAlert size={11} className="browser-address-icon insecure shrink-0" />
            )}
            <input
              ref={addressRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                setEditingAddress(true);
                e.currentTarget.select();
              }}
              onBlur={() => setEditingAddress(false)}
              onPaste={(e) => e.stopPropagation()}
              placeholder="Search or enter address"
              spellCheck={false}
              autoComplete="off"
              className="browser-address-input flex-1 min-w-0 bg-transparent outline-none text-xs"
            />
          </div>
        </form>

        {/*
          Stays enabled with no tab open, on whatever is in the address bar:
          when the embedded webview can't be created at all, handing the URL to
          the system browser is the only way out of the modal that still works.
        */}
        <button
          className="browser-btn p-1.5 rounded"
          disabled={!activeTab?.url && !draft.trim()}
          onClick={() => {
            const typed = activeTab?.url || draft.trim();
            if (!typed) return;
            // The address bar takes bare hosts; the system opener does not.
            const url = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
            void openExternal(url).catch(() => {});
          }}
          title="Open in default browser"
          aria-label="Open in default browser"
        >
          <ExternalLink size={13} />
        </button>

        {activeTab?.loading && <div className="browser-progress" />}
      </div>

      {error && (
        <div className="browser-error flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]">
          <span className="truncate">{error}</span>
          <button className="browser-btn p-0.5 rounded shrink-0" onClick={() => setError(null)}>
            <X size={11} />
          </button>
        </div>
      )}

      {/*
        Reserved region for the native webview. It renders above this element, so the
        placeholder underneath is only ever seen while the modal is being moved.
      */}
      <div ref={viewportRef} className="browser-viewport flex-1 min-h-0">
        {(interacting || covered || tabs.length === 0) && (
          <div className="browser-viewport-placeholder h-full w-full flex flex-col items-center justify-center gap-2">
            <Globe size={22} className="browser-placeholder-icon" />
            <span className="text-[11px] browser-placeholder-text">
              {tabs.length === 0 ? "No page loaded" : activeTab?.title || hostLabel(activeTab?.url ?? "")}
            </span>
          </div>
        )}
      </div>

      {/*
        The resize grip lives in its own bar; anything placed over the viewport would be
        painted over by the native webview.
      */}
      <div
        className="browser-chrome browser-statusbar flex items-center justify-between gap-2 px-3 h-7 shrink-0"
        onContextMenu={suppressContextMenu}
      >
        <span className="browser-status-text text-[10px] truncate" role="status">
          {activeTab?.loading ? "Loading…" : activeTab ? hostLabel(activeTab.url) : ""}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="browser-status-text text-[10px]">
            {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
          </span>
{/*
            Not rendered rather than hidden with a class.

            `.editor-resize-handle` sets `display: flex`, `.hidden` sets
            `display: none`, and the two have the same specificity — so which
            wins is decided by source order, and this stylesheet comes after
            Tailwind's utilities. The handle stayed visible and clickable.
            The same trap is written up in `EditorModal`, where `hidden` lost
            to `.flex` and a modal would not close.
          */}
          {!docked && (
            <div
              className="browser-resize-handle"
              onPointerDown={handleResizeStart}
              title="Resize"
              role="separator"
              aria-orientation="horizontal"
            >
              {/*
                `M9 9L9 9` used to be a third segment here. It is zero length, so
                it drew nothing — two strokes is the mark, as in every other
                window's corner.
              */}
              <svg width="10" height="10" viewBox="0 0 10 10" className="browser-resize-icon">
                <path
                  d="M9 1L1 9M9 5L5 9"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <OverlayPortal>
      <div
        className={`overlay-layer fixed inset-0 ${
          docked ? "" : "z-[250] flex items-start justify-center pt-[6vh]"
        }`}
        style={{ zIndex: docked ? BASE_SLOT_Z : (frontZ ?? undefined) }}
        /*
          A click beside a window does not close it.

          These windows hold work in progress — a request in flight, a buffer
          with unsaved edits, a conversation mid-turn — and a backdrop that
          dismisses on a stray click is how that gets lost by reaching for the
          thing behind it. They close by their own button, by Escape, or not at
          all. FigyCode never did dismiss this way; now none of them do.

          The layer still has to swallow the click rather than let it fall
          through to whatever is underneath.
        */
        onMouseDown={(e) => e.stopPropagation()}
        /*
          No `onKeyDown` swallow here either — it undid the per-chord handling
          in `handleModalKeyDown` by catching everything on the way past.
        */
        onKeyUp={(e) => e.stopPropagation()}
      >
        {modal}
      </div>
    </OverlayPortal>
  );
}

function TabIcon({ tab }: { tab: BrowserTabState }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(tab.url);

  useEffect(() => setFailed(false), [src]);

  if (tab.loading) {
    return <span className="browser-tab-spinner shrink-0" aria-hidden />;
  }
  if (!src || failed) {
    return <Globe size={11} className="browser-tab-icon shrink-0" />;
  }
  return (
    <img
      src={src}
      alt=""
      width={11}
      height={11}
      className="browser-tab-favicon shrink-0"
      onError={() => setFailed(true)}
    />
  );
}
