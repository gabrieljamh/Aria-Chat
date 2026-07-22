import { BrowserView, BrowserWindow, ipcMain } from "electron"
import { randomBytes } from "node:crypto"
import * as cdp from "./browser-cdp"
import { FIXED_VIEWPORT_ENABLED, logicalViewport } from "./browser-cdp"

const MAX_VIEWS = 5

interface SessionView {
  view: BrowserView
  sessionId: string
  url: string | null
  createdAt: number
  lastActiveAt: number
  // Page zoom factor (1 = 100%), persisted per session and re-applied after each
  // navigation. Electron folds this into the page's devicePixelRatio, so it must
  // be accounted for when mapping DOM coordinates to input coordinates.
  zoom: number
}

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.1

class BrowserManager {
  private views = new Map<string, SessionView>()
  private activeSessionId: string | null = null
  private win: BrowserWindow | null = null
  private bounds: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }

  setWindow(win: BrowserWindow) {
    this.win = win
  }

  // While true the active view collapses to a 0-rect. Native BrowserViews
  // always draw ABOVE the renderer DOM, so modals/menus would otherwise be
  // covered by the page. The renderer toggles this when overlays open/close.
  private hidden = false

  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds
    if (this.activeSessionId) {
      this.applyBounds(this.activeSessionId)
    }
  }

  setHidden(hidden: boolean) {
    if (this.hidden === hidden) return
    this.hidden = hidden
    if (this.activeSessionId) {
      this.applyBounds(this.activeSessionId)
    }
  }

  private applyBounds(sessionId: string) {
    const sv = this.views.get(sessionId)
    if (!sv || !this.win) return
    sv.view.setBounds(this.hidden ? { x: 0, y: 0, width: 0, height: 0 } : this.bounds)
  }

  create(sessionId: string, url?: string): void {
    if (this.views.has(sessionId)) {
      this.attach(sessionId)
      return
    }

    if (this.views.size >= MAX_VIEWS) {
      const oldest = [...this.views.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      if (oldest && oldest.sessionId !== this.activeSessionId) {
        this.destroy(oldest.sessionId)
      }
    }

    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: `persist:webagent-${sessionId}`,
        // Only one view is attached to the window at a time; the rest are
        // detached (removed but not destroyed) so their turns keep running in
        // the background. Electron throttles timers/rAF in unfocused/hidden
        // renderers by default, which would slow a backgrounded agent's page.
        // Disable it so background WebAgent sessions execute at full speed.
        backgroundThrottling: false,
      },
    })

    const sv: SessionView = {
      view,
      sessionId,
      url: url ?? null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      zoom: 1,
    }

    view.webContents.on("did-navigate", (_e, navUrl) => {
      sv.url = navUrl
      // A cross-process navigation can clear the emulation override — re-apply
      // the fixed viewport for the session's current zoom.
      if (FIXED_VIEWPORT_ENABLED) {
        cdp.setViewport(sv.view.webContents, sv.zoom).catch(() => {})
      }
      this.emitNavigate(sessionId, navUrl)
    })
    view.webContents.on("did-navigate-in-page", (_e, navUrl) => {
      sv.url = navUrl
      this.emitNavigate(sessionId, navUrl)
    })
    view.webContents.on("page-title-updated", (_e, title) => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("webagent:event", {
          sessionId,
          type: "title",
          title,
        })
      }
    })

    view.webContents.on("did-finish-load", () => {
      if (FIXED_VIEWPORT_ENABLED) {
        // Fixed-viewport mode folds zoom into the emulated viewport size, so
        // (re)apply the device-metrics override here instead of setZoomFactor.
        cdp.setViewport(sv.view.webContents, sv.zoom).catch(() => {})
      } else if (sv.zoom !== 1) {
        // Legacy: zoom resets across (cross-origin) navigations — re-apply the
        // session's remembered factor so it persists as the user/agent expect.
        try {
          sv.view.webContents.setZoomFactor(sv.zoom)
        } catch {}
      }
      const u = sv.url
      if (u && this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("webagent:event", {
          sessionId,
          type: "loading",
          loading: false,
          url: u,
          title: view.webContents.getTitle(),
        })
      }
    })

    view.webContents.on("did-start-loading", () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send("webagent:event", {
          sessionId,
          type: "loading",
          loading: true,
        })
      }
    })

    this.views.set(sessionId, sv)

    if (url) {
      sv.url = url
      view.webContents.loadURL(url)
    } else {
      view.webContents.loadURL("about:blank")
    }

    this.attach(sessionId)
  }

  attach(sessionId: string): void {
    if (!this.win) return

    const sv = this.views.get(sessionId)
    if (!sv) {
      this.create(sessionId)
      return
    }

    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      const prev = this.views.get(this.activeSessionId)
      if (prev) {
        try {
          this.win.removeBrowserView(prev.view)
        } catch {}
      }
    }

    this.win.setBrowserView(sv.view)
    this.applyBounds(sessionId)
    sv.lastActiveAt = Date.now()
    this.activeSessionId = sessionId
  }

  detach(sessionId: string): void {
    if (!this.win) return
    const sv = this.views.get(sessionId)
    if (!sv) return

    try {
      sv.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      this.win.removeBrowserView(sv.view)
    } catch {}

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
  }

  destroy(sessionId: string): void {
    const sv = this.views.get(sessionId)
    if (!sv) return

    if (this.win) {
      try {
        this.win.removeBrowserView(sv.view)
      } catch {}
    }

    if (FIXED_VIEWPORT_ENABLED) cdp.release(sv.view.webContents)
    ;(sv.view.webContents as any).destroy()
    this.views.delete(sessionId)

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
  }

  getTarget(sessionId: string): BrowserView | null {
    const sv = this.views.get(sessionId)
    return sv ? sv.view : null
  }

  getActive(): SessionView | null {
    return this.activeSessionId ? this.views.get(this.activeSessionId) ?? null : null
  }

  getUrl(sessionId: string): string | null {
    return this.views.get(sessionId)?.url ?? null
  }

  private emitNavigate(sessionId: string, url: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("webagent:event", {
        sessionId,
        type: "navigate",
        url,
        title: this.views.get(sessionId)?.view.webContents.getTitle() ?? "",
        loading: false,
      })
    }
  }

  getTitle(sessionId: string): string {
    const sv = this.views.get(sessionId)
    return sv ? sv.view.webContents.getTitle() : ""
  }

  isLoading(sessionId: string): boolean {
    const sv = this.views.get(sessionId)
    return sv ? sv.view.webContents.isLoading() : false
  }

  navigate(sessionId: string, url: string): void {
    const sv = this.views.get(sessionId)
    if (!sv) {
      this.create(sessionId, url)
      return
    }
    sv.url = url
    sv.view.webContents.loadURL(url)
  }

  destroyAll(): void {
    for (const sessionId of [...this.views.keys()]) {
      this.destroy(sessionId)
    }
  }

  sendClick(view: BrowserView, x: number, y: number, button: string = "left"): void {
    if (FIXED_VIEWPORT_ENABLED) {
      // Emulated-space click via CDP (coordinates line up 1:1 with
      // getBoundingClientRect and the CDP screenshot). Fire-and-forget to keep
      // the synchronous signature callers rely on.
      void cdp.click(view.webContents, x, y, (button as any) === "right" || (button as any) === "middle" ? button : "left")
      return
    }
    view.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: button as any,
      clickCount: 1,
    } as any)
    view.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: button as any,
      clickCount: 1,
    } as any)
  }

  async sendType(view: BrowserView, text: string, clear: boolean = false): Promise<void> {
    if (clear) {
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" } as any)
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "End", modifiers: ["shift"] } as any)
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Delete" } as any)
      await new Promise((r) => setTimeout(r, 60))
    }
    for (const ch of text) {
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: ch } as any)
      view.webContents.sendInputEvent({ type: "char", keyCode: ch } as any)
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: ch } as any)
      await new Promise((r) => setTimeout(r, 40))
    }
  }

  sendKeystrokes(view: BrowserView, keys: string): void {
    const parts = keys.split("+")
    const modifiers = parts.slice(0, -1).map((m) => m.trim().toLowerCase())
    const key = parts[parts.length - 1].trim()
    view.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: key,
      modifiers: modifiers as any,
    } as any)
    view.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: key,
      modifiers: modifiers as any,
    } as any)
  }

  // Hold a key (optionally with modifiers, "shift+ArrowRight") pressed down for
  // durationMs, then release — for games and any UI that reacts to sustained
  // key presses. keyDown is repeated on an interval because a browser only sees
  // a single keydown otherwise (no OS auto-repeat via sendInputEvent).
  async sendHoldKey(view: BrowserView, keys: string, durationMs: number): Promise<void> {
    const parts = keys.split("+")
    const modifiers = parts.slice(0, -1).map((m) => m.trim().toLowerCase())
    const key = parts[parts.length - 1].trim()
    const evt = (type: "keyDown" | "keyUp") =>
      view.webContents.sendInputEvent({ type, keyCode: key, modifiers: modifiers as any } as any)
    const dur = Math.max(0, Math.min(30_000, durationMs))
    evt("keyDown")
    const start = Date.now()
    // Emulate auto-repeat (~30ms) so key-held game loops keep advancing.
    while (Date.now() - start < dur) {
      await new Promise((r) => setTimeout(r, 30))
      if (Date.now() - start >= dur) break
      evt("keyDown")
    }
    evt("keyUp")
  }

  // Draw/trace a continuous path: press at the first point, glide the mouse
  // through every point (interpolating between them so the stroke is smooth),
  // then release. One uninterrupted gesture — needed for things like drawing a
  // clean circle in a single motion, which chained drags can't do. Coordinates
  // are in viewport/DIP space (same as screenshot coordinates).
  async sendDraw(view: BrowserView, points: Array<{ x: number; y: number }>, duration: number): Promise<void> {
    if (points.length < 2) return
    const total = Math.max(0, Math.min(20_000, duration))
    if (FIXED_VIEWPORT_ENABLED) {
      await cdp.dragPath(view.webContents, points, total)
      return
    }
    const wc = view.webContents
    const first = points[0]
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(first.x), y: Math.round(first.y), button: "left", clickCount: 1 } as any)
    // Interpolate each segment so fast pointer-move handlers (canvas drawing)
    // receive a dense, smooth stream rather than a few teleporting points.
    const perSegment = Math.max(1, Math.floor((total / Math.max(1, points.length - 1)) / 16))
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      for (let s = 1; s <= perSegment; s++) {
        const t = s / perSegment
        const x = Math.round(a.x + (b.x - a.x) * t)
        const y = Math.round(a.y + (b.y - a.y) * t)
        wc.sendInputEvent({ type: "mouseMove", x, y, button: "left" } as any)
        if (total > 0) await new Promise((r) => setTimeout(r, total / points.length / perSegment))
      }
    }
    const last = points[points.length - 1]
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(last.x), y: Math.round(last.y), button: "left", clickCount: 1 } as any)
  }

  // Set the page zoom for a session. Accepts an absolute factor OR a relative
  // direction ("in"/"out"/"reset"). Clamped, remembered on the SessionView, and
  // re-applied after navigations. Returns the resulting factor.
  setZoom(sessionId: string, opts: { factor?: number; direction?: "in" | "out" | "reset" }): number {
    const sv = this.views.get(sessionId)
    if (!sv) return 1
    let z = sv.zoom
    if (opts.direction === "reset") z = 1
    else if (opts.direction === "in") z = sv.zoom + ZOOM_STEP
    else if (opts.direction === "out") z = sv.zoom - ZOOM_STEP
    else if (typeof opts.factor === "number") z = opts.factor
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
    sv.zoom = z
    if (FIXED_VIEWPORT_ENABLED) {
      // Zoom is the emulated viewport size (base / zoom), not a page zoom factor —
      // re-issue the device-metrics override so coordinates, capture, and layout
      // all move together in one space.
      cdp.setViewport(sv.view.webContents, z).catch(() => {})
    } else {
      try {
        sv.view.webContents.setZoomFactor(z)
      } catch {}
    }
    // Notify the renderer so the toolbar reflects agent-driven zoom too.
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("webagent:event", { sessionId, type: "zoom", zoom: z })
    }
    return z
  }

  getZoom(sessionId: string): number {
    return this.views.get(sessionId)?.zoom ?? 1
  }

  // Current logical viewport size for a session. In fixed-viewport mode this is
  // BASE / zoom (the emulated CSS space that clicks & screenshots share); in
  // legacy mode there is no fixed size so this returns null.
  getViewportSize(sessionId: string): { width: number; height: number } | null {
    if (!FIXED_VIEWPORT_ENABLED) return null
    const sv = this.views.get(sessionId)
    if (!sv) return null
    return logicalViewport(sv.zoom)
  }

  // Scroll the page by an exact pixel delta. Electron's synthetic `mouseWheel`
  // input events are unreliable: a single event scrolls little or nothing, the
  // delta doesn't map 1:1 to pixels, and it dispatches at a fixed point that may
  // sit over a non-scrollable fixed header/sidebar. Instead we scroll in-page —
  // find the scrollable element under the viewport center and scroll it by the
  // requested pixels, falling back to the document scroller. This is
  // deterministic and also handles apps that scroll an inner container rather
  // than the window. Returns whether anything actually moved.
  async sendScroll(view: BrowserView, dx: number, dy: number): Promise<{ ok: boolean; scrolled: boolean }> {
    const script = `
      (function (dx, dy) {
        function scrollableInDir(el, dx, dy) {
          if (!(el instanceof Element)) return false;
          var s = getComputedStyle(el);
          var canY = (s.overflowY === 'auto' || s.overflowY === 'scroll');
          var canX = (s.overflowX === 'auto' || s.overflowX === 'scroll');
          if (dy > 0 && canY && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
          if (dy < 0 && canY && el.scrollTop > 0) return true;
          if (dx > 0 && canX && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
          if (dx < 0 && canX && el.scrollLeft > 0) return true;
          return false;
        }
        var cx = Math.floor(window.innerWidth / 2);
        var cy = Math.floor(window.innerHeight / 2);
        var el = document.elementFromPoint(cx, cy);
        var target = null;
        while (el) { if (scrollableInDir(el, dx, dy)) { target = el; break; } el = el.parentElement; }
        var doc = document.scrollingElement || document.documentElement;
        var scroller = target || doc;
        var beforeTop = scroller.scrollTop, beforeLeft = scroller.scrollLeft;
        scroller.scrollBy(dx, dy);
        var moved = (scroller.scrollTop !== beforeTop) || (scroller.scrollLeft !== beforeLeft);
        if (!moved && scroller !== doc && doc) {
          var bt = doc.scrollTop, bl = doc.scrollLeft;
          doc.scrollBy(dx, dy);
          moved = (doc.scrollTop !== bt) || (doc.scrollLeft !== bl);
        }
        return { moved: moved, scrollY: window.scrollY, maxY: doc ? (doc.scrollHeight - doc.clientHeight) : 0 };
      })(${Number(dx) || 0}, ${Number(dy) || 0});
    `
    try {
      const r = await view.webContents.executeJavaScript(script, true)
      return { ok: true, scrolled: Boolean(r && (r as any).moved) }
    } catch {
      return { ok: false, scrolled: false }
    }
  }

  async sendDrag(view: BrowserView, fromX: number, fromY: number, toX: number, toY: number, duration: number): Promise<void> {
    if (FIXED_VIEWPORT_ENABLED) {
      const steps = Math.max(10, Math.ceil(duration / 16))
      const path = [{ x: fromX, y: fromY }]
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        path.push({ x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t })
      }
      await cdp.dragPath(view.webContents, path, duration)
      return
    }
    view.webContents.sendInputEvent({ type: "mouseDown", x: fromX, y: fromY, button: "left", clickCount: 1 } as any)
    const steps = Math.max(10, Math.ceil(duration / 16))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const x = Math.round(fromX + (toX - fromX) * t)
      const y = Math.round(fromY + (toY - fromY) * t)
      view.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left" } as any)
      await new Promise((r) => setTimeout(r, duration / steps))
    }
    view.webContents.sendInputEvent({ type: "mouseUp", x: toX, y: toY, button: "left", clickCount: 1 } as any)
  }
}

export const browserManager = new BrowserManager()
