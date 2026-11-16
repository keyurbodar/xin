import "../../src/styles/app.css"
import { render } from "solid-js/web"
import type { Streams } from "../../src/lib/api.ts"
import { trackMotion } from "../../src/lib/motion.ts"
import { AutomationsScreen } from "../../src/screens/automations.tsx"
import { subscribeHome } from "../../src/state/home.ts"

const params = new URLSearchParams(location.search)
const runCount = Number(params.get("runs") ?? 45)
const now = Date.now()
const iso = (ago: number): string => new Date(now - ago).toISOString()
const empty = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
const projects = [
  { id: "p1", slug: "atlas", name: "Atlas", coordinatorId: 1, threads: empty },
  { id: "p2", slug: "ledger", name: "Ledger", coordinatorId: 2, threads: empty },
]
const run = (index: number) => ({
  id: `run-${String(index).padStart(2, "0")}`,
  status: index % 7 === 3 ? "failed" : "completed",
  source: index % 5 === 0 ? "manual" : "schedule",
  threadId: 100 + index,
  inputs: 1,
  input: null,
  error: index % 7 === 3 ? "The model refused the request." : null,
  createdAt: iso((index + 1) * 3_600_000),
  startedAt: iso((index + 1) * 3_600_000),
  finishedAt: iso((index + 1) * 3_600_000 - 95_000),
  cost: 0.012 * (index + 1),
})
const runs = Array.from({ length: runCount }, (_, index) => run(index))
const automations = [
  {
    id: "a1",
    title: "Weekly pipeline review",
    prompt: "Review the pipeline and list the deals that slipped this week.",
    project: "p1",
    target: "fresh",
    enabled: true,
    nextAt: new Date(now + 26 * 3_600_000).toISOString(),
    triggers: [{ id: "t1", kind: "schedule", cron: "0 9 * * 1", tz: "UTC", nextAt: new Date(now + 26 * 3_600_000).toISOString() }],
    lastRun: runs[0] ?? null,
  },
  {
    id: "a2",
    title: "Deploy watcher",
    prompt: "Summarise the deploy and flag anything that regressed.",
    project: "p2",
    target: "same",
    enabled: false,
    nextAt: null,
    triggers: [{ id: "t2", kind: "webhook", path: "/hooks/abc123", contains: [], regex: null, rules: [] }],
    lastRun: null,
  },
  {
    id: "a3",
    title: "Quarter close checklist",
    prompt: "Walk through the close checklist.",
    project: "p1",
    target: "fresh",
    enabled: true,
    nextAt: new Date(now + 5 * 86_400_000).toISOString(),
    triggers: [{ id: "t3", kind: "once", at: new Date(now + 5 * 86_400_000).toISOString(), nextAt: new Date(now + 5 * 86_400_000).toISOString() }],
    lastRun: run(2),
  },
]
const calls: string[] = []
let revision = 1

const answer = (op: string, args: Record<string, unknown>): unknown => {
  switch (op) {
    case "automation.list":
      return { automations }
    case "automation.get": {
      const found = automations.find((item) => item.id === args.id)
      if (found === undefined) throw new Error("not found")
      return { ...found, runs: runs.slice(0, Number(args.runs ?? 20)), batches: [] }
    }
    case "automation.runs": {
      const before = typeof args.before === "string" ? Date.parse(args.before) : Infinity
      return { runs: runs.filter((item) => Date.parse(item.createdAt) < before).slice(0, Number(args.limit ?? 20)) }
    }
    case "automation.update": {
      const found = automations.find((item) => item.id === args.id)
      if (found === undefined) throw new Error("not found")
      Object.assign(found, args)
      return found
    }
    default:
      throw new Error(`fixture has no ${op}`)
  }
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/v1/cmd")) throw new Error(`fixture fetch ${url}`)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  const acks = frames.map((frame) => {
    calls.push(frame.op === "automation.update" ? `automation.update:${JSON.stringify(frame.args)}` : frame.op)
    try {
      return { t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args) }
    } catch (problem) {
      return { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: String(problem) } }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, Number(params.get("delay") ?? 20)))
  if (frames.some((frame) => frame.op === "automation.update")) queueMicrotask(bump)
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

type Home = { value: (value: unknown, rev: string) => void }
let home: Home | undefined
const snapshot = () => ({ projects, automations: { revision, touched: { a1: revision } } })
const streams = {
  subscribe: (_: string, subscription: Home) => {
    home = subscription
    subscription.value(snapshot(), String(revision))
    return () => undefined
  },
}

const bump = (): void => {
  revision += 1
  home?.value(snapshot(), String(revision))
}

Object.assign(window, { fetch: fakeFetch, calls, bump })
if (params.get("view") !== null) location.hash = `/automations/${params.get("view")}`
else location.hash = "/automations"
trackMotion()
subscribeHome(streams as unknown as Streams)
render(
  () => (
    <main class="flex h-screen w-full flex-col bg-bg">
      <AutomationsScreen />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
