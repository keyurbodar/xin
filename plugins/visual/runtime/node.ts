// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import {
  type Align,
  type Bloom,
  BLOOMS,
  type Color,
  DITHER_VARIANTS,
  type DitherVariant,
  type Justify,
  type NumberFormat,
  type TextSize,
  type Weight,
  parseAlign,
  parseJustify,
  parseTextSize,
  parseToken,
  parseWeight,
  seriesToken,
  tokenColor,
  VisualError,
  weightFromNumber,
} from "./style.ts"
import { isFunction, isTable, type LuaFunction, type LuaTable, type LuaValue, typeName, valueText } from "./value.ts"

export type HandlerId = number

export type Span = {
  readonly text: string
  readonly weight?: Weight
  readonly color?: Color
  readonly mono: boolean
  readonly italic: boolean
}

export type TextNode = {
  readonly kind: "text"
  readonly spans: readonly Span[]
  readonly size: TextSize
  readonly weight: Weight
  readonly color?: Color
  readonly mono: boolean
  readonly italic: boolean
  readonly align: Align
  readonly truncate: boolean
}

export type Column = { readonly label: string; readonly align: Align; readonly width?: number }

export type Series = {
  readonly name: string
  readonly color: Color
  readonly values: readonly (number | null)[]
  readonly points: readonly (readonly [number, number])[]
}

export type ChartKind = "bar" | "line" | "area" | "scatter"

export type ChartNode = {
  readonly kind: "chart"
  readonly type: ChartKind
  readonly height: number
  readonly x: readonly string[]
  readonly series: readonly Series[]
  readonly stacked: boolean
  readonly horizontal: boolean
  readonly min?: number
  readonly max?: number
  readonly format: NumberFormat
  readonly xFormat: NumberFormat
  readonly legend: boolean
  readonly dither: DitherVariant | undefined
  readonly bloom: Bloom
}

export type Camera = { readonly yaw: number; readonly pitch: number; readonly zoom: number }

export type Blend = "alpha" | "light" | "opaque"

export type NodeKind =
  | {
      readonly kind: "stack"
      readonly axis: "vertical" | "horizontal"
      readonly gap: number
      readonly align: Align
      readonly justify: Justify
      readonly wrap: boolean
      readonly hover: boolean
      readonly onClick?: HandlerId
      readonly children: readonly Node[]
    }
  | { readonly kind: "grid"; readonly columns: number; readonly gap: number; readonly children: readonly Node[] }
  | TextNode
  | { readonly kind: "rule" }
  | { readonly kind: "space"; readonly size: number }
  | {
      readonly kind: "stat"
      readonly value: string
      readonly label: string
      readonly delta?: string
      readonly tone?: Color
    }
  | {
      readonly kind: "table"
      readonly columns: readonly Column[]
      readonly rows: readonly (readonly Node[])[]
      readonly hover: boolean
    }
  | ChartNode
  | {
      readonly kind: "canvas"
      readonly height: number
      readonly draw: HandlerId
      readonly animate: boolean
      readonly onClick?: HandlerId
    }
  | {
      readonly kind: "scene"
      readonly height: number
      readonly draw: HandlerId
      readonly animate: boolean
      readonly orbit: boolean
      readonly spin: number
      readonly camera: Camera
    }
  | {
      readonly kind: "shader"
      readonly height: number
      readonly code: string
      readonly buffers: readonly string[]
      readonly inputs: readonly (readonly [string, number])[]
      readonly animate: boolean
      readonly orbit: boolean
      readonly spin: number
      readonly camera: Camera
      readonly blend: Blend
      readonly bloom: number
    }
  | { readonly kind: "button"; readonly label: string; readonly onClick: HandlerId; readonly primary: boolean }
  | { readonly kind: "tabs"; readonly options: readonly string[]; readonly value: string; readonly onChange: HandlerId }
  | { readonly kind: "toggle"; readonly label: string; readonly value: boolean; readonly onChange: HandlerId }
  | {
      readonly kind: "slider"
      readonly label?: string
      readonly value: number
      readonly min: number
      readonly max: number
      readonly step: number
      readonly onChange: HandlerId
      readonly format: NumberFormat
    }
  | { readonly kind: "link"; readonly label: string; readonly url: string }

export type Node = NodeKind & { readonly width?: number; readonly grow: boolean; readonly key?: string }

export const MIN_HEIGHT = 40
export const MAX_HEIGHT = 720
const MAX_NODES = 4000
const MAX_DEPTH = 48
const MAX_TEXT = 8000
const MAX_BUFFERS = 4
const MAX_INPUTS = 16
const COMMON = new Set(["__kind", "width", "grow", "key"])

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
const clip = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text)

function forbidden(prop: string): string | undefined {
  switch (prop) {
    case "background":
    case "bg":
    case "fill":
    case "shadow":
    case "border":
    case "padding":
    case "radius":
    case "blur":
    case "opacity":
      return "visuals have no containers, fills, borders, or shadows: lay content directly on the chat with gap, ui.rule(), and type"
    case "font":
    case "family":
    case "font_family":
    case "fontFamily":
    case "font_size":
    case "fontSize":
      return "text always renders in Ingle's interface font; size it with size = xs, sm, body, lg, xl, or 2xl"
    default:
      return undefined
  }
}

export function parseColor(value: LuaValue): Color | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return tokenColor(parseToken(value))
  if (isTable(value) && value.keys.get("__color") === true) {
    const token = value.keys.get("token")
    if (typeof token !== "string") throw new VisualError("ui.color needs a token name")
    const mix = value.keys.get("mix")
    const t = value.keys.get("t")
    const alpha = value.keys.get("alpha")
    return {
      token: parseToken(token),
      ...(typeof mix === "string"
        ? { mix: { token: parseToken(mix), t: clamp(typeof t === "number" ? t : 0.5, 0, 1) } }
        : {}),
      alpha: clamp(typeof alpha === "number" ? alpha : 1, 0, 1),
    }
  }
  throw new VisualError(`a color is a theme token name or ui.color/ui.mix, not a ${typeName(value)}`)
}

export function numberFormat(props: Props): NumberFormat {
  const decimals = props.number("decimals")
  return {
    prefix: props.string("prefix") ?? "",
    unit: props.string("unit") ?? "",
    decimals: decimals === undefined ? undefined : Math.trunc(clamp(decimals, 0, 6)),
  }
}

export class Props {
  constructor(
    readonly table: LuaTable,
    readonly kind: string,
  ) {}

  error(message: string): VisualError {
    return new VisualError(`ui.${this.kind} ${message}`)
  }

  allow(known: readonly string[]): void {
    for (const key of this.table.keys.keys()) {
      if (COMMON.has(key) || known.includes(key)) continue
      const reason = forbidden(key)
      const hint = reason !== undefined ? `: ${reason}` : known.length === 0 ? "" : ` (it takes ${known.join(", ")})`
      throw this.error(`has no '${key}'${hint}`)
    }
  }

  raw(name: string): LuaValue {
    return this.table.keys.get(name)
  }

  number(name: string): number | undefined {
    const value = this.raw(name)
    if (value === undefined) return undefined
    if (typeof value !== "number") throw this.error(`'${name}': expected number, got ${typeName(value)}`)
    return value
  }

  bool(name: string): boolean | undefined {
    const value = this.raw(name)
    if (value === undefined) return undefined
    if (typeof value !== "boolean") throw this.error(`'${name}' must be true or false`)
    return value
  }

  string(name: string): string | undefined {
    const value = this.raw(name)
    if (value === undefined) return undefined
    if (typeof value !== "string" && typeof value !== "number") throw this.error(`'${name}' must be a string`)
    return clip(valueText(value))
  }

  requiredString(name: string): string {
    const value = this.string(name)
    if (value === undefined) throw this.error(`needs ${name}`)
    return value
  }

  fn(name: string): LuaFunction | undefined {
    const value = this.raw(name)
    if (value === undefined) return undefined
    if (!isFunction(value)) throw this.error(`'${name}' must be a function`)
    return value
  }

  list(name: string): LuaTable | undefined {
    const value = this.raw(name)
    if (value === undefined) return undefined
    if (!isTable(value)) throw this.error(`'${name}': expected table, got ${typeName(value)}`)
    return value
  }

  parsed<T>(name: string, parse: (text: string) => T): T | undefined {
    const value = this.string(name)
    return value === undefined ? undefined : parse(value)
  }

  weight(): Weight | undefined {
    const value = this.raw("weight")
    if (value === undefined) return undefined
    if (typeof value === "number") return weightFromNumber(value)
    if (typeof value === "string") return parseWeight(value)
    throw this.error("'weight' must be a number or a name")
  }

  color(name: string): Color | undefined {
    try {
      return parseColor(this.raw(name))
    } catch (error) {
      throw this.error(error instanceof Error ? error.message : String(error))
    }
  }

  height(): number {
    const value = this.number("height")
    if (value === undefined)
      throw this.error(`needs height (in pixels, ${MIN_HEIGHT}-${MAX_HEIGHT}); its width is the reply column's`)
    return clamp(value, MIN_HEIGHT, MAX_HEIGHT)
  }

  camera(defaults: Camera): Camera {
    const camera = this.list("camera")
    const read = (key: string, fallback: number): number => {
      const value = camera?.keys.get(key)
      return typeof value === "number" ? value : fallback
    }
    return {
      yaw: read("yaw", defaults.yaw),
      pitch: clamp(read("pitch", defaults.pitch), -1.5, 1.5),
      zoom: clamp(read("zoom", defaults.zoom), 0.2, 5),
    }
  }
}

/** Builds a node tree from a view's return value, collecting the functions it references. */
export class Parser {
  readonly handlers: LuaFunction[] = []
  private nodes = 0

  private handler(fn: LuaFunction): HandlerId {
    this.handlers.push(fn)
    return this.handlers.length - 1
  }

  private required(props: Props, name: string): HandlerId {
    const fn = props.fn(name)
    if (fn === undefined) throw props.error(`needs ${name} = function(...) end`)
    return this.handler(fn)
  }

  root(value: LuaValue): Node {
    const children: Node[] = []
    this.childrenInto(value, children, 0)
    if (children.length === 1 && children[0] !== undefined) return children[0]
    return {
      kind: "stack",
      axis: "vertical",
      gap: 16,
      align: "start",
      justify: "start",
      wrap: false,
      hover: false,
      children,
      grow: false,
    }
  }

  private childrenInto(value: LuaValue, out: Node[], depth: number): void {
    if (depth > MAX_DEPTH) throw new VisualError("the view nests too deeply")
    if (value === undefined || value === false) return
    if (typeof value === "string" || typeof value === "number") {
      out.push(this.plainText(valueText(value)))
      return
    }
    if (isTable(value)) {
      if (typeof value.keys.get("__kind") === "string") {
        out.push(this.node(value, depth))
        return
      }
      for (const child of value.seq) this.childrenInto(child, out, depth + 1)
      return
    }
    throw new VisualError(`a view child must be a ui node or a string, not a ${typeName(value)}`)
  }

  private count(): void {
    this.nodes += 1
    if (this.nodes > MAX_NODES)
      throw new VisualError(`the view has more than ${MAX_NODES} nodes; summarize or paginate the data`)
  }

  private plainText(text: string): Node {
    this.count()
    return {
      kind: "text",
      spans: [{ text: clip(text), mono: false, italic: false }],
      size: "body",
      weight: 400,
      mono: false,
      italic: false,
      align: "start",
      truncate: false,
      grow: false,
    }
  }

  private kids(table: LuaTable, depth: number): Node[] {
    const children: Node[] = []
    for (const child of table.seq) this.childrenInto(child, children, depth + 1)
    return children
  }

  private node(table: LuaTable, depth: number): Node {
    this.count()
    const kind = String(table.keys.get("__kind"))
    const props = new Props(table, kind)
    const body = this.body(kind, props, table, depth)
    const width = props.number("width")
    const key = props.string("key")
    return {
      ...body,
      ...(width === undefined ? {} : { width: clamp(width, 0, 2000) }),
      grow: props.bool("grow") ?? false,
      ...(key === undefined ? {} : { key }),
    }
  }

  private body(kind: string, props: Props, table: LuaTable, depth: number): NodeKind {
    switch (kind) {
      case "column":
      case "row": {
        props.allow(["gap", "align", "justify", "wrap", "hover", "on_click"])
        const onClick = props.fn("on_click")
        return {
          kind: "stack",
          axis: kind === "row" ? "horizontal" : "vertical",
          gap: clamp(props.number("gap") ?? (kind === "row" ? 12 : 8), 0, 96),
          align: props.parsed("align", parseAlign) ?? "start",
          justify: props.parsed("justify", parseJustify) ?? "start",
          wrap: props.bool("wrap") ?? false,
          hover: props.bool("hover") ?? false,
          ...(onClick === undefined ? {} : { onClick: this.handler(onClick) }),
          children: this.kids(table, depth),
        }
      }
      case "grid":
        props.allow(["columns", "gap"])
        return {
          kind: "grid",
          columns: Math.trunc(clamp(props.number("columns") ?? 3, 1, 12)),
          gap: clamp(props.number("gap") ?? 16, 0, 96),
          children: this.kids(table, depth),
        }
      case "text":
        return this.text(props)
      case "rule":
        props.allow([])
        return { kind: "rule" }
      case "space":
        props.allow(["size"])
        return { kind: "space", size: clamp(props.number("size") ?? 16, 0, 200) }
      case "stat": {
        props.allow(["value", "label", "delta", "tone"])
        const delta = props.string("delta")
        const tone = props.color("tone")
        return {
          kind: "stat",
          value: props.string("value") ?? "",
          label: props.string("label") ?? "",
          ...(delta === undefined ? {} : { delta }),
          ...(tone === undefined ? {} : { tone }),
        }
      }
      case "table":
        return this.table(props, depth)
      case "chart":
        return chart(props)
      case "canvas": {
        props.allow(["height", "draw", "animate", "on_click"])
        const onClick = props.fn("on_click")
        return {
          kind: "canvas",
          height: props.height(),
          draw: this.required(props, "draw"),
          animate: props.bool("animate") ?? false,
          ...(onClick === undefined ? {} : { onClick: this.handler(onClick) }),
        }
      }
      case "scene":
        props.allow(["height", "draw", "animate", "orbit", "spin", "camera"])
        return {
          kind: "scene",
          height: props.height(),
          draw: this.required(props, "draw"),
          animate: props.bool("animate") ?? false,
          orbit: props.bool("orbit") ?? true,
          spin: clamp(props.number("spin") ?? 0, -3, 3),
          camera: props.camera({ yaw: 0.6, pitch: 0.45, zoom: 1 }),
        }
      case "shader":
        return shader(props)
      case "button":
        props.allow(["label", "on_click", "primary"])
        return {
          kind: "button",
          label: props.requiredString("label"),
          onClick: this.required(props, "on_click"),
          primary: props.bool("primary") ?? false,
        }
      case "tabs": {
        props.allow(["options", "value", "on_change"])
        const options = (props.list("options")?.seq ?? []).map(valueText)
        if (options.length === 0) throw props.error("needs options = { ... }")
        return {
          kind: "tabs",
          options,
          value: props.string("value") ?? options[0] ?? "",
          onChange: this.required(props, "on_change"),
        }
      }
      case "toggle":
        props.allow(["label", "value", "on_change"])
        return {
          kind: "toggle",
          label: props.string("label") ?? "",
          value: props.bool("value") ?? false,
          onChange: this.required(props, "on_change"),
        }
      case "slider": {
        props.allow(["label", "value", "min", "max", "step", "on_change", "unit", "prefix", "decimals"])
        const min = props.number("min") ?? 0
        const max = Math.max(props.number("max") ?? 1, min + Number.EPSILON)
        const label = props.string("label")
        return {
          kind: "slider",
          ...(label === undefined ? {} : { label }),
          value: clamp(props.number("value") ?? min, min, max),
          min,
          max,
          step: Math.max(0, props.number("step") ?? 0),
          onChange: this.required(props, "on_change"),
          format: numberFormat(props),
        }
      }
      case "link": {
        props.allow(["label", "url"])
        const url = props.requiredString("url")
        if (!url.startsWith("https://") && !url.startsWith("http://")) throw props.error("url must be http(s)")
        return { kind: "link", label: props.string("label") ?? url, url }
      }
      case "span":
        throw new VisualError("ui.span goes inside ui.text { ... }, not directly in a layout")
      default:
        throw new VisualError(`unknown node '${kind}'`)
    }
  }

  private text(props: Props): TextNode {
    props.allow(["size", "weight", "color", "mono", "italic", "align", "truncate"])
    const spans: Span[] = []
    let length = 0
    for (const child of props.table.seq) {
      if (child === undefined || child === false) continue
      let span: Span
      if (isTable(child)) {
        if (child.keys.get("__kind") !== "span") throw props.error("children must be strings or ui.span { ... }")
        const spanProps = new Props(child, "span")
        spanProps.allow(["weight", "color", "mono", "italic"])
        const weight = spanProps.weight()
        const color = spanProps.color("color")
        span = {
          text: child.seq.map(valueText).join(""),
          ...(weight === undefined ? {} : { weight }),
          ...(color === undefined ? {} : { color }),
          mono: spanProps.bool("mono") ?? false,
          italic: spanProps.bool("italic") ?? false,
        }
      } else {
        span = { text: valueText(child), mono: false, italic: false }
      }
      length += span.text.length
      spans.push(span)
    }
    if (length > MAX_TEXT) throw props.error(`is over ${MAX_TEXT} characters`)
    const color = props.color("color")
    return {
      kind: "text",
      spans,
      size: props.parsed("size", parseTextSize) ?? "body",
      weight: props.weight() ?? 400,
      ...(color === undefined ? {} : { color }),
      mono: props.bool("mono") ?? false,
      italic: props.bool("italic") ?? false,
      align: props.parsed("align", parseAlign) ?? "start",
      truncate: props.bool("truncate") ?? false,
    }
  }

  private table(props: Props, depth: number): NodeKind {
    props.allow(["columns", "rows", "hover"])
    const columns: Column[] = (props.list("columns")?.seq ?? []).map((column) => {
      if (!isTable(column)) return { label: valueText(column), align: "start" }
      const align = column.keys.get("align")
      const width = column.keys.get("width")
      return {
        label: valueText(column.keys.get("label")),
        align: typeof align === "string" ? parseAlign(align) : "start",
        ...(typeof width === "number" ? { width } : {}),
      }
    })
    const rows: Node[][] = []
    for (const row of props.list("rows")?.seq ?? []) {
      if (!isTable(row)) throw props.error(`'rows': expected a list of tables, got ${typeName(row)}`)
      const cells: Node[] = []
      for (const cell of row.seq) {
        if (cell === undefined || cell === false) {
          cells.push(this.plainText(""))
          continue
        }
        const before = cells.length
        this.childrenInto(cell, cells, depth + 1)
        if (cells.length === before) cells.push(this.plainText(""))
        else if (cells.length > before + 1) throw props.error("cells must be one string, number, or node each")
      }
      rows.push(cells)
    }
    return { kind: "table", columns, rows, hover: props.bool("hover") ?? false }
  }
}

function dithering(props: Props): { dither: DitherVariant | undefined; bloom: Bloom } {
  const raw = props.raw("dither")
  const named = typeof raw === "string" ? DITHER_VARIANTS.find((variant) => variant === raw) : undefined
  if (raw !== undefined && typeof raw !== "boolean" && named === undefined)
    throw props.error(`'dither' must be true or one of ${DITHER_VARIANTS.join(", ")}`)
  const dither = raw === true ? "gradient" : named
  const glow = props.string("bloom")
  const bloom = glow === undefined ? "off" : BLOOMS.find((level) => level === glow)
  if (bloom === undefined) throw props.error(`'bloom' must be one of ${BLOOMS.join(", ")}`)
  if (bloom !== "off" && dither === undefined) throw props.error("'bloom' needs dither")
  return { dither, bloom }
}

function chart(props: Props): ChartNode {
  props.allow([
    "type",
    "height",
    "x",
    "series",
    "stacked",
    "horizontal",
    "min",
    "max",
    "unit",
    "prefix",
    "decimals",
    "x_unit",
    "x_decimals",
    "legend",
    "dither",
    "bloom",
  ])
  const type = props.string("type") ?? "bar"
  if (type !== "bar" && type !== "line" && type !== "area" && type !== "scatter")
    throw props.error(`has unknown type '${type}': use bar, line, area, or scatter (draw anything else with ui.canvas)`)
  const x = (props.list("x")?.seq ?? []).map(valueText)
  const series: Series[] = (props.list("series")?.seq ?? []).map((value, index) => {
    if (!isTable(value)) throw props.error(`'series': expected a list of tables, got ${typeName(value)}`)
    const seriesProps = new Props(value, "chart series")
    seriesProps.allow(["name", "values", "points", "color"])
    const values = (seriesProps.list("values")?.seq ?? []).map((item) => {
      if (item === undefined) return null
      if (typeof item !== "number") throw seriesProps.error(`'values': expected numbers, got ${typeName(item)}`)
      return item
    })
    const points = (seriesProps.list("points")?.seq ?? []).map((point): readonly [number, number] => {
      if (!isTable(point)) throw seriesProps.error("'points' is a list of { x, y }")
      const px = point.seq[0] ?? point.keys.get("x")
      const py = point.seq[1] ?? point.keys.get("y")
      if (typeof px !== "number" || typeof py !== "number")
        throw seriesProps.error("'points' is a list of { x, y } numbers")
      return [px, py]
    })
    if (values.length + points.length > 20_000) throw props.error("has more than 20,000 values in a series")
    return {
      name: seriesProps.string("name") ?? "",
      color: seriesProps.color("color") ?? tokenColor(seriesToken(index)),
      values,
      points,
    }
  })
  if (series.length === 0) throw props.error("needs series = { { name = ..., values = { ... } } }")
  if (type === "scatter" && series.every((item) => item.points.length === 0))
    throw props.error("of type scatter needs series with points = { {x, y}, ... }")
  if (type !== "scatter") {
    const longest = Math.max(0, ...series.map((item) => item.values.length))
    if (longest === 0) throw props.error("needs values in its series")
    if (x.length > 2000 || longest > 2000) throw props.error("has more than 2,000 categories")
  }
  const min = props.number("min")
  const max = props.number("max")
  const xDecimals = props.number("x_decimals")
  return {
    kind: "chart",
    type,
    height: clamp(props.number("height") ?? 220, 80, 600),
    x,
    series,
    stacked: props.bool("stacked") ?? false,
    horizontal: props.bool("horizontal") ?? false,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    format: numberFormat(props),
    xFormat: {
      prefix: "",
      unit: props.string("x_unit") ?? "",
      decimals: xDecimals === undefined ? undefined : Math.trunc(clamp(xDecimals, 0, 6)),
    },
    legend: props.bool("legend") ?? true,
    ...dithering(props),
  }
}

const GLSL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/u
const RESERVED_INPUT = /^(i[A-Z]|gl_)/u

function shader(props: Props): NodeKind {
  props.allow([
    "height",
    "code",
    "inputs",
    "animate",
    "orbit",
    "spin",
    "camera",
    "blend",
    "bloom",
    "buffers",
    "textures",
    "transparent",
  ])
  const code = props.raw("code")
  if (code === undefined)
    throw props.error("needs code: GLSL defining void mainImage(out vec4 fragColor, in vec2 fragCoord)")
  if (typeof code !== "string") throw props.error("'code' must be a string of GLSL")
  const buffers = (props.list("buffers")?.seq ?? []).map((buffer) => {
    if (typeof buffer !== "string") throw props.error("'buffers' is a list of GLSL strings")
    return buffer
  })
  if (buffers.length > MAX_BUFFERS) throw props.error(`takes at most ${MAX_BUFFERS} buffers`)
  if (props.raw("textures") !== undefined)
    throw props.error("has no 'textures': assets are not supported in Ingle visuals")
  const blendName = props.string("blend")
  const transparent = props.bool("transparent")
  let blend: Blend = "light"
  if (blendName !== undefined) {
    if (blendName !== "alpha" && blendName !== "light" && blendName !== "opaque")
      throw props.error('\'blend\' is "alpha", "light", or "opaque"')
    blend = blendName
  } else if (transparent !== undefined) blend = transparent ? "alpha" : "opaque"
  const inputs: [string, number][] = []
  const table = props.list("inputs")
  if (table !== undefined) {
    if (table.seq.length > 0) throw props.error("'inputs' maps names to numbers")
    for (const [name, value] of table.keys) {
      if (typeof value !== "number") throw props.error("'inputs' maps names to numbers")
      if (!GLSL_NAME.test(name) || RESERVED_INPUT.test(name))
        throw props.error(`input '${name}' is not a usable GLSL name`)
      inputs.push([name, value])
    }
  }
  if (inputs.length > MAX_INPUTS) throw props.error(`takes at most ${MAX_INPUTS} inputs`)
  inputs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    kind: "shader",
    height: props.height(),
    code,
    buffers,
    inputs,
    animate: props.bool("animate") ?? true,
    orbit: props.bool("orbit") ?? false,
    spin: clamp(props.number("spin") ?? 0, -3, 3),
    camera: props.camera({ yaw: 0, pitch: 0, zoom: 1 }),
    blend,
    bloom: clamp(props.number("bloom") ?? 0, 0, 3),
  }
}
