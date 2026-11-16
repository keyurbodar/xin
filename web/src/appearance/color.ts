export type Rgb = { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/iu

const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu

export function isHex(value: string): boolean {
  return OPAQUE_HEX.test(value.trim())
}

export function parseColor(value: string): Rgb | undefined {
  const text = value.trim()
  const hex = HEX.exec(text)
  if (hex !== null) {
    const raw = hex[1] ?? ""
    const full = raw.length === 3 ? [...raw].map((digit) => digit + digit).join("") : raw
    const at = (index: number): number => Number.parseInt(full.slice(index, index + 2), 16)
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 }
  }
  const rgb = RGB.exec(text)
  if (rgb === null) return undefined
  const alpha = rgb[4]
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: alpha === undefined ? 1 : alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha),
  }
}

const channel = (value: number): string =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0")

export function toHex(color: Rgb): string {
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
  return color.a >= 1 ? base : `${base}${channel(color.a * 255)}`
}

/** `amount` of `top` over `base`, in sRGB: what a translucent layer shows over an opaque one. */
export function mix(base: Rgb, top: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount))
  return {
    r: base.r + (top.r - base.r) * t,
    g: base.g + (top.g - base.g) * t,
    b: base.b + (top.b - base.b) * t,
    a: 1,
  }
}

export function over(base: Rgb, top: Rgb): Rgb {
  return mix(base, { ...top, a: 1 }, top.a)
}

const linear = (value: number): number => {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

export function luminance(color: Rgb): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/** Moves `ink` toward white or black until it reaches `target` against `ground`, keeping its hue as long as it can. */
export function ensureContrast(ink: Rgb, ground: Rgb, target: number): Rgb {
  if (contrast(ink, ground) >= target) return ink
  const pole: Rgb = luminance(ground) > 0.18 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
  for (let step = 1; step <= 20; step += 1) {
    const next = mix(ink, pole, step / 20)
    if (contrast(next, ground) >= target) return next
  }
  return pole
}

export function readableOn(ground: Rgb): Rgb {
  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 }
  const black: Rgb = { r: 10, g: 10, b: 11, a: 1 }
  return contrast(white, ground) >= contrast(black, ground) ? white : black
}
