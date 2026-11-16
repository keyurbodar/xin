// Ported from zeron (https://github.com/zeronsh/zeron), MIT, Copyright (c) 2026 Wing. See plugins/visual/LICENSE-zeron.

import type { DrawCmd, Pointer } from "../runtime/draw.ts"
import type { Node } from "../runtime/node.ts"
import { TEXT_METRICS } from "../runtime/style.ts"
import { cssColor, fontOf } from "./theme.ts"
import { frameLoop, type Widget, type WidgetHost, widthOf } from "./widget.ts"

type CanvasNode = Extract<Node, { kind: "canvas" }>

export function paintCommands(
  context: CanvasRenderingContext2D,
  commands: readonly DrawCmd[],
  color: (cmd: DrawCmd) => string,
): void {
  for (const command of commands) {
    switch (command.kind) {
      case "fill": {
        context.beginPath()
        command.points.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)))
        context.closePath()
        context.fillStyle = color(command)
        context.fill("nonzero")
        break
      }
      case "stroke": {
        context.beginPath()
        command.points.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)))
        if (command.closed) context.closePath()
        context.strokeStyle = color(command)
        context.lineWidth = command.width
        context.lineJoin = "round"
        context.lineCap = "round"
        context.setLineDash(command.dash === undefined ? [] : [command.dash, command.dash])
        context.stroke()
        break
      }
      case "text": {
        context.font = fontOf(command.size, command.weight, command.mono)
        context.fillStyle = color(command)
        context.textAlign = command.align === "start" ? "left" : command.align === "end" ? "right" : "center"
        const [, line] = TEXT_METRICS[command.size]
        context.textBaseline = "middle"
        const y =
          command.baseline === "start"
            ? command.y + line / 2
            : command.baseline === "end"
              ? command.y - line / 2
              : command.y
        context.fillText(command.text, command.x, y)
        break
      }
      default: {
        const _exhaustive: never = command
        return _exhaustive
      }
    }
  }
}

export function canvasWidget(initial: CanvasNode, host: WidgetHost): Widget<CanvasNode> {
  let node = initial
  const element = document.createElement("div")
  element.className = "v-canvas"
  const canvas = document.createElement("canvas")
  element.append(canvas)
  const context = canvas.getContext("2d")
  let width = 0
  let pointer: Pointer | undefined
  let readsPointer = false
  let failed = false
  let start: number | undefined

  const paint = (time: number): boolean => {
    if (context === null || width === 0 || failed) return false
    start ??= time
    const theme = host.theme()
    const ratio = window.devicePixelRatio || 1
    const pixelWidth = Math.round(width * ratio)
    const pixelHeight = Math.round(node.height * ratio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    canvas.style.height = `${node.height}px`
    try {
      const drawing = host.visual.drawCanvas(node.draw, width, node.height, node.animate ? time - start : 0, pointer)
      readsPointer = drawing.readsPointer
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, node.height)
      paintCommands(context, drawing.commands, (command) => cssColor(command.color, theme))
    } catch (error) {
      failed = true
      host.fail(error)
      return false
    }
    return node.animate
  }

  const loop = frameLoop(element, paint)
  const stopWidth = widthOf(element, (next) => {
    width = next
    loop.kick()
  })

  const local = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  canvas.addEventListener("pointermove", (event) => {
    pointer = { ...local(event), down: (event.buttons & 1) === 1 }
    if (readsPointer) loop.kick()
  })
  canvas.addEventListener("pointerdown", (event) => {
    pointer = { ...local(event), down: true }
    if (readsPointer) {
      canvas.setPointerCapture(event.pointerId)
      loop.kick()
    }
  })
  canvas.addEventListener("pointerup", (event) => {
    pointer = { ...local(event), down: false }
    if (readsPointer) loop.kick()
  })
  canvas.addEventListener("pointerleave", () => {
    pointer = undefined
    if (readsPointer) loop.kick()
  })
  canvas.addEventListener("click", (event) => {
    if (node.onClick === undefined) return
    const { x, y } = local(event)
    host.call(node.onClick, { kind: "point", x, y })
  })

  const sync = (): void => {
    canvas.style.cursor = node.onClick === undefined ? "" : "pointer"
    canvas.style.touchAction = readsPointer ? "none" : ""
  }
  sync()

  return {
    element,
    update(next) {
      node = next
      failed = false
      sync()
      loop.kick()
    },
    repaint: () => loop.kick(),
    destroy() {
      loop.stop()
      stopWidth()
    },
  }
}
