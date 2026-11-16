import { Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import interWoff from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url"
import type { FrameMessage, FrameTheme, HostMessage } from "../../../../plugins/visual/frame/protocol.ts"
import { TOKEN_NAMES, type Token } from "../../../../plugins/visual/runtime/style.ts"
import { CopyButton } from "./code-block.tsx"
import { BLOCK_LIMIT, Expandable, Fullscreen, FullscreenButton } from "./expandable.tsx"
import type { BlockPayloads } from "./registry.ts"

const STREAM_MS = 150

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data: blob:; img-src data: blob:"

const TOKEN_SOURCE: Readonly<Record<Token, string>> = {
  text: "ink",
  muted: "ink-2",
  faint: "ink-3",
  accent: "accent",
  "on-accent": "on-accent",
  success: "done",
  warning: "working",
  danger: "failed",
  border: "line-2",
  chart1: "accent",
  chart2: "merged",
  chart3: "done",
  chart4: "working",
  chart5: "failed",
  chart6: "ink-2",
}

let frameScript: Promise<string> | undefined
let interFont: Promise<ArrayBuffer | undefined> | undefined

const loadFrame = (): Promise<string> => (frameScript ??= import("virtual:visual-frame").then((module) => module.default))

const loadFont = (): Promise<ArrayBuffer | undefined> =>
  (interFont ??= fetch(interWoff)
    .then((response) => (response.ok ? response.arrayBuffer() : undefined))
    .catch(() => undefined))

function srcdoc(script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${script}</script></body></html>`
}

function currentTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement)
  const colors: Record<Token, string> = { ...TOKEN_SOURCE }
  for (const token of TOKEN_NAMES) colors[token] = style.getPropertyValue(`--color-${TOKEN_SOURCE[token]}`).trim()
  return {
    scheme: style.colorScheme.includes("light") ? "light" : "dark",
    colors,
    reduceMotion:
      document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches,
  }
}

function frameMessage(value: unknown): FrameMessage | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) return undefined
  const record: Record<string, unknown> = { ...value }
  switch (record.kind) {
    case "ready":
      return { kind: "ready" }
    case "size":
      return typeof record.height === "number" && Number.isFinite(record.height)
        ? { kind: "size", height: record.height }
        : undefined
    case "state": {
      const state = record.state
      if (state !== "drawing" && state !== "shown" && state !== "error") return undefined
      return typeof record.error === "string" ? { kind: "state", state, error: record.error } : { kind: "state", state }
    }
    case "open":
      return typeof record.url === "string" && /^https?:\/\//u.test(record.url) ? { kind: "open", url: record.url } : undefined
    default:
      return undefined
  }
}

const scriptOf = (args: Record<string, unknown>): string => (typeof args.script === "string" ? args.script : "")
const titleOf = (args: Record<string, unknown>): string =>
  typeof args.title === "string" && args.title !== "" ? args.title : "Visual"

/** One sandboxed frame running a visual script: no network, no access to this page, theme tokens only, height from its content. */
function VisualFrame(props: { id: string; script: string; streaming: boolean; title: string }): JSX.Element {
  const [doc, setDoc] = createSignal<string>()
  const [height, setHeight] = createSignal(0)
  const [state, setState] = createSignal<"drawing" | "shown" | "error">("drawing")
  let iframe: HTMLIFrameElement | undefined
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSent = 0

  const send = (message: HostMessage): void => iframe?.contentWindow?.postMessage(message, "*")

  const show = (): void => {
    if (!ready) return
    lastSent = Date.now()
    send({ kind: "show", id: props.id, script: props.script, streaming: props.streaming, theme: currentTheme() })
  }

  const schedule = (): void => {
    clearTimeout(timer)
    if (!props.streaming) return show()
    const wait = Math.max(0, STREAM_MS - (Date.now() - lastSent))
    timer = setTimeout(show, wait)
  }

  onMount(() => {
    void loadFrame().then((script) => setDoc(srcdoc(script)))
    const onMessage = (event: MessageEvent): void => {
      if (iframe === undefined || event.source !== iframe.contentWindow) return
      const message = frameMessage(event.data)
      if (message === undefined) return
      switch (message.kind) {
        case "ready":
          ready = true
          show()
          void loadFont().then((data) => {
            if (data !== undefined) send({ kind: "font", family: "Inter Variable", data, weight: "100 900" })
          })
          return
        case "size":
          setHeight(message.height)
          return
        case "state":
          setState(message.state)
          return
        case "open":
          window.open(message.url, "_blank", "noopener,noreferrer")
          return
        default: {
          const _exhaustive: never = message
          return _exhaustive
        }
      }
    }
    window.addEventListener("message", onMessage)
    const observer = new MutationObserver(() => {
      if (ready) send({ kind: "theme", theme: currentTheme() })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-motion", "class", "style"] })
    onCleanup(() => {
      clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener("message", onMessage)
    })
  })

  createEffect(on([() => props.script, () => props.streaming], schedule, { defer: true }))

  return (
    <div class="relative" data-visual-state={state()}>
      <Show when={height() === 0}>
        <div class="flex h-10 items-center gap-2 font-mono text-2xs text-ink-3">
          <span class="visual-pulse h-1.5 w-1.5 rounded-full bg-ink-3" />
          Drawing {props.title.toLowerCase()}
        </div>
      </Show>
      <Show when={doc()}>
        {(content) => (
          <iframe
            ref={iframe}
            title={props.title}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            srcdoc={content()}
            class="block w-full border-0 bg-transparent"
            style={{ height: height() === 0 ? "0px" : `${height()}px` }}
          />
        )}
      </Show>
    </div>
  )
}

export function VisualBlock(props: BlockPayloads["tool"]): JSX.Element {
  const [full, setFull] = createSignal(false)
  const streaming = (): boolean => props.status === "streaming"
  return (
    <Show when={props.status !== "error" && (streaming() || scriptOf(props.args) !== "")}>
      <div class="group/visual relative" data-block="visual">
        <div class="pointer-events-none absolute top-0 right-0 z-10 flex items-center gap-1 text-ink-3 opacity-0 transition-opacity duration-150 group-hover/visual:pointer-events-auto group-hover/visual:opacity-100 group-focus-within/visual:pointer-events-auto group-focus-within/visual:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <CopyButton text={() => scriptOf(props.args)} label="Copy script" />
          <FullscreenButton label="Full screen" onClick={() => setFull(true)} />
        </div>
        <Expandable limit={BLOCK_LIMIT} streaming={streaming()}>
          <VisualFrame id={props.callId} script={scriptOf(props.args)} streaming={streaming()} title={titleOf(props.args)} />
        </Expandable>
        <Fullscreen open={full()} onClose={() => setFull(false)} title={titleOf(props.args)}>
          <VisualFrame id={props.callId} script={scriptOf(props.args)} streaming={false} title={titleOf(props.args)} />
        </Fullscreen>
      </div>
    </Show>
  )
}
