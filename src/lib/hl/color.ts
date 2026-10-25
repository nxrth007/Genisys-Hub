/**
 * Colours for client branding: reading what a website's stylesheet says
 * (oklch, hsl, rgb or hex, as Tailwind and shadcn write them) as a hex, and
 * picking text that stays readable on it. No imports: the chat panel (a
 * client component) and the server both use it.
 */

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))
const hex2 = (n: number) => Math.round(clamp(n) * 255).toString(16).padStart(2, '0')
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase()
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)

/** OKLCH (L 0–1, chroma, hue in degrees) to sRGB hex. */
export function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3)
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  return toHex(gamma(r), gamma(g), gamma(bl))
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return toHex(f(0), f(8), f(4))
}

const pct = (v: string) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v))

/** A CSS colour as a hex: oklch(78% .13 80), hsl(…), a shadcn triplet "222 47% 11%", rgb(…) or #hex. Null when it isn't one. */
export function parseCssColor(raw: string): string | null {
  const v = raw.trim().replace(/\s*!important$/, '').toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (hex) return `#${hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1]}`.toUpperCase()
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/.exec(v)
  if (ok) return oklchToHex(pct(ok[1]), parseFloat(ok[2]), parseFloat(ok[3]))
  const hsl = /^(?:hsla?\(\s*)?([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,][^)]*)?\)?$/.exec(v)
  if (hsl) return hslToHex(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100)
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,][^)]*)?\)$/.exec(v)
  if (rgb) return toHex(+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255)
  return null
}

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Text that reads on this colour: white wherever it's clear enough (contrast 3:1 or better), else near-black (gold, amber, pale colours). */
export function onColor(hex: string): '#FFFFFF' | '#101828' {
  const l = luminance(hex)
  const white = 1.05 / (l + 0.05)
  const dark = (l + 0.05) / 0.0603
  return white >= 3 || white >= dark ? '#FFFFFF' : '#101828'
}

/** Lighter (amount > 0) or darker (< 0), towards white or black. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = rgbOf(hex)
  const t = amount < 0 ? 0 : 1
  const p = Math.abs(amount)
  return toHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p)
}

/** Text on a brand colour: white, or a deep shade of the colour itself where white wouldn't read (gold, amber, pale colours). */
export const inkOn = (hex: string) => (onColor(hex) === '#FFFFFF' ? '#FFFFFF' : shade(hex, -0.78))

/** Saturation and lightness, to tell a brand colour from a grey or near-black one. */
export function isBrandish(hex: string): boolean {
  const [r, g, b] = rgbOf(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  return s >= 0.25 && l >= 0.2 && l <= 0.85
}
