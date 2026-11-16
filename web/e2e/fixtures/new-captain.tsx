import "../../src/styles/app.css"
import { Show } from "solid-js"
import { render } from "solid-js/web"
import type { Streams } from "../../src/lib/api.ts"
import type { CaptainProfile } from "../../src/lib/captains.ts"
import { openNewCaptain } from "../../src/components/captain/captain-dialog.tsx"
import { NewCaptainDialog } from "../../src/components/captain/new-captain.tsx"
import { ProjectChat } from "../../src/screens/project.tsx"
import { subscribeHome, type ProjectSummary } from "../../src/state/home.ts"

const params = new URLSearchParams(location.search)
const view = params.get("view") ?? "dialog"
const empty = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
const projects = [
  { id: "p1", slug: "atlas", name: "Atlas", coordinatorId: 1, threads: empty },
  { id: "p2", slug: "ledger", name: "Ledger", coordinatorId: 2, threads: empty },
]
const catalog = [
  { provider: "anthropic", modelId: "fixture-large", name: "Fixture Large", keyed: true },
  { provider: "deepseek", modelId: "fixture-flash", name: "Fixture Flash", keyed: true },
  { provider: "openai", modelId: "fixture-locked", name: "Fixture Locked", keyed: false },
]
const calls: { op: string; args: Record<string, unknown> }[] = []

const answer = (op: string, args: Record<string, unknown>): unknown => {
  switch (op) {
    case "models.list": {
      const query = typeof args.query === "string" ? args.query.toLowerCase() : ""
      return { models: catalog.filter((model) => model.name.toLowerCase().includes(query)) }
    }
    case "conv.context":
      return {
        conversation: args.conv,
        contextWindow: 200_000,
        used: 0,
        compactAt: 160_000,
        ...(args.conv === 1 ? { model: { provider: "anthropic", modelId: "fixture-large" } } : {}),
      }
    case "captain.create":
      if (args.name === "Taken") throw new Error("alias @taken is taken by another live Captain, so pick another name or set an alias under Alias and rules")
      return { id: "cap-1", name: args.name, alias: args.alias ?? "harbour", projectId: args.projectId, spaceId: "s1", coordinatorId: 9 }
    case "message.send":
      return { accepted: true }
    default:
      return {}
  }
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/v1/cmd")) throw new Error(`fixture fetch ${url}`)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  if (frames.some((frame) => frame.args.name === "Offline")) throw new TypeError("Failed to fetch")
  const acks = frames.map((frame) => {
    calls.push({ op: frame.op, args: frame.args })
    try {
      return { t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args) }
    } catch (problem) {
      return { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: problem instanceof Error ? problem.message : String(problem) } }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

const streams = {
  subscribe: (_: string, subscription: { value: (value: unknown, rev: string) => void }) => {
    subscription.value({ projects }, "1")
    return () => undefined
  },
}

Object.assign(window, { fetch: fakeFetch, calls })
location.hash = "/p/atlas"
subscribeHome(streams as unknown as Streams)

const captain: CaptainProfile = {
  id: "cap-1",
  name: params.get("name") ?? "Harbour",
  alias: "harbour",
  avatarSeed: "harbour",
  description: params.get("goal") ?? "Keep the docs site in step with the code.",
  projectId: "p1",
  spaceId: "s1",
  coordinatorId: 9,
  archived: false,
  createdAt: 0,
}
const space: ProjectSummary = {
  id: "s1",
  slug: "atlas",
  name: captain.name,
  archived: false,
  coordinatorId: 9,
  threads: empty,
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
  goal: captain.description,
}

render(
  () => (
    <main class="flex h-screen w-full flex-col bg-bg">
      <Show
        when={view === "welcome"}
        fallback={
          <>
            <button id="open" type="button" class="m-4 self-start" onClick={openNewCaptain}>
              Open
            </button>
            <NewCaptainDialog />
          </>
        }
      >
        <section class="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-panel shadow-ring">
          <ProjectChat
            project={space}
            captain={captain}
            snapshot={{ id: 9, entries: [], before: undefined, docs: {} }}
            active
            onOpenThread={() => undefined}
          />
        </section>
      </Show>
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
