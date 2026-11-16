import { parseColor, type Rgb } from "./color.ts"
import type { Background } from "./model.ts"

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21]

const images = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(url: string): Promise<HTMLImageElement> {
  const known = images.get(url)
  if (known !== undefined) return known
  const loading = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.decoding = "async"
    image.onload = () => resolve(image)
    image.onerror = () => {
      images.delete(url)
      reject(new Error(`could not load ${url}`))
    }
    image.src = url
  })
  images.set(url, loading)
  return loading
}

export type Paint = { readonly ground: Rgb; readonly accent: Rgb }

/** Cover-fits `image` into a `width`×`height` canvas, then applies the effect. Runs once per change, never per frame. */
export function renderBackground(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  background: Background,
  paint: Paint,
  width: number,
  height: number,
): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = canvas.getContext("2d", { willReadFrequently: background.effect === "dither" })
  if (context === null) return
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.filter = `brightness(${background.brightness}%)${background.blur > 0 ? ` blur(${background.blur * ratio}px)` : ""}`
  context.drawImage(image, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
  context.filter = "none"
  if (background.effect === "dither") dither(context, canvas.width, canvas.height, background, paint, ratio)
  if (background.effect === "grain") grain(context, canvas.width, canvas.height, background.intensity / 100)
  if (background.effect === "vignette") vignette(context, canvas.width, canvas.height, paint.ground, background.intensity / 100)
}

/** Ordered halftone: each cell becomes a dot whose size follows its brightness, thresholded by an 8×8 Bayer matrix. */
function dither(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  background: Background,
  paint: Paint,
  ratio: number,
): void {
  const cell = Math.max(2, Math.round(background.cell * ratio))
  const columns = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const small = document.createElement("canvas")
  small.width = columns
  small.height = rows
  const sampler = small.getContext("2d", { willReadFrequently: true })
  if (sampler === null) return
  sampler.drawImage(context.canvas, 0, 0, columns, rows)
  const pixels = sampler.getImageData(0, 0, columns, rows).data
  const strength = background.intensity / 100
  context.save()
  context.globalAlpha = strength
  context.fillStyle = `rgb(${paint.ground.r} ${paint.ground.g} ${paint.ground.b})`
  context.fillRect(0, 0, width, height)
  context.restore()
  context.globalAlpha = 1
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const at = (y * columns + x) * 4
      const r = pixels[at] ?? 0
      const g = pixels[at + 1] ?? 0
      const b = pixels[at + 2] ?? 0
      const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const threshold = ((BAYER[(y % 8) * 8 + (x % 8)] ?? 0) + 0.5) / 64
      const level = Math.min(1, Math.max(0, light * 1.15 + (threshold - 0.5) * 0.5))
      const radius = cell * 0.46 * Math.sqrt(level)
      if (radius < 0.4) continue
      context.fillStyle =
        background.tone === "accent"
          ? `rgb(${paint.accent.r} ${paint.accent.g} ${paint.accent.b} / ${0.35 + light * 0.65})`
          : background.tone === "mono"
            ? `rgb(${light * 255} ${light * 255} ${light * 255})`
            : `rgb(${r} ${g} ${b})`
      context.beginPath()
      context.arc(x * cell + cell / 2, y * cell + cell / 2, radius, 0, Math.PI * 2)
      context.fill()
    }
  }
  context.globalAlpha = 1
}

function grain(context: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  const frame = context.getImageData(0, 0, width, height)
  const data = frame.data
  const amount = 48 * strength
  for (let at = 0; at < data.length; at += 4) {
    const noise = (Math.random() - 0.5) * amount
    data[at] = (data[at] ?? 0) + noise
    data[at + 1] = (data[at + 1] ?? 0) + noise
    data[at + 2] = (data[at + 2] ?? 0) + noise
  }
  context.putImageData(frame, 0, 0)
}

function vignette(context: CanvasRenderingContext2D, width: number, height: number, ground: Rgb, strength: number): void {
  const gradient = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.hypot(width, height) / 2)
  gradient.addColorStop(0, `rgb(${ground.r} ${ground.g} ${ground.b} / 0)`)
  gradient.addColorStop(1, `rgb(${ground.r} ${ground.g} ${ground.b} / ${0.9 * strength})`)
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
}

export function paintFromRoot(): Paint {
  const css = getComputedStyle(document.documentElement)
  const read = (token: string): Rgb => parseColor(css.getPropertyValue(`--color-${token}`)) ?? { r: 0, g: 0, b: 0, a: 1 }
  return { ground: read("bg"), accent: read("accent") }
}
