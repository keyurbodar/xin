import "../../src/styles/app.css"
import { render } from "solid-js/web"
import type { Streams } from "../../src/lib/api.ts"
import { trackMotion } from "../../src/lib/motion.ts"
import { subscribeCaptains } from "../../src/state/captains.ts"
import { subscribeHome } from "../../src/state/home.ts"
import { Sidebar } from "../../src/components/shell/sidebar.tsx"

const NOW = Date.now()
const thread = (id: number, title: string, status: string, minutes: number) => ({ id, title, status, run: 1, beatAt: NOW - minutes * 60_000 })
const HOME = {
  projects: [
    {
      id: "p1",
      slug: "ingle",
      name: "Ingle",
      coordinatorId: 1,
      threads: {
        working: [thread(12, "Sidebar v2 on UI SDK", "working", 2)],
        waiting: [thread(14, "Review the breadcrumb header", "waiting", 30)],
        completed: [thread(9, "Hover cards and link chips", "completed", 300)],
        failed: [],
        cancelled: [],
      },
    },
    { id: "p2", slug: "home", name: "Home", coordinatorId: 2, threads: {} },
  ],
  captains: [
    { id: "c1", name: "Atlas", alias: "atlas", projectId: "p2", spaceId: "s1", coordinatorId: 3, crew: { total: 2, working: 1, waiting: 0, failed: 0 } },
    { id: "c2", name: "Bosun", alias: "bosun", projectId: "p1", spaceId: "s2", coordinatorId: 4, crew: { total: 5, working: 0, waiting: 2, failed: 0 } },
  ],
}

const streams = {
  subscribe: (_name: string, handlers: { value: (value: unknown, rev: string) => void }) => {
    handlers.value(HOME, "1")
    return () => undefined
  },
} as unknown as Streams

const ops: string[] = []
Object.assign(window, { ops })
const realFetch = window.fetch.bind(window)
Object.defineProperty(window, "fetch", {
  value: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (String(input) !== "/v1/cmd") return realFetch(input, init)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string }[]
  const acks = frames.map((frame) => {
    ops.push(frame.op)
    return { t: "ack", id: frame.id, ok: true, result: frame.op === "owner.read" ? { name: "Ada Lovelace", instructions: "" } : {} }
  })
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
  },
})

trackMotion()
subscribeHome(streams)
subscribeCaptains(streams)
render(
  () => (
    <div class="h-[100dvh]">
      <Sidebar onSearch={() => undefined} onCollapse={() => undefined} drawer={false} />
    </div>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
