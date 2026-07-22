import type { WebContents } from "electron"

/**
 * Fixed-viewport / CDP-unified coordinate model for WebAgent.
 *
 * PROBLEM THIS SOLVES
 * -------------------
 * By default a session's page lays out at the size of the visible panel (the
 * native BrowserView's bounds). So the page renders squished on a small panel,
 * reflows (and every element coordinate shifts) when the window is resized or
 * maximized, and forces the agent to scroll more because less fits. The agent's
 * screenshot resolution is literally the panel size.
 *
 * FIX
 * ---
 * Pin the page's LAYOUT VIEWPORT to a fixed logical size (1280x800) via the
 * DevTools Protocol's Emulation.setDeviceMetricsOverride — independent of the
 * actual panel/window size. window.innerWidth, media queries, and
 * getBoundingClientRect all resolve against that fixed size; Chrome scales the
 * paint to whatever surface displays it.
 *
 * WHY CDP FOR CAPTURE + MOUSE (not just the override)
 * ---------------------------------------------------
 * Once a device-metrics override is active, two coordinate spaces exist:
 *   - EMULATED space (1280x800 CSS px): what getBoundingClientRect returns.
 *   - SURFACE space (panel device px): what Electron's capturePage captures and
 *     what webContents.sendInputEvent dispatches into.
 * Mixing them makes clicks miss and screenshots not line up with coordinates.
 * So in fixed-viewport mode we take BOTH the screenshot (Page.captureScreenshot)
 * and mouse input (Input.dispatchMouseEvent) through CDP, which operate in the
 * SAME emulated CSS space as getBoundingClientRect. Everything is 1:1.
 *
 * Keyboard input and in-page scrolling are coordinate-INDEPENDENT (keys go to the
 * focused element; scroll is done via injected JS on page-relative deltas), so
 * those intentionally stay on the existing path — no need to move them to CDP.
 *
 * OPT-IN: default OFF. Enable with MIMOCODE_WEBAGENT_FIXED_VIEWPORT=1. The legacy
 * (panel-sized viewport, sendInputEvent, capturePage) path is fully preserved.
 */
export const FIXED_VIEWPORT_ENABLED = process.env.MIMOCODE_WEBAGENT_FIXED_VIEWPORT === "1"

// Base logical viewport. Zoom shrinks/grows this (see logicalViewport()).
export const BASE_VIEWPORT = { width: 1280, height: 800 } as const

// Device-scale-factor 1 keeps screenshot pixels 1:1 with CSS coordinates, which
// removes the dpr/displayScale normalization the legacy screenshot path needs.
const DEVICE_SCALE_FACTOR = 1

const CDP_VERSION = "1.3"

// Track which webContents we've attached, so attach is idempotent and release
// only detaches what we own.
const attached = new WeakSet<WebContents>()

function isAlive(wc: WebContents): boolean {
  return !!wc && !wc.isDestroyed()
}

/**
 * Compute the logical viewport for a given zoom. Zoom is folded into the emulated
 * viewport SIZE (not a separate scale factor), so a single coordinate space holds
 * at every zoom: zoom-in shrinks the logical viewport, making content larger
 * relative to the fixed base, and getBoundingClientRect / mouse / capture all read
 * that same shrunk space. Reflows like a window resize (acceptable for the
 * "magnify to target a tiny control" use case).
 */
export function logicalViewport(zoom: number): { width: number; height: number } {
  const z = zoom > 0 ? zoom : 1
  return {
    width: Math.max(1, Math.round(BASE_VIEWPORT.width / z)),
    height: Math.max(1, Math.round(BASE_VIEWPORT.height / z)),
  }
}

/** Attach the debugger once. Safe to call repeatedly. */
export function ensureAttached(wc: WebContents): boolean {
  if (!isAlive(wc)) return false
  if (attached.has(wc)) return true
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach(CDP_VERSION)
    attached.add(wc)
    return true
  } catch (e) {
    // Most common cause: DevTools already owns the debugger for this webContents.
    // Fixed-viewport mode can't work without the CDP session, so surface it.
    console.error("[webagent-cdp] debugger.attach failed:", e)
    return false
  }
}

export function release(wc: WebContents): void {
  if (!isAlive(wc)) return
  if (!attached.has(wc)) return
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach()
  } catch {}
  attached.delete(wc)
}

async function send<T = any>(wc: WebContents, method: string, params?: Record<string, unknown>): Promise<T> {
  return wc.debugger.sendCommand(method, params ?? {}) as Promise<T>
}

/**
 * Apply the fixed layout viewport for the given zoom. Re-apply after navigations —
 * a cross-process navigation can clear the emulation override.
 */
export async function setViewport(wc: WebContents, zoom: number): Promise<void> {
  if (!ensureAttached(wc)) return
  const { width, height } = logicalViewport(zoom)
  await send(wc, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    mobile: false,
  }).catch((e) => console.error("[webagent-cdp] setDeviceMetricsOverride failed:", e))
}

/**
 * Capture the emulated viewport. Returns a PNG data URL at exactly the logical
 * viewport size (dsf 1), so pixels map 1:1 to click/drag coordinates — no dpr
 * normalization needed.
 */
export async function capture(
  wc: WebContents,
  zoom: number,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (!ensureAttached(wc)) return null
  try {
    const res = await send<{ data: string }>(wc, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })
    const { width, height } = logicalViewport(zoom)
    return { dataUrl: `data:image/png;base64,${res.data}`, width, height }
  } catch (e) {
    console.error("[webagent-cdp] captureScreenshot failed:", e)
    return null
  }
}

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

function mods(modifiers?: string[]): number {
  // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
  let m = 0
  for (const mod of modifiers ?? []) {
    const k = mod.toLowerCase()
    if (k === "alt") m |= 1
    else if (k === "control" || k === "ctrl") m |= 2
    else if (k === "meta" || k === "command" || k === "cmd") m |= 4
    else if (k === "shift") m |= 8
  }
  return m
}

/** Dispatch a single mouse event in EMULATED CSS coordinates. */
export async function mouse(
  wc: WebContents,
  opts: {
    type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"
    x: number
    y: number
    button?: "left" | "right" | "middle" | "none"
    buttons?: number
    clickCount?: number
    deltaX?: number
    deltaY?: number
    modifiers?: string[]
  },
): Promise<void> {
  if (!ensureAttached(wc)) return
  await send(wc, "Input.dispatchMouseEvent", {
    type: opts.type,
    x: Math.round(opts.x),
    y: Math.round(opts.y),
    button: opts.button ?? "none",
    buttons: opts.buttons ?? 0,
    clickCount: opts.clickCount ?? 0,
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
    modifiers: mods(opts.modifiers),
  }).catch((e) => console.error("[webagent-cdp] dispatchMouseEvent failed:", e))
}

/** Press + release at a point (a click). */
export async function click(
  wc: WebContents,
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
): Promise<void> {
  const mask = BUTTON_MASK[button] ?? 1
  await mouse(wc, { type: "mousePressed", x, y, button, buttons: mask, clickCount: 1 })
  await mouse(wc, { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 })
}

/** Press → interpolated moves → release, in emulated CSS coordinates. */
export async function dragPath(
  wc: WebContents,
  points: Array<{ x: number; y: number }>,
  totalMs: number,
): Promise<void> {
  if (points.length < 2) return
  const first = points[0]
  await mouse(wc, { type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1 })
  const perSegment = Math.max(1, Math.floor(totalMs / Math.max(1, points.length - 1) / 16))
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    for (let s = 1; s <= perSegment; s++) {
      const t = s / perSegment
      await mouse(wc, {
        type: "mouseMoved",
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        button: "left",
        buttons: 1,
      })
      if (totalMs > 0) await new Promise((r) => setTimeout(r, totalMs / points.length / perSegment))
    }
  }
  const last = points[points.length - 1]
  await mouse(wc, { type: "mouseReleased", x: last.x, y: last.y, button: "left", buttons: 0, clickCount: 1 })
}
