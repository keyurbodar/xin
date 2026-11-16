import { type HandlerArg, seedFor, Visual } from "../runtime/lua.ts"
import type { HandlerId, Node } from "../runtime/node.ts"
import { TOKEN_NAMES } from "../runtime/style.ts"
import type { FrameMessage, FrameTheme, HostMessage } from "./protocol.ts"
import { Renderer } from "./render.ts"
import { FRAME_CSS } from "./styles.ts"
import type { WidgetHost } from "./widget.ts"

const post = (message: FrameMessage): void => parent.postMessage(message, "*")

const style = document.createElement("style")
style.textContent = FRAME_CSS
document.head.append(style)
const root = document.createElement("div")
root.id = "root"
const errorLine = document.createElement("div")
errorLine.className = "v-error"
errorLine.hidden = true
document.body.append(root, errorLine)

let theme: FrameTheme | undefined
let visual: Visual | undefined
let script = ""
let seed = 0
let tree: Node | undefined

const host: WidgetHost = {
  get visual(): Visual {
    if (visual === undefined) throw new Error("no visual loaded")
    return visual
  },
  theme: () => {
    if (theme === undefined) throw new Error("no theme")
    return theme
  },
  call: (id: HandlerId, arg: HandlerArg) => {
    if (visual === undefined) return
    try {
      visual.call(id, arg)
      draw(visual.render())
    } catch (error) {
      fail(error)
    }
  },
  fail: (error: unknown) => fail(error),
}

const renderer = new Renderer(root, host)

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  errorLine.textContent = message
  errorLine.hidden = false
  post({ kind: "state", state: "error", error: message })
}

function draw(next: Node): void {
  tree = next
  errorLine.hidden = true
  renderer.render(next)
}

function applyTheme(next: FrameTheme): void {
  theme = next
  const rootStyle = document.documentElement.style
  for (const token of TOKEN_NAMES) rootStyle.setProperty(`--${token}`, next.colors[token])
  document.documentElement.dataset.scheme = next.scheme
  if (next.reduceMotion) document.documentElement.dataset.motion = "reduce"
  else delete document.documentElement.dataset.motion
}

function show(message: Extract<HostMessage, { kind: "show" }>): void {
  applyTheme(message.theme)
  const nextSeed = seedFor(message.id)
  if (message.script === script && nextSeed === seed && visual !== undefined) {
    if (!message.streaming) post({ kind: "state", state: errorLine.hidden ? "shown" : "error" })
    return
  }
  try {
    const next = Visual.load(message.script, nextSeed)
    const rendered = next.render()
    visual = next
    script = message.script
    seed = nextSeed
    draw(rendered)
    post({ kind: "state", state: message.streaming ? "drawing" : "shown" })
  } catch (error) {
    if (message.streaming) {
      post({ kind: "state", state: "drawing" })
      return
    }
    fail(error)
  }
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.source !== parent) return
  const message = event.data
  switch (message.kind) {
    case "show":
      show(message)
      return
    case "theme":
      applyTheme(message.theme)
      if (visual !== undefined && tree !== undefined) {
        try {
          draw(visual.render())
        } catch (error) {
          fail(error)
        }
      }
      renderer.repaint()
      return
    case "font": {
      const face = new FontFace(message.family, message.data, { weight: message.weight })
      void face.load().then(() => {
        document.fonts.add(face)
        renderer.repaint()
      })
      return
    }
    default: {
      const _exhaustive: never = message
      return _exhaustive
    }
  }
})

let lastHeight = -1
new ResizeObserver(() => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height)
  if (height === lastHeight) return
  lastHeight = height
  post({ kind: "size", height })
}).observe(document.body)

post({ kind: "ready" })
