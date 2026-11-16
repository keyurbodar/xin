// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { parseColor } from "./node.ts"
import {
  type Align,
  type Color,
  parseAlign,
  parseTextSize,
  parseWeight,
  type TextSize,
  tokenColor,
  VisualError,
  type Weight,
  weightFromNumber,
} from "./style.ts"
import { isTable, type LuaTable, type LuaValue, typeName, valueText } from "./value.ts"

export const MAX_COMMANDS = 40_000
const MAX_POINTS = 200_000

export type Point = readonly [number, number]

export type DrawText = {
  readonly x: number
  readonly y: number
  readonly text: string
  readonly size: TextSize
  readonly weight: Weight
  readonly color: Color
  readonly mono: boolean
  readonly align: Align
  readonly baseline: Align
}

export type DrawCmd =
  | {
      readonly kind: "stroke"
      readonly points: readonly Point[]
      readonly closed: boolean
      readonly color: Color
      readonly width: number
      readonly dash?: number
    }
  | { readonly kind: "fill"; readonly points: readonly Point[]; readonly color: Color }
  | ({ readonly kind: "text" } & DrawText)

export type Pointer = { readonly x: number; readonly y: number; readonly down: boolean }

type Paint = { fill?: Color; stroke?: Color; width: number; dash?: number }

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const withAlpha = (color: Color, alpha: number): Color => ({ ...color, alpha: color.alpha * clamp(alpha, 0, 1) })

function paintOf(options: LuaTable | undefined, defaultFill: boolean): Paint {
  const paint: Paint = { width: 1 }
  const text = tokenColor("text")
  if (options === undefined) return defaultFill ? { ...paint, fill: text } : { ...paint, stroke: text }
  const base = parseColor(options.keys.get("color"))
  const fill = parseColor(options.keys.get("fill"))
  const stroke = parseColor(options.keys.get("stroke"))
  if (fill !== undefined) paint.fill = fill
  if (stroke !== undefined) paint.stroke = stroke
  if (base !== undefined) {
    if (defaultFill && paint.fill === undefined) paint.fill = base
    else if (paint.stroke === undefined) paint.stroke = base
  }
  if (paint.fill === undefined && paint.stroke === undefined) {
    if (defaultFill) paint.fill = text
    else paint.stroke = text
  }
  const alpha = options.keys.get("alpha")
  if (typeof alpha === "number") {
    if (paint.fill !== undefined) paint.fill = withAlpha(paint.fill, alpha)
    if (paint.stroke !== undefined) paint.stroke = withAlpha(paint.stroke, alpha)
  }
  const width = options.keys.get("width")
  paint.width = clamp(typeof width === "number" ? width : 1, 0.25, 32)
  const dash = options.keys.get("dash")
  if (typeof dash === "number") paint.dash = clamp(dash, 1, 64)
  return paint
}

function pointsOf(value: LuaValue): Point[] {
  if (!isTable(value)) throw new VisualError(`points must be a table, not a ${typeName(value)}`)
  const out: Point[] = []
  if (isTable(value.seq[0])) {
    for (const pair of value.seq) {
      if (!isTable(pair)) throw new VisualError("points mix pairs and numbers")
      const [x, y] = pair.seq
      if (typeof x !== "number" || typeof y !== "number") throw new VisualError("a point pair is { x, y } numbers")
      out.push([x, y])
    }
  } else {
    for (let index = 0; index + 1 < value.seq.length; index += 2) {
      const x = value.seq[index]
      const y = value.seq[index + 1]
      if (typeof x !== "number" || typeof y !== "number")
        throw new VisualError("points are numbers { x1, y1, x2, y2, ... }")
      out.push([x, y])
    }
  }
  if (out.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
    throw new VisualError("a point is NaN or infinite")
  return out
}

export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
  const sweep = a1 - a0
  const segments = Math.trunc(clamp(Math.sqrt(Math.abs(sweep) * Math.max(r, 1)) * 2.5, 6, 160))
  const out: Point[] = []
  for (let i = 0; i <= segments; i += 1) {
    const a = a0 + (sweep * i) / segments
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return out
}

export function rectPoints(x0: number, y0: number, w0: number, h0: number, radius: number): Point[] {
  const [x, w] = w0 < 0 ? [x0 + w0, -w0] : [x0, w0]
  const [y, h] = h0 < 0 ? [y0 + h0, -h0] : [y0, h0]
  const r = clamp(radius, 0, Math.min(w, h) / 2)
  if (r < 0.25)
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]
  const quarter = Math.PI / 2
  return [
    ...arcPoints(x + w - r, y + r, r, -quarter, 0),
    ...arcPoints(x + w - r, y + h - r, r, 0, quarter),
    ...arcPoints(x + r, y + h - r, r, quarter, Math.PI),
    ...arcPoints(x + r, y + r, r, Math.PI, Math.PI + quarter),
  ]
}

const num = (value: LuaValue, what: string): number => {
  if (typeof value !== "number") throw new VisualError(`${what} must be a number, not a ${typeName(value)}`)
  return value
}

const options = (value: LuaValue): LuaTable | undefined => {
  if (value === undefined) return undefined
  if (!isTable(value)) throw new VisualError(`options must be a table, not a ${typeName(value)}`)
  return value
}

export const GRAPHICS_METHODS = ["line", "polyline", "polygon", "rect", "circle", "arc", "text"] as const

/** One run of a canvas's draw function: `g:` methods record vector commands in pixels, origin top-left. */
export class Graphics {
  readonly commands: DrawCmd[] = []
  readPointer = false
  private points = 0

  constructor(
    readonly width: number,
    readonly height: number,
    readonly time: number,
    readonly pointer: Pointer | undefined,
  ) {}

  private push(command: DrawCmd): void {
    if (this.commands.length >= MAX_COMMANDS)
      throw new VisualError(`a canvas draws at most ${MAX_COMMANDS} shapes per frame`)
    this.points += command.kind === "text" ? 1 : command.points.length
    if (this.points > MAX_POINTS) throw new VisualError(`a canvas draws at most ${MAX_POINTS} points per frame`)
    this.commands.push(command)
  }

  private shape(points: Point[], paint: Paint): void {
    if (paint.fill !== undefined) this.push({ kind: "fill", points, color: paint.fill })
    if (paint.stroke !== undefined)
      this.push({
        kind: "stroke",
        points,
        closed: true,
        color: paint.stroke,
        width: paint.width,
        ...(paint.dash === undefined ? {} : { dash: paint.dash }),
      })
  }

  private stroke(points: Point[], paint: Paint): void {
    const strokeColor = paint.stroke ?? paint.fill ?? tokenColor("text")
    this.push({
      kind: "stroke",
      points,
      closed: false,
      color: strokeColor,
      width: paint.width,
      ...(paint.dash === undefined ? {} : { dash: paint.dash }),
    })
  }

  call(method: (typeof GRAPHICS_METHODS)[number], args: readonly LuaValue[]): void {
    switch (method) {
      case "line":
        this.stroke(
          [
            [num(args[0], "x1"), num(args[1], "y1")],
            [num(args[2], "x2"), num(args[3], "y2")],
          ],
          paintOf(options(args[4]), false),
        )
        return
      case "polyline": {
        const points = pointsOf(args[0])
        const paint = paintOf(options(args[1]), false)
        if (points.length >= 2) this.stroke(points, paint)
        return
      }
      case "polygon": {
        const points = pointsOf(args[0])
        const paint = paintOf(options(args[1]), true)
        if (points.length >= 3) this.shape(points, paint)
        return
      }
      case "rect": {
        const opts = options(args[4])
        const radius = opts?.keys.get("radius")
        this.shape(
          rectPoints(
            num(args[0], "x"),
            num(args[1], "y"),
            num(args[2], "w"),
            num(args[3], "h"),
            typeof radius === "number" ? radius : 0,
          ),
          paintOf(opts, true),
        )
        return
      }
      case "circle": {
        const points = arcPoints(num(args[0], "x"), num(args[1], "y"), Math.abs(num(args[2], "r")), 0, Math.PI * 2)
        points.pop()
        this.shape(points, paintOf(options(args[3]), true))
        return
      }
      case "arc": {
        const opts = options(args[5])
        const inner = opts?.keys.get("inner")
        const sector = typeof inner === "number" || opts?.keys.get("fill") !== undefined
        const paint = paintOf(opts, sector)
        const x = num(args[0], "x")
        const y = num(args[1], "y")
        const a0 = num(args[3], "a0")
        const a1 = num(args[4], "a1")
        const outer = arcPoints(x, y, Math.abs(num(args[2], "r")), a0, a1)
        if (!sector) {
          this.stroke(outer, paint)
          return
        }
        if (typeof inner === "number" && inner > 0) outer.push(...arcPoints(x, y, inner, a0, a1).toReversed())
        else outer.push([x, y])
        this.shape(outer, paint)
        return
      }
      case "text": {
        const opts = options(args[3])
        const weight = opts?.keys.get("weight")
        const size = opts?.keys.get("size")
        const align = opts?.keys.get("align")
        const baseline = opts?.keys.get("baseline")
        const text = valueText(args[2]).replaceAll("\n", " ")
        if (text === "") return
        this.push({
          kind: "text",
          x: num(args[0], "x"),
          y: num(args[1], "y"),
          text,
          size: typeof size === "string" ? parseTextSize(size) : "sm",
          weight:
            typeof weight === "number"
              ? weightFromNumber(weight)
              : typeof weight === "string"
                ? parseWeight(weight)
                : 400,
          color: parseColor(opts?.keys.get("color")) ?? tokenColor("text"),
          mono: opts?.keys.get("mono") === true,
          align: typeof align === "string" ? parseAlign(align) : "start",
          baseline: typeof baseline === "string" ? parseAlign(baseline) : "start",
        })
        return
      }
      default: {
        const _exhaustive: never = method
        return _exhaustive
      }
    }
  }
}
