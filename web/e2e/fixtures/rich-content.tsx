import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { registerBlock } from "../../src/components/chat/blocks.tsx"
import { Markdown } from "../../src/components/chat/markdown.tsx"
import { setTheme, themeOf } from "../../src/lib/theme.ts"

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
  stream: "",
}

const params = new URLSearchParams(location.search)
setTheme(themeOf(params.get("theme")))
const [text, setText] = createSignal(FIXTURES[params.get("fixture") ?? "all"] ?? "")
const [streaming, setStreaming] = createSignal(params.get("fixture") === "stream")

declare global {
  interface Window {
    harness: {
      set: (next: string, live: boolean) => void
      theme: (next: string) => void
      register: (lang: string) => () => void
    }
  }
}

window.harness = {
  set: (next, live) => {
    setText(next)
    setStreaming(live)
  },
  theme: (next) => setTheme(themeOf(next)),
  register: (lang) =>
    registerBlock(`fence:${lang}`, (payload) => (
      <div data-testid="custom-fence">
        custom {lang}: {payload.source}
      </div>
    )),
}

const root = document.getElementById("root")
if (root !== null) {
  render(
    () => (
      <main class="mx-auto w-full max-w-[720px] px-4 py-6">
        <Markdown text={text()} streaming={streaming()} />
      </main>
    ),
    root,
  )
}
