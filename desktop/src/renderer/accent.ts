const BASE_H = 258
const BASE_S = 90
const BASE_L = 66

export function applyAccentHue(offset: number, darkText?: boolean) {
  const h = ((BASE_H + offset) % 360 + 360) % 360
  const root = document.documentElement.style
  root.setProperty("--accent", `hsl(${h}, ${BASE_S}%, ${BASE_L}%)`)
  root.setProperty("--accent-hover", `hsl(${h}, ${BASE_S}%, ${Math.min(BASE_L + 7, 100)}%)`)
  root.setProperty("--accent-soft", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0.14)`)
  root.setProperty("--accent-border", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0.35)`)
  root.setProperty("--accent-glow", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0.45)`)
  root.setProperty("--accent-glow-end", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0)`)
  root.setProperty("--accent-soft-bg", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0.06)`)
  const useDark = darkText !== undefined ? darkText : accentNeedsDarkText(offset)
  root.setProperty("--accent-text", useDark ? "#1a1a1a" : "#ffffff")
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
