import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { registerBlock, renderBlock, type BlockPayloads } from "../../src/components/chat/blocks.tsx"
import { Markdown } from "../../src/components/chat/markdown.tsx"
import { BUILT_IN_THEMES, DEFAULT_THEME, setTheme } from "../../src/lib/theme.ts"

const themeOf = (id: string | null) => BUILT_IN_THEMES.find((entry) => entry.id === id) ?? DEFAULT_THEME

const fence = "```"

const diagram = `${fence}mermaid
flowchart LR
  ask[Owner asks] --> plan{Coordinator}
  plan -->|thread| work[Worker runs]
  plan -->|answer| reply[Reply]
  work --> reply
${fence}`

const broken = `${fence}mermaid
flowchart LR
  a --> --> b((
${fence}`

const rows = Array.from({ length: 20 }, (_, index) => `| row ${index + 1} | ${(index + 1) * 125} | \`ok\` \\| fine |`)
const table = ["| Name | Amount | Note |", "| :-- | --: | :-: |", ...rows].join("\n")

const code = `${fence}ts\n${Array.from({ length: 60 }, (_, index) => `const value${index} = compute(${index}, "a fairly long argument to make the line wide enough to wrap on narrow screens")`).join("\n")}\n${fence}`

const hostile = `${fence}mermaid
%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": ".node rect { fill: url(http://203.0.113.9/css.png) }"}}%%
flowchart LR
  A["<img src='http://203.0.113.9/label.png'> pic"] --> B[safe]
  click B href "http://203.0.113.9/link"
${fence}`

const FIXTURES: Record<string, string> = {
  all: [
    "## Rich content",
    "A diagram, a table and some code.",
    diagram,
    table,
    code,
    "And a broken diagram:",
    broken,
  ].join("\n\n"),
  mermaid: diagram,
  broken,
  table,
  code,
  hostile,
  stream: "",
}

const params = new URLSearchParams(location.search)
setTheme(themeOf(params.get("theme")))
const [text, setText] = createSignal(FIXTURES[params.get("fixture") ?? "all"] ?? "")
const [streaming, setStreaming] = createSignal(params.get("fixture") === "stream")
const [call, setCall] = createSignal<BlockPayloads["tool"]>({ name: "probe", callId: "c1", args: { step: 0 }, status: "running" })

declare global {
  interface Window {
    harness: {
      set: (next: string, live: boolean) => void
      theme: (next: string) => void
      register: (lang: string, throws?: boolean) => () => void
      registerTool: () => () => void
      spyMermaid: () => Promise<() => number>
      step: (step: number) => void
    }
  }
}

window.harness = {
  set: (next, live) => {
    setText(next)
    setStreaming(live)
  },
  theme: (next) => setTheme(themeOf(next)),
  register: (lang, throws) =>
    registerBlock(`fence:${lang}`, (payload) => {
      if (throws === true) throw new Error(`${lang} failed`)
      return (
        <div data-testid="custom-fence">
          custom {lang}: {payload.source}
        </div>
      )
    }),
  registerTool: () =>
    registerBlock("tool:probe", (tool) => <div data-testid="tool-probe">step {String(tool.args.step)}</div>),
  step: (step) => setCall({ ...call(), args: { step } }),
  spyMermaid: async () => {
    const mermaid = (await import("mermaid")).default
    const render = mermaid.render
    let calls = 0
    mermaid.render = (...args) => {
      calls += 1
      return render(...args)
    }
    return () => calls
  },
}

const root = document.getElementById("root")
if (root !== null) {
  render(
    () => (
      <main class="mx-auto w-full max-w-[720px] px-4 py-6">
        <Markdown text={text()} streaming={streaming()} />
        {renderBlock("tool", {
          get name() {
            return call().name
          },
          get callId() {
            return call().callId
          },
          get args() {
            return call().args
          },
          get status() {
            return call().status
          },
        })}
      </main>
    ),
    root,
  )
}
