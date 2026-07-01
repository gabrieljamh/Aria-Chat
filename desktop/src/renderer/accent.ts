const BASE_H = 258
const BASE_S = 90
const BASE_L = 66

export function applyAccentHue(offset: number) {
  const h = ((BASE_H + offset) % 360 + 360) % 360
  const root = document.documentElement.style
  root.setProperty("--accent", `hsl(${h}, ${BASE_S}%, ${BASE_L}%)`)
  root.setProperty("--accent-hover", `hsl(${h}, ${BASE_S}%, ${Math.min(BASE_L + 7, 100)}%)`)
  root.setProperty("--accent-soft", `hsla(${h}, ${BASE_S}%, ${BASE_L}%, 0.14)`)
}

/** HSL → hex for the color preview swatch. */
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
