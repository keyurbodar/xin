// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import type { ChartNode, Series } from "../runtime/node.ts"
import { formatNumber, niceTicks } from "../runtime/style.ts"
import type { FrameTheme } from "./protocol.ts"
import { cssColor, tokenCss } from "./theme.ts"
import type { Widget, WidgetHost } from "./widget.ts"
import { widthOf } from "./widget.ts"

const SVG = "http://www.w3.org/2000/svg"
const HEADER = 22
const X_AXIS = 22
const LABEL_FONT = 11
const CHAR = 6.4

type Hover = { readonly index: number; readonly series?: number } | undefined

type Frame = { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

function label(x: number, y: number, text: string, anchor: "start" | "middle" | "end", fill: string): SVGTextElement {
  const node = el("text", { x, y, "text-anchor": anchor, "dominant-baseline": "middle", fill, "font-size": LABEL_FONT })
  node.textContent = text
  return node
}

function domain(node: ChartNode): [number, number] {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  const take = (value: number): void => {
    low = Math.min(low, value)
    high = Math.max(high, value)
  }
  if (node.type === "scatter") for (const series of node.series) for (const [, y] of series.points) take(y)
  else if (node.stacked) {
    const length = Math.max(...node.series.map((series) => series.values.length))
    for (let index = 0; index < length; index += 1) {
      let up = 0
      let down = 0
      for (const series of node.series) {
        const value = series.values[index] ?? 0
        if (value >= 0) up += value
        else down += value
      }
      take(up)
      take(down)
    }
  } else for (const series of node.series) for (const value of series.values) if (value !== null) take(value)
  if (!Number.isFinite(low)) [low, high] = [0, 1]
  if (node.type !== "scatter" && node.type !== "line") {
    low = Math.min(low, 0)
    high = Math.max(high, 0)
  }
  if (node.min !== undefined) low = node.min
  if (node.max !== undefined) high = node.max
  if (low === high) high = low + 1
  return [low, high]
}

function xDomain(series: readonly Series[]): [number, number] {
  const xs = series.flatMap((item) => item.points.map(([x]) => x))
  if (xs.length === 0) return [0, 1]
  const low = Math.min(...xs)
  const high = Math.max(...xs)
  return low === high ? [low - 1, high + 1] : [low, high]
}

export function chartWidget(initial: ChartNode, host: WidgetHost): Widget<ChartNode> {
  let node = initial
  let width = 0
  let hover: Hover
  const element = document.createElement("div")
  element.className = "v-chart"
  const svg = el("svg", { role: "img" })
  element.append(svg)

  const categories = (): number =>
    node.type === "scatter" ? 0 : Math.max(node.x.length, ...node.series.map((s) => s.values.length))

  const draw = (): void => {
    if (width === 0) return
    const theme = host.theme()
    const muted = tokenCss("muted", theme)
    const faint = tokenCss("faint", theme)
    const border = tokenCss("border", theme)
    const text = tokenCss("text", theme)
    svg.replaceChildren()
    svg.setAttribute("width", String(width))
    svg.setAttribute("height", String(node.height))
    svg.setAttribute("viewBox", `0 0 ${width} ${node.height}`)
    svg.setAttribute("font-family", "inherit")

    const [low, high] = domain(node)
    const ticks = niceTicks(low, high, Math.max(2, Math.round((node.height - HEADER - X_AXIS) / 48)))
    const yLow = Math.min(low, ticks[0] ?? low)
    const yHigh = Math.max(high, ticks.at(-1) ?? high)
    const tickText = ticks.map((tick) => formatNumber(node.format, tick))
    const count = categories()

    const horizontal = node.type === "bar" && node.horizontal
    const categoryText = node.x
    const left = horizontal
      ? Math.min(width * 0.35, 8 + CHAR * Math.max(1, ...categoryText.map((item) => item.length)))
      : 8 + CHAR * Math.max(1, ...tickText.map((item) => item.length))
    const frame: Frame = {
      left,
      top: HEADER,
      width: Math.max(10, width - left - 4),
      height: node.height - HEADER - X_AXIS,
    }
    const valueToY = (value: number): number =>
      frame.top + frame.height - ((value - yLow) / (yHigh - yLow)) * frame.height
    const valueToX = (value: number): number => frame.left + ((value - yLow) / (yHigh - yLow)) * frame.width

    const grid = el("g", {})
    ticks.forEach((tick, index) => {
      if (horizontal) {
        const x = valueToX(tick)
        grid.append(
          el("line", { x1: x, x2: x, y1: frame.top, y2: frame.top + frame.height, stroke: border, "stroke-width": 1 }),
        )
        grid.append(label(x, frame.top + frame.height + 12, tickText[index] ?? "", "middle", muted))
      } else {
        const y = valueToY(tick)
        grid.append(
          el("line", { x1: frame.left, x2: frame.left + frame.width, y1: y, y2: y, stroke: border, "stroke-width": 1 }),
        )
        grid.append(label(frame.left - 6, y, tickText[index] ?? "", "end", muted))
      }
    })
    svg.append(grid)

    const colorOf = (series: Series): string => cssColor(series.color, theme)
    const marks = el("g", {})
    const band = (horizontal ? frame.height : frame.width) / Math.max(1, count)
    const centerOf = (index: number): number => (horizontal ? frame.top : frame.left) + band * (index + 0.5)

    if (node.type === "scatter") {
      const [xLow, xHigh] = xDomain(node.series)
      const xTicks = niceTicks(xLow, xHigh, Math.max(2, Math.round(frame.width / 90)))
      const x0 = Math.min(xLow, xTicks[0] ?? xLow)
      const x1 = Math.max(xHigh, xTicks.at(-1) ?? xHigh)
      const toX = (value: number): number => frame.left + ((value - x0) / (x1 - x0)) * frame.width
      for (const tick of xTicks)
        grid.append(label(toX(tick), frame.top + frame.height + 12, formatNumber(node.xFormat, tick), "middle", muted))
      node.series.forEach((series, seriesIndex) => {
        series.points.forEach(([x, y], pointIndex) => {
          const active = hover?.series === seriesIndex && hover.index === pointIndex
          marks.append(
            el("circle", {
              cx: toX(x),
              cy: valueToY(y),
              r: active ? 4.5 : 3,
              fill: colorOf(series),
              "fill-opacity": active ? 1 : 0.85,
            }),
          )
        })
      })
      svg.append(marks)
      hit(svg, frame, (px, py) => {
        let best: Hover
        let distance = 24 * 24
        node.series.forEach((series, seriesIndex) =>
          series.points.forEach(([x, y], index) => {
            const d = (toX(x) - px) ** 2 + (valueToY(y) - py) ** 2
            if (d < distance) {
              distance = d
              best = { index, series: seriesIndex }
            }
          }),
        )
        return best
      })
    } else if (node.type === "bar") {
      const groups = node.stacked ? 1 : node.series.length
      const inner = band * 0.72
      const thickness = inner / groups
      const zero = horizontal
        ? valueToX(Math.max(yLow, Math.min(0, yHigh)))
        : valueToY(Math.max(yLow, Math.min(0, yHigh)))
      for (let index = 0; index < count; index += 1) {
        let up = 0
        let down = 0
        node.series.forEach((series, seriesIndex) => {
          const value = series.values[index]
          if (value === null || value === undefined) return
          let from = 0
          let to = value
          if (node.stacked) {
            from = value >= 0 ? up : down
            to = from + value
            if (value >= 0) up = to
            else down = to
          }
          const offset = node.stacked ? 0 : seriesIndex * thickness
          const start = centerOf(index) - inner / 2 + offset
          const a = horizontal ? valueToX(from) : valueToY(from)
          const b = horizontal ? valueToX(to) : valueToY(to)
          const lo = Math.min(a, b)
          const size = Math.max(1, Math.abs(b - a))
          const dim = hover !== undefined && hover.index !== index
          const rect = horizontal
            ? el("rect", { x: lo, y: start, width: size, height: Math.max(1, thickness - 1), rx: 2 })
            : el("rect", { x: start, y: lo, width: Math.max(1, thickness - 1), height: size, rx: 2 })
          rect.setAttribute("fill", colorOf(series))
          rect.setAttribute("fill-opacity", dim ? "0.45" : "1")
          marks.append(rect)
        })
      }
      marks.append(
        horizontal
          ? el("line", {
              x1: zero,
              x2: zero,
              y1: frame.top,
              y2: frame.top + frame.height,
              stroke: faint,
              "stroke-width": 1,
            })
          : el("line", {
              x1: frame.left,
              x2: frame.left + frame.width,
              y1: zero,
              y2: zero,
              stroke: faint,
              "stroke-width": 1,
            }),
      )
      svg.append(marks)
      categoryLabels(svg, node.x, count, band, centerOf, frame, horizontal, muted)
      hit(svg, frame, (px, py) => {
        const along = horizontal ? py - frame.top : px - frame.left
        const index = Math.floor(along / band)
        return index >= 0 && index < count ? { index } : undefined
      })
    } else {
      const xOf = (index: number): number =>
        count <= 1 ? frame.left + frame.width / 2 : frame.left + (frame.width * index) / (count - 1)
      const base: number[] = Array.from({ length: count }, () => 0)
      node.series.forEach((series) => {
        const segments: [number, number, number][][] = [[]]
        for (let index = 0; index < count; index += 1) {
          const value = series.values[index]
          if (value === null || value === undefined) {
            if ((segments.at(-1)?.length ?? 0) > 0) segments.push([])
            continue
          }
          const from = node.stacked ? (base[index] ?? 0) : Math.max(yLow, Math.min(0, yHigh))
          const to = node.stacked ? from + value : value
          if (node.stacked) base[index] = to
          segments.at(-1)?.push([xOf(index), valueToY(to), valueToY(node.type === "area" ? from : to)])
        }
        const color = colorOf(series)
        for (const segment of segments) {
          if (segment.length === 0) continue
          const line = segment
            .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
            .join("")
          if (node.type === "area") {
            const back = segment
              .toReversed()
              .map(([x, , y]) => `L${x.toFixed(2)},${y.toFixed(2)}`)
              .join("")
            marks.append(el("path", { d: `${line}${back}Z`, fill: color, "fill-opacity": 0.18 }))
          }
          marks.append(
            el("path", {
              d: line,
              fill: "none",
              stroke: color,
              "stroke-width": 2,
              "stroke-linejoin": "round",
              "stroke-linecap": "round",
            }),
          )
          if (segment.length === 1) {
            const [x, y] = segment[0] ?? [0, 0]
            marks.append(el("circle", { cx: x, cy: y, r: 2.5, fill: color }))
          }
        }
      })
      if (hover !== undefined) {
        const x = xOf(hover.index)
        marks.append(
          el("line", { x1: x, x2: x, y1: frame.top, y2: frame.top + frame.height, stroke: faint, "stroke-width": 1 }),
        )
        const stack: number[] = Array.from({ length: node.series.length }, () => 0)
        let running = 0
        node.series.forEach((series, seriesIndex) => {
          const value = series.values[hover?.index ?? 0]
          if (value === null || value === undefined) return
          running = node.stacked ? running + value : value
          stack[seriesIndex] = running
          marks.append(
            el("circle", {
              cx: x,
              cy: valueToY(running),
              r: 3.5,
              fill: colorOf(series),
              stroke: tokenCss("text", theme),
              "stroke-width": 0,
            }),
          )
        })
      }
      svg.append(marks)
      categoryLabels(svg, node.x, count, count <= 1 ? frame.width : frame.width / (count - 1), xOf, frame, false, muted)
      hit(svg, frame, (px) => {
        if (count === 0) return undefined
        const index = count <= 1 ? 0 : Math.round(((px - frame.left) / frame.width) * (count - 1))
        return { index: Math.max(0, Math.min(count - 1, index)) }
      })
    }

    header(svg, node, hover, width, theme, text, muted)
  }

  const hit = (target: SVGSVGElement, frame: Frame, pick: (x: number, y: number) => Hover): void => {
    const area = el("rect", {
      x: frame.left,
      y: frame.top,
      width: frame.width,
      height: frame.height,
      fill: "transparent",
    })
    target.append(area)
    area.addEventListener("pointermove", (event) => {
      const rect = target.getBoundingClientRect()
      const next = pick(event.clientX - rect.left, event.clientY - rect.top)
      if (next?.index === hover?.index && next?.series === hover?.series) return
      hover = next
      draw()
    })
    area.addEventListener("pointerleave", () => {
      if (hover === undefined) return
      hover = undefined
      draw()
    })
  }

  const stopWidth = widthOf(element, (next) => {
    width = next
    draw()
  })

  return {
    element,
    update(next) {
      node = next
      draw()
    },
    repaint: draw,
    destroy: stopWidth,
  }
}

function categoryLabels(
  svg: SVGSVGElement,
  labels: readonly string[],
  count: number,
  step: number,
  centerOf: (index: number) => number,
  frame: Frame,
  horizontal: boolean,
  fill: string,
): void {
  const widest = CHAR * Math.max(1, ...labels.map((item) => item.length)) + 8
  const every = horizontal
    ? Math.max(1, Math.ceil(16 / Math.max(1, step)))
    : Math.max(1, Math.ceil(widest / Math.max(1, step)))
  for (let index = 0; index < count; index += every) {
    const text = labels[index]
    if (text === undefined) continue
    if (horizontal) svg.append(label(frame.left - 6, centerOf(index), text, "end", fill))
    else svg.append(label(centerOf(index), frame.top + frame.height + 12, text, "middle", fill))
  }
}

function header(
  svg: SVGSVGElement,
  node: ChartNode,
  hover: Hover,
  width: number,
  theme: FrameTheme,
  text: string,
  muted: string,
): void {
  const y = 9
  let x = 0
  if (node.legend && node.series.length > 1) {
    for (const series of node.series) {
      svg.append(el("rect", { x, y: y - 4, width: 8, height: 8, rx: 2, fill: cssColor(series.color, theme) }))
      const name = label(x + 12, y, series.name, "start", muted)
      svg.append(name)
      x += 12 + CHAR * series.name.length + 14
    }
  }
  if (hover === undefined) return
  let readout = ""
  if (node.type === "scatter") {
    const series = node.series[hover.series ?? 0]
    const point = series?.points[hover.index]
    if (series !== undefined && point !== undefined)
      readout = `${series.name === "" ? "" : `${series.name}  `}${formatNumber(node.xFormat, point[0])}, ${formatNumber(node.format, point[1])}`
  } else {
    const parts = node.series
      .map((series) => {
        const value = series.values[hover.index]
        if (value === null || value === undefined) return undefined
        return `${series.name === "" ? "" : `${series.name} `}${formatNumber(node.format, value)}`
      })
      .filter((part): part is string => part !== undefined)
    readout = `${node.x[hover.index] ?? ""}${parts.length > 0 ? "  ·  " : ""}${parts.join("  ")}`
  }
  svg.append(label(width - 2, y, readout, "end", text))
}
