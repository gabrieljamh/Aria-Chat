const BASE_H = 258
const BASE_S = 90
const BASE_L = 66

let lastDarkText: boolean | undefined

/* --------------------------- RGB cycle (easter egg) ---------------------- */
// Single owner for the hue animation. Previously App.tsx and SettingsModal
// each ran their own loop; the modal couldn't stop App's, so triple-clicking
// the swatch off only took effect after the modal closed.

// State lives on globalThis, NOT in module scope: with Vite HMR every module
// reload creates a fresh instance — a module-scoped raf id would be lost and
// the old loop kept running, stacking orphaned loops (each doing full style
// recalcs) until the app got progressively laggier over a dev session.
const RGB_STATE_KEY = "__aria_rgb_cycle__"
type RgbState = { raf: number; hue: number; dark: boolean | undefined }
function rgbState(): RgbState {
  const g = globalThis as Record<string, unknown>
  if (!g[RGB_STATE_KEY]) g[RGB_STATE_KEY] = { raf: 0, hue: 0, dark: undefined } satisfies RgbState
  return g[RGB_STATE_KEY] as RgbState
}

// ~80°/s: a full rainbow every ~4.5s (the old 30°/s felt sluggish).
const RGB_SPEED = 0.08
// 15fps repaint cap: at this speed that's ~5.3° per step — smooth enough for
// a color drift while quartering the style-recalc load vs 60fps.
const RGB_FRAME_MS = 66

export function isRgbCycling(): boolean {
  return rgbState().raf !== 0
}

export function startRgbCycle(initialHue: number, dark?: boolean) {
  const s = rgbState()
  s.hue = initialHue
  s.dark = dark
  if (s.raf) return // already running — just updated hue/dark above
  let last = performance.now()
  let lastPaint = 0
  let lastSave = 0
  const tick = (now: number) => {
    const dt = now - last
    last = now
    s.hue = (s.hue + dt * RGB_SPEED) % 360
    // Repaint cap: every --accent-hue change re-styles all accent-colored
    // elements; with content-visibility on messages only visible ones pay.
    if (now - lastPaint >= RGB_FRAME_MS) {
      lastPaint = now
      applyAccentHue(s.hue, s.dark)
    }
    // Persist rarely — only so a restart resumes near the same color.
    if (now - lastSave > 5_000) {
      lastSave = now
      window.mimo.setSetting("accentHue", s.hue).catch(() => {})
    }
    s.raf = requestAnimationFrame(tick)
  }
  s.raf = requestAnimationFrame(tick)
}

/** Stops the cycle immediately and returns the hue it stopped at. */
export function stopRgbCycle(): number {
  const s = rgbState()
  if (s.raf) {
    cancelAnimationFrame(s.raf)
    s.raf = 0
  }
  return s.hue
}

export function applyAccentHue(offset: number, darkText?: boolean) {
  const h = ((BASE_H + offset) % 360 + 360) % 360
  const root = document.documentElement.style
  root.setProperty("--accent-hue", String(h))
  const useDark = darkText !== undefined ? darkText : accentNeedsDarkText(offset)
  if (useDark !== lastDarkText) {
    lastDarkText = useDark
    root.setProperty("--accent-text", useDark ? "#1a1a1a" : "#ffffff")
  }
}

/** Auto-detect: return true when accent bg is light enough that dark text is needed. */
export function accentNeedsDarkText(offset: number): boolean {
  const h = ((BASE_H + offset) % 360 + 360) % 360
  return relativeLuminance(h, BASE_S, BASE_L) > 0.45
}

function relativeLuminance(h: number, s: number, l: number): number {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const toLinear = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    const v = Math.max(0, Math.min(1, c))
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const r = toLinear(0), g = toLinear(8), b = toLinear(4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function accentHex(offset: number): string {
  const h = ((BASE_H + offset) % 360 + 360) % 360
  return hslToHex(h, BASE_S, BASE_L)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * c).toString(16).padStart(2, "0")
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
