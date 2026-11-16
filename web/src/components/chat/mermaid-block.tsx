import { Match, Show, Switch, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js"
import { CodeBlock, CopyButton } from "./code-block.tsx"
import { BLOCK_LIMIT, Expandable, Fullscreen, FullscreenButton } from "./expandable.tsx"
import type { BlockPayloads } from "./registry.ts"

const SETTLE_MS = 160

type Mermaid = (typeof import("mermaid"))["default"]

type Drawing = { kind: "pending" } | { kind: "svg"; svg: string } | { kind: "error"; message: string }

let loader: Promise<Mermaid> | undefined
let ids = 0

const [themeTick, setThemeTick] = createSignal(0)
let watching = false

function watchTheme(): void {
  if (watching) return
  watching = true
  new MutationObserver(() => setThemeTick((tick) => tick + 1)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  })
}

function themeVariables(): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement)
  const color = (name: string): string => style.getPropertyValue(`--color-${name}`).trim()
  return {
    darkMode: style.colorScheme.includes("dark"),
    fontFamily: style.getPropertyValue("--font-sans").trim(),
    fontSize: "13px",
    background: color("panel"),
    primaryColor: color("card"),
    primaryTextColor: color("ink"),
    primaryBorderColor: color("line-3"),
    secondaryColor: color("muted"),
    secondaryTextColor: color("ink"),
    secondaryBorderColor: color("line-3"),
    tertiaryColor: color("bg"),
    tertiaryTextColor: color("ink-2"),
    tertiaryBorderColor: color("line-2"),
    mainBkg: color("card"),
    nodeBorder: color("line-3"),
    nodeTextColor: color("ink"),
    clusterBkg: color("bg"),
    clusterBorder: color("line-2"),
    titleColor: color("ink"),
    textColor: color("ink-2"),
    lineColor: color("ink-3"),
    edgeLabelBackground: color("panel"),
    noteBkgColor: color("card"),
    noteTextColor: color("ink-2"),
    noteBorderColor: color("line-3"),
    actorBkg: color("card"),
    actorBorder: color("line-3"),
    actorTextColor: color("ink"),
    actorLineColor: color("ink-3"),
    signalColor: color("ink-2"),
    signalTextColor: color("ink"),
    labelBoxBkgColor: color("card"),
    labelBoxBorderColor: color("line-3"),
    labelTextColor: color("ink"),
    loopTextColor: color("ink-2"),
    activationBkgColor: color("muted"),
    activationBorderColor: color("line-3"),
    sequenceNumberColor: color("on-inverse"),
  }
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
  const first = lines[0] ?? "Diagram failed to render"
  const last = lines.length > 1 ? lines[lines.length - 1] : undefined
  const message = last === undefined || /^[-^.]*$/.test(last) ? first : `${first} ${last}`
  return message.length > 160 ? `${message.slice(0, 157)}…` : message
}

async function draw(source: string): Promise<Drawing> {
  ids += 1
  const id = `ingle-mermaid-${ids}`
  try {
    loader ??= import("mermaid").then((module) => module.default)
    const mermaid = await loader
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables() })
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source)
    return { kind: "svg", svg }
  } catch (error) {
    return { kind: "error", message: shortError(error) }
  } finally {
    for (const stray of [id, `d${id}`, `i${id}`]) document.getElementById(stray)?.remove()
  }
}

function Diagram(props: { svg: string; fit: boolean }): JSX.Element {
  let host!: HTMLDivElement
  createEffect(() => {
    host.innerHTML = props.svg
    const svg = host.querySelector("svg")
    if (svg === null) return
    svg.removeAttribute("height")
    svg.style.height = "auto"
    if (props.fit) return
    svg.style.maxWidth = "none"
    svg.style.width = `${svg.viewBox.baseVal.width}px`
  })
  return <div ref={host} class="mermaid-diagram" classList={{ "is-fit": props.fit }} />
}

export function MermaidBlock(props: BlockPayloads["mermaid"]): JSX.Element {
  const [drawing, setDrawing] = createSignal<Drawing>({ kind: "pending" })
  const [full, setFull] = createSignal(false)
  const [fit, setFit] = createSignal(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  let run = 0
  watchTheme()
  onCleanup(() => clearTimeout(timer))

  createEffect(
    on([() => props.source, () => props.streaming, themeTick], ([source, streaming]) => {
      clearTimeout(timer)
      if (streaming) return
      run += 1
      const mine = run
      timer = setTimeout(() => {
        void draw(source).then((next) => {
          if (mine === run) setDrawing(next)
        })
      }, SETTLE_MS)
    }),
  )

  const failure = (): string | undefined => {
    const current = drawing()
    return !props.streaming && current.kind === "error" ? current.message : undefined
  }
  const picture = (): string | undefined => {
    const current = drawing()
    return !props.streaming && current.kind === "svg" ? current.svg : undefined
  }

  const source = (): JSX.Element => <CodeBlock lang="mermaid" source={props.source} streaming={props.streaming} />

  return (
    <Switch fallback={source()}>
      <Match when={failure()}>
        {(message) => (
          <div class="flex flex-col gap-1.5" data-block="mermaid-error">
            {source()}
            <p role="status" class="font-mono text-2xs text-ink-3">
              <span class="text-failed">Diagram error</span> · {message()}
            </p>
          </div>
        )}
      </Match>
      <Match when={picture()}>
        {(svg) => (
          <div class="overflow-hidden rounded-md border border-line-2 bg-panel" data-block="mermaid">
            <div class="flex h-8 items-center gap-3 border-b border-line-1 px-3 font-mono text-2xs text-ink-3">
              <span>mermaid</span>
              <span class="ml-auto flex items-center gap-1">
                <CopyButton text={() => props.source} label="Copy diagram source" idle="Copy source" />
                <FullscreenButton label="Open diagram full screen" onClick={() => setFull(true)} />
              </span>
            </div>
            <Expandable limit={BLOCK_LIMIT} streaming={false}>
              <div class="flex justify-center p-4">
                <Diagram svg={svg()} fit />
              </div>
            </Expandable>
            <Fullscreen open={full()} onClose={() => setFull(false)} title="Diagram">
              <div class="flex flex-col gap-2 p-4">
                <div class="flex justify-end">
                  <button
                    type="button"
                    aria-pressed={!fit()}
                    onClick={() => setFit((on) => !on)}
                    class="im-press h-6 rounded-sm px-1.5 font-mono text-2xs text-ink-3 hover:text-ink"
                  >
                    {fit() ? "Actual size" : "Fit"}
                  </button>
                </div>
                <div class="flex justify-center" classList={{ "justify-start": !fit() }}>
                  <Diagram svg={svg()} fit={fit()} />
                </div>
              </div>
            </Fullscreen>
          </div>
        )}
      </Match>
    </Switch>
  )
}

