import { createEffect, createSignal, on, onCleanup, type JSX } from "solid-js"
import { highlight } from "sugar-high"
import { lang } from "sugar-high/lang"
import { MorphIcon } from "../ui/morph-icon.tsx"
import { Morph } from "../ui/morph.tsx"
import { CODE_LIMIT, Expandable, Fullscreen, FullscreenButton } from "./expandable.tsx"

function fenceLabel(fence: string): string {
  return lang(fence) ?? (fence === "" ? "code" : fence)
}

/** Sugar High escapes the code it marks up. The newline between line spans is dropped so the gutter stacks. */
function markedUp(code: string, fence: string): string {
  const canonical = lang(fence)
  const html = highlight(code, canonical === undefined ? { lang: "plaintext" } : { lang: canonical })
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

function createHighlight(source: () => string, fence: () => string, streaming: () => boolean): () => string {
  const [html, setHtml] = createSignal(markedUp(source(), fence()))
  let frame: number | undefined
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  createEffect(
    on(
      [source, fence, streaming],
      ([code, label, live]) => {
        if (!live) {
          if (frame !== undefined) cancelAnimationFrame(frame)
          frame = undefined
          setHtml(markedUp(code, label))
          return
        }
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          setHtml(markedUp(source(), fence()))
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
