import "../../src/styles/app.css"
import { Suspense } from "solid-js"
import { render } from "solid-js/web"
import { ExtensionsScreen } from "../../src/components/shell/shell.tsx"

const skills = [
  { name: "release-notes", description: "Drafts release notes from merged pulls." },
  { name: "triage", description: "Sorts new issues by area." },
]

const answer = (op: string, args: Record<string, unknown>): unknown => {
  switch (op) {
    case "skill.list":
      return skills
    case "skill.read":
      return { ...skills.find((skill) => skill.name === args.name), markdown: `# ${String(args.name)}\n\nThe body of ${String(args.name)}.` }
    case "market.search":
      return { entries: [] }
    case "plugin.packages":
      return { installed: [], pending: {} }
    case "preset.list":
      return { presets: [] }
    default:
      return []
  }
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/v1/cmd")) throw new Error(`fixture fetch ${url}`)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args ?? {}) }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

const suspended: string[] = []
Object.assign(window, { fetch: fakeFetch, suspended })
location.hash = "/extensions/customize"
render(
  () => (
    <main class="flex h-screen w-full flex-col bg-panel">
      <Suspense fallback={<p data-suspended ref={() => suspended.push("outer")} />}>
        <ExtensionsScreen />
      </Suspense>
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
