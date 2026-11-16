// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import { parseTextSize, parseToken, VisualError, type TextSize, type Token } from "./style.ts"
import type { Plain } from "./value.ts"

export type V3 = [number, number, number]

export const SCENE_METHODS = [
  "box",
  "sphere",
  "cylinder",
  "surface",
  "mesh",
  "line",
  "path",
  "point",
  "label",
  "grid",
  "axes",
  "sprite",
  "model",
  "environment",
] as const

export type SceneMethod = (typeof SCENE_METHODS)[number]

export type Paint = { kind: "token"; token: Token } | { kind: "rgb"; hex: string }

export interface SceneColor {
  paint: Paint
  mix: { paint: Paint; t: number } | undefined
  alpha: number
}

export interface Material {
  roughness: number
  metalness: number
  glow: number
  glass: number
  ior: number
  dispersion: number
}

export interface Face {
  corners: V3[]
  normal: V3
  normals: V3[] | undefined
  color: SceneColor
  twoSided: boolean
  material: Material
}

export interface Line3 {
  a: V3
  b: V3
  color: SceneColor
  width: number
}

export interface Point3 {
  at: V3
  radius: number
  color: SceneColor
  hint: string | undefined
}

export interface Label3 {
  at: V3
  text: string
  color: SceneColor
  size: TextSize
}

export interface Sprite {
  at: V3
  size: number
  color: SceneColor
  glow: number
}

export interface Camera {
  yaw: number
  pitch: number
  zoom: number
}

export interface Bounds {
  lo: V3
  hi: V3
}

export interface CameraFrame {
  eye: V3
  right: V3
  up: V3
  forward: V3
  focal: number
  near: number
  far: number
  center: V3
  radius: number
  light: V3
}

export const MAX_FACES = 500_000
export const MAX_ITEMS = 20_000

const ASSETS = "assets are not supported in Ingle visuals"
const MATERIAL_PROPS = ["roughness", "metal", "glow", "glass", "ior", "dispersion"] as const

export const defaultMaterial = (): Material => ({
  roughness: 0.55,
  metalness: 0,
  glow: 0,
  glass: 0,
  ior: 1.5,
  dispersion: 0,
})

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export function normalize(a: V3): V3 {
  const length = Math.sqrt(dot(a, a))
  return length < 1e-9 ? [0, 1, 0] : scale(a, 1 / length)
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))

type Table = Record<string, unknown>

const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value)

const isNil = (value: unknown): value is null | undefined => value === undefined || value === null

export function typeName(value: unknown): string {
  if (value === undefined || value === null) return "nil"
  if (typeof value === "object") return "table"
  return typeof value
}

export function valueText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "boolean") return String(value)
  if (value === undefined || value === null) return ""
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
  }
  return typeName(value)
}

const token = (name: Token): SceneColor => ({ paint: { kind: "token", token: name }, mix: undefined, alpha: 1 })

export function parseColor(value: unknown): SceneColor | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return token(parseToken(value))
  if (isTable(value) && value["__color"] === true) {
    const base = value["token"]
    if (typeof base !== "string") throw new VisualError(`a ui.color needs a token name, not a ${typeName(base)}`)
    const other = value["mix"]
    const t = value["t"]
    const alpha = value["alpha"]
    return {
      paint: { kind: "token", token: parseToken(base) },
      mix:
        typeof other === "string"
          ? { paint: { kind: "token", token: parseToken(other) }, t: clamp(typeof t === "number" ? t : 0.5, 0, 1) }
          : undefined,
      alpha: clamp(typeof alpha === "number" ? alpha : 1, 0, 1),
    }
  }
  throw new VisualError(`a color is a theme token name or ui.color/ui.mix, not a ${typeName(value)}`)
}

export function sceneColor(value: unknown): SceneColor | undefined {
  if (typeof value === "string" && value.startsWith("#")) {
    const hex = value.slice(1)
    if (/^[0-9a-fA-F]{6}$/.test(hex))
      return { paint: { kind: "rgb", hex: `#${hex.toLowerCase()}` }, mix: undefined, alpha: 1 }
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const long = [...hex.toLowerCase()].map((digit) => digit + digit).join("")
      return { paint: { kind: "rgb", hex: `#${long}` }, mix: undefined, alpha: 1 }
    }
    throw new VisualError(`'${value}' is not a #rrggbb color`)
  }
  return parseColor(value)
}

export function ramp(colors: readonly SceneColor[], t: number): SceneColor {
  const first = colors[0]
  if (first === undefined) return token("accent")
  if (colors.length === 1) return first
  const scaled = clamp(t, 0, 1) * (colors.length - 1)
  const index = Math.min(Math.floor(scaled), colors.length - 2)
  const from = colors[index] ?? first
  const to = colors[index + 1] ?? from
  return { paint: from.paint, mix: { paint: to.paint, t: scaled - index }, alpha: from.alpha }
}

class Options {
  constructor(
    readonly method: string,
    readonly table: Table,
  ) {}

  static of(method: string, value: unknown, known: readonly string[]): Options {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0))
      return new Options(method, {})
    if (!isTable(value)) throw new VisualError(`s:${method} takes a table of options, not a ${typeName(value)}`)
    for (const key of Object.keys(value)) {
      if (known.includes(key) || /^\d+$/.test(key)) continue
      if (key === "texture" || key === "asset") throw new VisualError(`s:${method} '${key}': ${ASSETS}`)
      throw new VisualError(`s:${method} has no '${key}' (it takes ${known.join(", ")})`)
    }
    return new Options(method, value)
  }

  private expected(key: string, kind: string, value: unknown): Error {
    return new VisualError(`s:${this.method} '${key}': expected ${kind}, got ${typeName(value)}`)
  }

  raw(key: string): unknown {
    const value = this.table[key]
    return value === null ? undefined : value
  }

  number(key: string): number | undefined {
    const value = this.raw(key)
    if (value === undefined) return undefined
    if (typeof value !== "number") throw this.expected(key, "number", value)
    return value
  }

  integer(key: string): number | undefined {
    const value = this.number(key)
    return value === undefined ? undefined : Math.round(value)
  }

  bool(key: string): boolean | undefined {
    const value = this.raw(key)
    if (value === undefined) return undefined
    if (typeof value !== "boolean") throw this.expected(key, "boolean", value)
    return value
  }

  string(key: string): string | undefined {
    const value = this.raw(key)
    if (value === undefined) return undefined
    if (typeof value !== "string") throw this.expected(key, "string", value)
    return value
  }

  list(key: string): unknown[] | undefined {
    const value = this.raw(key)
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw this.expected(key, "list", value)
    return value
  }

  color(fallback: Token): SceneColor {
    return sceneColor(this.raw("color")) ?? token(fallback)
  }

  material(): Material {
    const material = defaultMaterial()
    const roughness = this.number("roughness")
    if (roughness !== undefined) material.roughness = clamp(roughness, 0.02, 1)
    const metal = this.number("metal")
    if (metal !== undefined) material.metalness = clamp(metal, 0, 1)
    const glow = this.number("glow")
    if (glow !== undefined) material.glow = clamp(glow, 0, 8)
    const glass = this.raw("glass")
    if (glass === true) {
      material.glass = 1
      material.roughness = Math.min(material.roughness, 0.08)
    } else if (typeof glass === "number") material.glass = clamp(glass, 0, 1)
    else if (glass !== undefined && glass !== false) throw this.expected("glass", "boolean or number", glass)
    const ior = this.number("ior")
    if (ior !== undefined) material.ior = clamp(ior, 1, 3)
    const dispersion = this.number("dispersion")
    if (dispersion !== undefined) material.dispersion = clamp(dispersion, 0, 1)
    return material
  }
}

export function v3(value: unknown, what: string): V3 {
  if (Array.isArray(value)) {
    const part = (index: number): number => {
      const n: unknown = value[index]
      if (n === undefined || n === null) return 0
      if (typeof n !== "number") throw new VisualError(`${what} must be a {x, y, z} list of numbers`)
      return n
    }
    return [part(0), part(1), part(2)]
  }
  if (isTable(value)) {
    const part = (index: number, key: string): number => {
      const n = value[String(index)] ?? value[key]
      if (n === undefined || n === null) return 0
      if (typeof n !== "number") throw new VisualError(`${what} must be a {x, y, z} list of numbers`)
      return n
    }
    return [part(1, "x"), part(2, "y"), part(3, "z")]
  }
  throw new VisualError(`${what} must be a {x, y, z} list`)
}

function range(options: Options, key: string): [number, number] {
  const list = options.list(key)
  if (list === undefined) return [-1, 1]
  const [lo, hi] = list
  if (typeof lo !== "number" || typeof hi !== "number")
    throw new VisualError(`s:${options.method} '${key}' is { min, max }`)
  return [lo, hi]
}

function optionsForm(at: unknown, options: unknown, field: string): { at: unknown; options: unknown; table: boolean } {
  if (isTable(at) && isNil(options) && !isNil(at[field])) return { at: at[field], options: at, table: true }
  return { at, options, table: false }
}

const SOLID = (...own: string[]): string[] => [...own, ...MATERIAL_PROPS]

export class Scene {
  readonly faces: Face[] = []
  readonly lines: Line3[] = []
  readonly points: Point3[] = []
  readonly labels: Label3[] = []
  readonly sprites: Sprite[] = []
  private material: Material = defaultMaterial()

  constructor(readonly time: number) {}

  get items(): number {
    return this.lines.length + this.points.length + this.labels.length + this.sprites.length
  }

  private checkItems(): void {
    if (this.items >= MAX_ITEMS) throw new VisualError(`a scene draws at most ${MAX_ITEMS} lines, points, and labels`)
  }

  private face(corners: V3[], color: SceneColor, outward: V3 | undefined, twoSided: boolean): Face {
    if (this.faces.length >= MAX_FACES) throw new VisualError(`a scene draws at most ${MAX_FACES} faces`)
    if (corners.some((corner) => corner.some((c) => !Number.isFinite(c))))
      throw new VisualError("a scene vertex is NaN or infinite")
    const [first, second, third, fourth] = corners
    if (first === undefined || second === undefined || third === undefined)
      throw new VisualError("a face needs 3 corners")
    const last = corners[corners.length - 1] ?? third
    let normal =
      fourth === undefined
        ? normalize(cross(sub(second, first), sub(last, first)))
        : normalize(cross(sub(third, first), sub(fourth, second)))
    if (outward !== undefined && dot(normal, outward) < 0) normal = scale(normal, -1)
    const face: Face = { corners, normal, normals: undefined, color, twoSided, material: this.material }
    this.faces.push(face)
    return face
  }

  private smoothFace(corners: V3[], normals: V3[], color: SceneColor): void {
    const outward = normals.reduce<V3>((sum, n) => add(sum, n), [0, 0, 0])
    this.face(corners, color, outward, false).normals = normals.map(normalize)
  }

  private polygon(corners: V3[], color: SceneColor, outward: V3 | undefined, twoSided: boolean): void {
    if (corners.length < 3) return
    if (corners.length <= 4) {
      this.face(corners, color, outward, twoSided)
      return
    }
    const [first] = corners
    if (first === undefined) return
    for (let i = 1; i < corners.length - 1; i++) {
      const b = corners[i]
      const c = corners[i + 1]
      if (b !== undefined && c !== undefined) this.face([first, b, c], color, outward, twoSided)
    }
  }

  private box(value: unknown): void {
    const o = Options.of("box", value, SOLID("at", "size", "color"))
    this.material = o.material()
    const at = v3(o.raw("at"), "box at")
    const size = o.raw("size")
    const extent: V3 =
      size === undefined ? [1, 1, 1] : typeof size === "number" ? [size, size, size] : v3(size, "box size")
    const color = o.color("accent")
    const h = scale(extent, 0.5)
    const c = (x: number, y: number, z: number): V3 => [at[0] + x * h[0], at[1] + y * h[1], at[2] + z * h[2]]
    const quads: [V3[], V3][] = [
      [
        [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
        [0, 0, 1],
      ],
      [
        [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)],
        [0, 0, -1],
      ],
      [
        [c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)],
        [1, 0, 0],
      ],
      [
        [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)],
        [-1, 0, 0],
      ],
      [
        [c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1)],
        [0, 1, 0],
      ],
      [
        [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
        [0, -1, 0],
      ],
    ]
    for (const [quad, outward] of quads) this.face(quad, color, outward, false)
  }

  private sphere(value: unknown): void {
    const o = Options.of("sphere", value, SOLID("at", "radius", "color", "detail"))
    this.material = o.material()
    const at = v3(o.raw("at"), "sphere at")
    const r = Math.abs(o.number("radius") ?? 0.5)
    const color = o.color("accent")
    const detail = clamp(o.integer("detail") ?? 18, 6, 48)
    const lon = detail * 2
    const lat = detail
    const p = (i: number, j: number): V3 => {
      const theta = (Math.PI * 2 * i) / lon
      const phi = (Math.PI * j) / lat
      return [
        at[0] + r * Math.sin(phi) * Math.cos(theta),
        at[1] + r * Math.cos(phi),
        at[2] + r * Math.sin(phi) * Math.sin(theta),
      ]
    }
    for (let j = 0; j < lat; j++) {
      for (let i = 0; i < lon; i++) {
        const quad = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)] as const
        const corners: V3[] =
          j === 0 ? [quad[0], quad[2], quad[3]] : j === lat - 1 ? [quad[0], quad[1], quad[2]] : [...quad]
        this.smoothFace(
          corners,
          corners.map((corner) => sub(corner, at)),
          color,
        )
      }
    }
  }

  private cylinder(value: unknown): void {
    const o = Options.of("cylinder", value, SOLID("at", "radius", "height", "color", "detail"))
    this.material = o.material()
    const at = v3(o.raw("at"), "cylinder at")
    const r = Math.abs(o.number("radius") ?? 0.5)
    const h = o.number("height") ?? 1
    const color = o.color("accent")
    const n = clamp(o.integer("detail") ?? 24, 6, 64)
    const ring = (i: number, y: number): V3 => {
      const a = (Math.PI * 2 * i) / n
      return [at[0] + r * Math.cos(a), at[1] + y, at[2] + r * Math.sin(a)]
    }
    for (let i = 0; i < n; i++) {
      const quad = [ring(i, 0), ring(i + 1, 0), ring(i + 1, h), ring(i, h)]
      this.smoothFace(
        quad,
        quad.map((corner): V3 => [corner[0] - at[0], 0, corner[2] - at[2]]),
        color,
      )
    }
    const sides = Array.from({ length: n }, (_, i) => i)
    this.polygon(
      sides.map((i) => ring(i, h)),
      color,
      [0, Math.sign(h), 0],
      false,
    )
    this.polygon(
      sides.map((i) => ring(i, 0)),
      color,
      [0, -Math.sign(h), 0],
      false,
    )
  }

  private surface(value: unknown): void {
    const o = Options.of("surface", value, SOLID("x", "z", "f", "values", "detail", "colors", "color", "wire"))
    this.material = o.material()
    const [x0, x1] = range(o, "x")
    const [z0, z1] = range(o, "z")
    const list = o.list("colors")
    const colors =
      list === undefined
        ? [o.color("accent")]
        : list.flatMap((entry) => {
            const color = parseColor(entry)
            return color === undefined ? [] : [color]
          })
    const wire = o.bool("wire") ?? false
    const grid: number[][] = []
    const values = o.list("values")
    if (values !== undefined) {
      for (const row of values) {
        if (!Array.isArray(row)) throw new VisualError("s:surface 'values' is a list of rows of numbers")
        grid.push(
          row.map((n: unknown) => {
            if (typeof n !== "number") throw new VisualError(`s:surface 'values': expected number, got ${typeName(n)}`)
            return n
          }),
        )
      }
    } else {
      const f = o.raw("f")
      if (typeof f !== "function") throw new VisualError("scene:surface needs f = function(x, z) or values")
      const n = clamp(o.integer("detail") ?? 32, 2, 120)
      for (let j = 0; j <= n; j++) {
        const z = z0 + ((z1 - z0) * j) / n
        const row: number[] = []
        for (let i = 0; i <= n; i++) {
          const x = x0 + ((x1 - x0) * i) / n
          const y: unknown = f(x, z)
          if (typeof y !== "number") throw new VisualError(`s:surface 'f': expected number, got ${typeName(y)}`)
          row.push(y)
        }
        grid.push(row)
      }
    }
    const rows = grid.length
    const cols = Math.min(...grid.map((row) => row.length))
    if (rows < 2 || cols < 2) throw new VisualError("scene:surface needs at least a 2x2 grid")
    let lo = Infinity
    let hi = -Infinity
    for (const row of grid) for (const y of row) [lo, hi] = [Math.min(lo, y), Math.max(hi, y)]
    const span = Math.max(hi - lo, 1e-6)
    const point = (i: number, j: number): V3 => [
      x0 + ((x1 - x0) * i) / (cols - 1),
      grid[j]?.[i] ?? 0,
      z0 + ((z1 - z0) * j) / (rows - 1),
    ]
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const quad = [point(i, j), point(i + 1, j), point(i + 1, j + 1), point(i, j + 1)] as const
        const mean = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4
        const color = ramp(colors, (mean - lo) / span)
        if (wire) {
          this.checkItems()
          this.lines.push({ a: quad[0], b: quad[1], color, width: 1 }, { a: quad[0], b: quad[3], color, width: 1 })
        } else this.face([...quad], color, [0, 1, 0], true)
      }
    }
  }

  private mesh(value: unknown): void {
    const o = Options.of("mesh", value, SOLID("vertices", "faces", "color", "uvs"))
    this.material = o.material()
    const color = o.color("accent")
    const vertices = (o.list("vertices") ?? []).map((vertex) => v3(vertex, "mesh vertex"))
    for (const face of o.list("faces") ?? []) {
      if (!Array.isArray(face)) throw new VisualError("s:mesh 'faces' is a list of index lists")
      const corners = face.map((index: unknown) => {
        const corner = typeof index === "number" ? vertices[index - 1] : undefined
        if (corner === undefined) throw new VisualError(`mesh face index ${valueText(index)} is out of range`)
        return corner
      })
      this.polygon(corners, color, undefined, true)
    }
  }

  private line(a: unknown, b?: unknown, options?: unknown): void {
    this.checkItems()
    const table = isTable(a) && isNil(b) && !isNil(a["from"])
    const o = Options.of("line", table ? a : options, table ? ["from", "to", "color", "width"] : ["color", "width"])
    this.lines.push({
      a: v3(table ? o.raw("from") : a, "line start"),
      b: v3(table ? o.raw("to") : b, "line end"),
      color: o.color("muted"),
      width: clamp(o.number("width") ?? 1, 0.25, 12),
    })
  }

  private path(points: unknown, options?: unknown): void {
    const o = Options.of("path", options, ["color", "width"])
    if (!Array.isArray(points)) throw new VisualError("s:path takes a list of {x, y, z} points")
    const color = o.color("muted")
    const width = clamp(o.number("width") ?? 1, 0.25, 12)
    const pts = points.map((p) => v3(p, "path point"))
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (a === undefined || b === undefined) continue
      this.checkItems()
      this.lines.push({ a, b, color, width })
    }
  }

  private point(at: unknown, options?: unknown): void {
    this.checkItems()
    const form = optionsForm(at, options, "at")
    const o = Options.of(
      "point",
      form.options,
      form.table ? ["at", "radius", "color", "hint"] : ["radius", "color", "hint"],
    )
    const hint = o.raw("hint")
    this.points.push({
      at: v3(form.at, "point"),
      radius: clamp(o.number("radius") ?? 3, 0.5, 24),
      color: o.color("accent"),
      hint: isNil(hint) ? undefined : valueText(hint),
    })
  }

  private label(at: unknown, text?: unknown, options?: unknown): void {
    this.checkItems()
    const table = isTable(at) && isNil(text) && !isNil(at["at"])
    const o = Options.of("label", table ? at : options, table ? ["at", "text", "color", "size"] : ["color", "size"])
    const size = o.string("size")
    this.labels.push({
      at: v3(table ? o.raw("at") : at, "label"),
      text: valueText(table ? o.raw("text") : text),
      color: o.color("muted"),
      size: size === undefined ? "xs" : parseTextSize(size),
    })
  }

  private sprite(at: unknown, options?: unknown): void {
    this.checkItems()
    const form = optionsForm(at, options, "at")
    const o = Options.of(
      "sprite",
      form.options,
      form.table ? ["at", "size", "color", "glow"] : ["size", "color", "glow"],
    )
    this.sprites.push({
      at: v3(form.at, "sprite"),
      size: clamp(o.number("size") ?? 48, 1, 2048),
      color: o.color("accent"),
      glow: clamp(o.number("glow") ?? 1, 0, 16),
    })
  }

  private grid(value?: unknown): void {
    const o = Options.of("grid", value, ["size", "step", "y"])
    const size = Math.max(Math.abs(o.number("size") ?? 10), 0.1)
    const step = Math.max(Math.abs(o.number("step") ?? 1), 0.01)
    const y = o.number("y") ?? 0
    const half = size / 2
    const n = clamp(Math.round(size / step), 1, 200)
    const color = token("border")
    for (let i = 0; i <= n; i++) {
      this.checkItems()
      const t = -half + (size * i) / n
      this.lines.push(
        { a: [t, y, -half], b: [t, y, half], color, width: 1 },
        { a: [-half, y, t], b: [half, y, t], color, width: 1 },
      )
    }
  }

  private axes(value?: unknown): void {
    const o = Options.of("axes", value, ["size", "labels"])
    const size = o.number("size") ?? 1
    const labels = o.list("labels")
    const names = [0, 1, 2].map((axis) =>
      labels === undefined ? (["x", "y", "z"][axis] ?? "") : valueText(labels[axis]),
    )
    names.forEach((name, axis) => {
      this.checkItems()
      const end: V3 = [0, 0, 0]
      end[axis] = size
      this.lines.push({ a: [0, 0, 0], b: [...end], color: token("muted"), width: 1 })
      if (name === "") return
      end[axis] = size * 1.08
      this.labels.push({ at: end, text: name, color: token("muted"), size: "xs" })
    })
  }

  private model(): never {
    throw new VisualError(`s:model: ${ASSETS}`)
  }

  private environment(): never {
    throw new VisualError(`s:environment: ${ASSETS}`)
  }

  call(method: SceneMethod, args: readonly Plain[]): void {
    const [a, b, c] = args
    switch (method) {
      case "box":
        return this.box(a)
      case "sphere":
        return this.sphere(a)
      case "cylinder":
        return this.cylinder(a)
      case "surface":
        return this.surface(a)
      case "mesh":
        return this.mesh(a)
      case "line":
        return this.line(a, b, c)
      case "path":
        return this.path(a, b)
      case "point":
        return this.point(a, b)
      case "label":
        return this.label(a, b, c)
      case "grid":
        return this.grid(a)
      case "axes":
        return this.axes(a)
      case "sprite":
        return this.sprite(a, b)
      case "model":
        return this.model()
      case "environment":
        return this.environment()
      default: {
        const _exhaustive: never = method
        return _exhaustive
      }
    }
  }

  isEmpty(): boolean {
    return (
      this.faces.length === 0 &&
      this.lines.length === 0 &&
      this.points.length === 0 &&
      this.labels.length === 0 &&
      this.sprites.length === 0
    )
  }

  get glows(): boolean {
    return this.sprites.length > 0 || this.faces.some((face) => face.material.glow > 0)
  }

  bounds(): Bounds | undefined {
    const lo: V3 = [Infinity, Infinity, Infinity]
    const hi: V3 = [-Infinity, -Infinity, -Infinity]
    const grow = (p: V3): void => {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i] ?? Infinity, p[i] ?? 0)
        hi[i] = Math.max(hi[i] ?? -Infinity, p[i] ?? 0)
      }
    }
    for (const face of this.faces) for (const corner of face.corners) grow(corner)
    for (const line of this.lines) {
      grow(line.a)
      grow(line.b)
    }
    for (const point of this.points) grow(point.at)
    for (const label of this.labels) grow(label.at)
    for (const sprite of this.sprites) grow(sprite.at)
    return Number.isFinite(lo[0]) ? { lo, hi } : undefined
  }
}

export function frameCamera(bounds: Bounds, camera: Camera, width: number, height: number): CameraFrame {
  const target = scale(add(bounds.lo, bounds.hi), 0.5)
  const half = scale(sub(bounds.hi, bounds.lo), 0.5)
  const radius = Math.max(Math.sqrt(dot(half, half)), 1e-3)
  const pitch = clamp(camera.pitch, -1.52, 1.52)
  const footprint = Math.max(Math.hypot(half[0], half[2]), 1e-3)
  const tall = Math.max(half[1] * Math.abs(Math.cos(pitch)) + footprint * Math.abs(Math.sin(pitch)), 1e-3)
  const distance = radius * 4
  const eye = add(
    target,
    scale([Math.cos(pitch) * Math.sin(camera.yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(camera.yaw)], distance),
  )
  const forward = normalize(sub(target, eye))
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const focal = 0.86 * Math.min(width / 2 / footprint, height / 2 / tall) * distance * Math.max(camera.zoom, 0.05)
  const light = normalize(add(add(scale(right, -0.45), scale(up, 0.8)), scale(forward, -0.55)))
  return {
    eye,
    right,
    up,
    forward,
    focal,
    near: distance * 0.02,
    far: distance + radius * 3,
    center: target,
    radius,
    light,
  }
}

export function project(frame: CameraFrame, width: number, height: number, p: V3): [number, number, number] {
  const d = sub(p, frame.eye)
  const z = dot(d, frame.forward)
  return [width / 2 + (frame.focal * dot(d, frame.right)) / z, height / 2 - (frame.focal * dot(d, frame.up)) / z, z]
}
