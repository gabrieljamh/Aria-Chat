import { BrowserView, BrowserWindow, ipcMain } from "electron"
import { randomBytes } from "node:crypto"

const MAX_VIEWS = 5

interface SessionView {
  view: BrowserView
  sessionId: string
  url: string | null
  createdAt: number
  lastActiveAt: number
}

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
      },
    })

    const sv: SessionView = {
      view,
      sessionId,
      url: url ?? null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }

    view.webContents.on("did-navigate", (_e, navUrl) => {
      sv.url = navUrl
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

  sendScroll(view: BrowserView, dx: number, dy: number): void {
    view.webContents.sendInputEvent({
      type: "mouseWheel",
      x: 0,
      y: 0,
      deltaX: dx,
      deltaY: dy,
    } as any)
  }

  async sendDrag(view: BrowserView, fromX: number, fromY: number, toX: number, toY: number, duration: number): Promise<void> {
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
