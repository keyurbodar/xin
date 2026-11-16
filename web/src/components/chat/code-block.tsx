import { createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import { MorphIcon } from "../ui/morph-icon.tsx"
import { Morph } from "../ui/morph.tsx"
import { CODE_LIMIT, Expandable, Fullscreen, FullscreenButton } from "./expandable.tsx"

type Highlighter = { highlight: typeof import("sugar-high").highlight; lang: typeof import("sugar-high/lang").lang }

const [highlighter, setHighlighter] = createSignal<Highlighter>()
let loading: Promise<void> | undefined

/** Sugar High loads on the first code block instead of at startup; until it lands, blocks show their source unhighlighted. A failed load is retried by the next block. */
function loadHighlighter(): void {
  loading ??= Promise.all([import("sugar-high"), import("sugar-high/lang")]).then(
    ([core, langs]) => {
      setHighlighter({ highlight: core.highlight, lang: langs.lang })
    },
    () => {
      loading = undefined
    },
  )
}

function fenceLabel(fence: string): string {
  return highlighter()?.lang(fence) ?? (fence === "" ? "code" : fence)
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }

/** Sugar High escapes the code it marks up. The newline between line spans is dropped so the gutter stacks; the plain form keeps the same line spans. */
function markedUp(code: string, fence: string, sugar: Highlighter | undefined): string {
  if (sugar === undefined)
    return code
      .split("\n")
      .map((line) => `<span class="sh__line">${line.replace(/[&<>]/g, (char) => ESCAPES[char] ?? char)}</span>`)
      .join("")
  const canonical = sugar.lang(fence)
  const html = sugar.highlight(code, canonical === undefined ? { lang: "plaintext" } : { lang: canonical })
  return html.replaceAll('\n<span class="sh__line', '<span class="sh__line')
}

export function CopyButton(props: { text: () => string; label: string; idle?: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  let timer: number | undefined
  onCleanup(() => window.clearTimeout(timer))

  /** The label settles back on its own; a browser that refuses the clipboard leaves it alone. */
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text())
      setCopied(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={() => void copy()}
      class="im-press flex h-6 items-center gap-1.5 rounded-sm px-1.5 hover:text-ink"
      classList={{ "text-ink": copied() }}
    >
      <MorphIcon kind="copy" on={copied()} size={13} />
      <Morph value={copied() ? "Copied" : (props.idle ?? "Copy")} />
    </button>
  )
}

function createHighlight(read: () => string, label: () => string, live: () => boolean): () => string {
  const source = createMemo(read)
  const fence = createMemo(label)
  const streaming = createMemo(live)
  loadHighlighter()
  const [html, setHtml] = createSignal(markedUp(source(), fence(), highlighter()))
  let frame: number | undefined
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  createEffect(
    on(
      [source, fence, streaming, highlighter],
      ([code, label, live, sugar]) => {
        if (!live) {
          if (frame !== undefined) cancelAnimationFrame(frame)
          frame = undefined
          setHtml(markedUp(code, label, sugar))
          return
        }
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          setHtml(markedUp(source(), fence(), highlighter()))
        })
      },
      { defer: true },
    ),
  )
  return html
}

export function CodeBlock(props: { lang: string; source: string; streaming: boolean }): JSX.Element {
  const [wrapped, setWrapped] = createSignal(false)
  const [full, setFull] = createSignal(false)
  const html = createHighlight(
    () => props.source,
    () => props.lang,
    () => props.streaming,
  )
  const lines = (): number => (props.source === "" ? 0 : props.source.split("\n").length)

  const code = (): JSX.Element => (
    <pre classList={{ "is-wrapped": wrapped() }}>
      <code innerHTML={html()} />
    </pre>
  )

  return (
    <div class="code-block overflow-hidden rounded-md border border-line-2 bg-panel" data-block="code">
      <div class="flex h-8 items-center gap-3 border-b border-line-1 px-3 font-mono text-2xs text-ink-3">
        <span>{fenceLabel(props.lang)}</span>
        <span class="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-pressed={wrapped()}
            onClick={() => setWrapped((on) => !on)}
            class="im-press h-6 rounded-sm px-1.5 text-2xs hover:text-ink"
          >
            {wrapped() ? "Wrapped" : "Wrap"}
          </button>
          <CopyButton text={() => props.source} label="Copy code" />
          <FullscreenButton label="Open code full screen" onClick={() => setFull(true)} />
        </span>
      </div>
      <Expandable limit={CODE_LIMIT} streaming={props.streaming} summary={`${lines()} lines`}>
        {code()}
      </Expandable>
      <Fullscreen open={full()} onClose={() => setFull(false)} title={fenceLabel(props.lang)}>
        <div class="code-block">{code()}</div>
      </Fullscreen>
    </div>
  )
}
