// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import type { Node, TextNode } from "../runtime/node.ts"
import { formatNumber, TEXT_METRICS } from "../runtime/style.ts"
import { canvasWidget } from "./canvas.ts"
import { chartWidget } from "./chart.ts"
import { sceneWidget, shaderWidget } from "./gl-widgets.ts"
import { cssColor } from "./theme.ts"
import type { Widget, WidgetHost } from "./widget.ts"

type Stateful = Extract<Node, { kind: "chart" | "canvas" | "scene" | "shader" | "slider" }>

type Entry = { readonly kind: Stateful["kind"]; readonly widget: Widget<Stateful>; used: boolean }

const ALIGN = { start: "flex-start", center: "center", end: "flex-end" } as const
const JUSTIFY = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" } as const

function create(node: Stateful, host: WidgetHost): Widget<Stateful> {
  switch (node.kind) {
    case "chart": {
      const widget = chartWidget(node, host)
      return { ...widget, update: (next) => next.kind === "chart" && widget.update(next) }
    }
    case "canvas": {
      const widget = canvasWidget(node, host)
      return { ...widget, update: (next) => next.kind === "canvas" && widget.update(next) }
    }
    case "scene": {
      const widget = sceneWidget(node, host)
      return { ...widget, update: (next) => next.kind === "scene" && widget.update(next) }
    }
    case "shader": {
      const widget = shaderWidget(node, host)
      return { ...widget, update: (next) => next.kind === "shader" && widget.update(next) }
    }
    case "slider": {
      const widget = sliderWidget(node, host)
      return { ...widget, update: (next) => next.kind === "slider" && widget.update(next) }
    }
    default: {
      const _exhaustive: never = node
      return _exhaustive
    }
  }
}

/** Renders a view tree into DOM. Charts, canvases, scenes, shaders and sliders keep their element (and hover, camera, drag) across renders by key or position. */
export class Renderer {
  private widgets = new Map<string, Entry>()

  constructor(
    private readonly root: HTMLElement,
    private readonly host: WidgetHost,
  ) {}

  render(tree: Node): void {
    for (const entry of this.widgets.values()) entry.used = false
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.id : undefined
    const element = this.node(tree, "r")
    this.root.replaceChildren(element)
    for (const [id, entry] of this.widgets) {
      if (entry.used) continue
      entry.widget.destroy()
      this.widgets.delete(id)
    }
    if (focused !== undefined) this.root.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`)?.focus()
  }

  repaint(): void {
    for (const entry of this.widgets.values()) entry.widget.repaint()
  }

  destroy(): void {
    for (const entry of this.widgets.values()) entry.widget.destroy()
    this.widgets.clear()
  }

  private stateful(node: Stateful, id: string): HTMLElement {
    const existing = this.widgets.get(id)
    if (existing !== undefined && existing.kind === node.kind && !existing.used) {
      existing.used = true
      existing.widget.update(node)
      return existing.widget.element
    }
    const widget = create(node, this.host)
    this.widgets.set(id, { kind: node.kind, widget, used: true })
    return widget.element
  }

  private node(node: Node, path: string): HTMLElement {
    const id = node.key === undefined ? path : `k:${node.key}`
    const element = this.body(node, id, path)
    if (node.width !== undefined) {
      element.style.width = `${node.width}px`
      element.style.flex = "none"
    } else if (node.grow) element.style.flex = "1 1 0"
    return element
  }

  private body(node: Node, id: string, path: string): HTMLElement {
    const host = this.host
    switch (node.kind) {
      case "stack": {
        const element = div(node.axis === "horizontal" ? "v-row" : "v-column")
        element.style.gap = `${node.gap}px`
        element.style.alignItems =
          node.axis === "horizontal" ? ALIGN[node.align] : node.align === "start" ? "stretch" : ALIGN[node.align]
        element.style.justifyContent = JUSTIFY[node.justify]
        if (node.wrap) element.style.flexWrap = "wrap"
        if (node.hover || node.onClick !== undefined) element.classList.add("v-hover")
        const onClick = node.onClick
        if (onClick !== undefined) {
          element.classList.add("v-clickable")
          element.tabIndex = 0
          element.dataset.id = id
          element.setAttribute("role", "button")
          element.addEventListener("click", () => host.call(onClick, { kind: "none" }))
          element.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            host.call(onClick, { kind: "none" })
          })
        }
        node.children.forEach((child, index) => element.append(this.node(child, `${path}.${index}`)))
        return element
      }
      case "grid": {
        const element = div("v-grid")
        element.style.gap = `${node.gap}px`
        element.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(100%, max(140px, calc((100% - ${node.gap * (node.columns - 1)}px) / ${node.columns}))), 1fr))`
        node.children.forEach((child, index) => element.append(this.node(child, `${path}.${index}`)))
        return element
      }
      case "text":
        return text(node, host)
      case "rule":
        return div("v-rule")
      case "space": {
        const element = div("v-space")
        element.style.height = `${node.size}px`
        element.style.width = `${node.size}px`
        return element
      }
      case "stat": {
        const element = div("v-stat")
        const value = div("v-stat-value")
        value.textContent = node.value
        if (node.delta !== undefined) {
          const delta = document.createElement("span")
          delta.className = "v-stat-delta"
          delta.textContent = node.delta
          if (node.tone !== undefined) delta.style.color = cssColor(node.tone, host.theme())
          value.append(delta)
        }
        const label = div("v-stat-label")
        label.textContent = node.label
        element.append(value, label)
        return element
      }
      case "table": {
        const wrap = div("v-table")
        const table = document.createElement("table")
        const numeric = node.columns.map((column, index) =>
          column.align !== "start"
            ? column.align
            : node.rows.length > 0 && node.rows.every((row) => isNumeric(row[index]))
              ? "end"
              : "start",
        )
        if (node.columns.length > 0) {
          const head = document.createElement("thead")
          const row = document.createElement("tr")
          node.columns.forEach((column, index) => {
            const cell = document.createElement("th")
            cell.textContent = column.label
            cell.style.textAlign = CELL[numeric[index] ?? "start"]
            if (column.width !== undefined) cell.style.width = `${column.width}px`
            row.append(cell)
          })
          head.append(row)
          table.append(head)
        }
        const body = document.createElement("tbody")
        node.rows.forEach((cells, rowIndex) => {
          const row = document.createElement("tr")
          if (node.hover) row.classList.add("v-hover")
          cells.forEach((cell, index) => {
            const td = document.createElement("td")
            td.style.textAlign = CELL[numeric[index] ?? (isNumeric(cell) ? "end" : "start")]
            td.append(this.node(cell, `${path}.t${rowIndex}.${index}`))
            row.append(td)
          })
          body.append(row)
        })
        table.append(body)
        wrap.append(table)
        return wrap
      }
      case "chart":
      case "canvas":
      case "scene":
      case "shader":
      case "slider":
        return this.stateful(node, id)
      case "button": {
        const button = document.createElement("button")
        button.type = "button"
        button.className = node.primary ? "v-button v-primary" : "v-button"
        button.textContent = node.label
        button.dataset.id = id
        const onClick = node.onClick
        button.addEventListener("click", () => host.call(onClick, { kind: "none" }))
        return button
      }
      case "tabs": {
        const element = div("v-tabs")
        element.setAttribute("role", "tablist")
        const onChange = node.onChange
        node.options.forEach((option, index) => {
          const tab = document.createElement("button")
          tab.type = "button"
          tab.className = "v-tab"
          tab.setAttribute("role", "tab")
          tab.setAttribute("aria-selected", String(option === node.value))
          tab.tabIndex = option === node.value ? 0 : -1
          tab.textContent = option
          tab.dataset.id = `${id}#${index}`
          tab.addEventListener("click", () => host.call(onChange, { kind: "text", value: option }))
          tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
            event.preventDefault()
            const next =
              node.options[(index + (event.key === "ArrowRight" ? 1 : -1) + node.options.length) % node.options.length]
            if (next === undefined) return
            host.call(onChange, { kind: "text", value: next })
            element.parentElement
              ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(`${id}#${node.options.indexOf(next)}`)}"]`)
              ?.focus()
          })
          element.append(tab)
        })
        return element
      }
      case "toggle": {
        const label = document.createElement("label")
        label.className = "v-toggle"
        const input = document.createElement("input")
        input.type = "checkbox"
        input.setAttribute("role", "switch")
        input.checked = node.value
        input.dataset.id = id
        const onChange = node.onChange
        input.addEventListener("change", () => host.call(onChange, { kind: "bool", value: input.checked }))
        const track = document.createElement("span")
        track.className = "v-switch"
        const caption = document.createElement("span")
        caption.textContent = node.label
        label.append(input, track, caption)
        return label
      }
      case "link": {
        const link = document.createElement("a")
        link.className = "v-link"
        link.href = node.url
        link.textContent = node.label
        link.dataset.id = id
        link.addEventListener("click", (event) => {
          event.preventDefault()
          parent.postMessage({ kind: "open", url: node.url }, "*")
        })
        return link
      }
      default: {
        const _exhaustive: never = node
        return _exhaustive
      }
    }
  }
}

const CELL = { start: "left", center: "center", end: "right" } as const

function isNumeric(cell: Node | undefined): boolean {
  if (cell === undefined || cell.kind !== "text") return false
  const content = cell.spans
    .map((span) => span.text)
    .join("")
    .trim()
  return content !== "" && /^[-+$€£¥]?[\d,.]+\s?%?[a-zA-Z%]*$/u.test(content)
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div")
  element.className = className
  return element
}

function text(node: TextNode, host: WidgetHost): HTMLElement {
  const theme = host.theme()
  const element = div("v-text")
  const [size, line] = TEXT_METRICS[node.size]
  element.style.fontSize = `${size}px`
  element.style.lineHeight = `${line}px`
  element.style.fontWeight = String(node.weight)
  element.style.textAlign = node.align === "start" ? "left" : node.align === "end" ? "right" : "center"
  if (node.color !== undefined) element.style.color = cssColor(node.color, theme)
  if (node.mono) element.classList.add("v-mono")
  if (node.italic) element.style.fontStyle = "italic"
  if (node.truncate) element.classList.add("v-truncate")
  if (node.size === "lg" || node.size === "xl" || node.size === "2xl") element.classList.add("v-heading")
  for (const span of node.spans) {
    if (span.weight === undefined && span.color === undefined && !span.mono && !span.italic) {
      element.append(span.text)
      continue
    }
    const part = document.createElement("span")
    part.textContent = span.text
    if (span.weight !== undefined) part.style.fontWeight = String(span.weight)
    if (span.color !== undefined) part.style.color = cssColor(span.color, theme)
    if (span.mono) part.classList.add("v-mono")
    if (span.italic) part.style.fontStyle = "italic"
    element.append(part)
  }
  return element
}

type SliderNode = Extract<Node, { kind: "slider" }>

function sliderWidget(initial: SliderNode, host: WidgetHost): Widget<SliderNode> {
  let node = initial
  const element = div("v-slider")
  const head = div("v-slider-head")
  const label = document.createElement("span")
  const value = document.createElement("span")
  value.className = "v-slider-value"
  head.append(label, value)
  const input = document.createElement("input")
  input.type = "range"
  let pending: number | undefined
  let frame = 0
  input.addEventListener("input", () => {
    pending = Number(input.value)
    value.textContent = formatNumber(node.format, pending)
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (pending === undefined) return
      const next = pending
      pending = undefined
      host.call(node.onChange, { kind: "number", value: next })
    })
  })
  element.append(head, input)
  const sync = (): void => {
    label.textContent = node.label ?? ""
    input.setAttribute("aria-label", node.label ?? "value")
    input.min = String(node.min)
    input.max = String(node.max)
    input.step = node.step > 0 ? String(node.step) : "any"
    if (pending === undefined) input.value = String(node.value)
    value.textContent = formatNumber(node.format, pending ?? node.value)
    const fill = ((Number(input.value) - node.min) / (node.max - node.min)) * 100
    input.style.setProperty("--fill", `${Math.max(0, Math.min(100, fill))}%`)
  }
  sync()
  return {
    element,
    update(next) {
      node = next
      sync()
    },
    repaint: sync,
    destroy: () => cancelAnimationFrame(frame),
  }
}
