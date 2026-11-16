import "../../src/styles/app.css"
import { lazy, Show } from "solid-js"
import { render } from "solid-js/web"
import { CrewView } from "../../src/components/pane/crew.tsx"
import { IssuesSection } from "../../src/components/pane/issues.tsx"
import type { Streams } from "../../src/lib/api.ts"
import type { CaptainProfile } from "../../src/lib/captains.ts"
import { trackMotion } from "../../src/lib/motion.ts"
import { homeProjects, subscribeHome, type ProjectSummary } from "../../src/state/home.ts"

const params = new URLSearchParams(location.search)
const view = params.get("view") ?? "list"
const failing = new Set(params.getAll("fail"))
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const thread = (id: number, title: string) => ({ id, title, status: "waiting", run: 1 })
const empty = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
const projects = [
  {
    id: "p1",
    slug: "atlas",
    name: "Atlas",
    coordinatorId: 1,
    threads: { ...empty, waiting: [thread(11, "Port the dialog shell"), thread(12, "Review the spec")] },
    spaces: [
      { id: "s1", coordinatorId: 5, threads: { ...empty, working: [{ ...thread(21, "Crew: tidy the drive"), status: "working" }] } },
      { id: "s2", coordinatorId: 6, threads: { ...empty, waiting: [thread(31, "Draft the launch post"), thread(32, "Audit the billing page")] } },
    ],
  },
]
const captain: CaptainProfile = {
  id: "c1",
  name: "Bosun",
  alias: "bosun",
  avatarSeed: "bosun",
  description: "",
  projectId: "p1",
  spaceId: "s1",
  coordinatorId: 5,
  archived: false,
  createdAt: 0,
}
const states = [
  { id: "needs-you", name: "Needs you", closed: false, position: 0, isDefault: false },
  { id: "todo", name: "Todo", closed: false, position: 1, isDefault: true },
  { id: "doing", name: "In progress", closed: false, position: 2, isDefault: false },
  { id: "done", name: "Done", closed: true, position: 3, isDefault: false },
]
type Row = {
  id: number
  title: string
  state: string
  priority: string
  due: string | null
  parent: number | null
  assignees: { kind: string; id: string | number }[]
  threads: number[]
  prs: string[]
  updatedAt: number
  project: string
  description: string
}
const row = (id: number, title: string, state: string, priority: string, extra: Partial<Row> = {}): Row => ({
  id,
  title,
  state,
  priority,
  due: null,
  parent: null,
  assignees: [],
  threads: [],
  prs: [],
  updatedAt: id,
  project: "p1",
  description: "",
  ...extra,
})
const issues: Row[] = [
  row(1, "Port the issues pane to the new primitives", "doing", "high", {
    due: day(3),
    assignees: [{ kind: "thread", id: 11 }],
    threads: [11],
    description: "Move every popup onto the shared surface.",
  }),
  row(2, "Fix the overdue invoice export", "doing", "urgent", { due: day(-2), parent: 1 }),
  row(3, "Pick a name for the product", "needs-you", "low", { assignees: [{ kind: "person", id: "owner" }] }),
  row(4, "Write the onboarding copy", "todo", "normal", { threads: [11, 12] }),
  row(5, "Ship the first release", "done", "normal"),
  row(6, "Investigate the slow search", "todo", "low"),
]
const links: Record<number, { blocks: number[]; blockedBy: number[]; related: number[] }> = { 1: { blocks: [2], blockedBy: [], related: [] } }
const calls: string[] = []
let rev = 1
let nextId = 7

const linked = (ids: number[]) => ids.flatMap((id) => issues.filter((issue) => issue.id === id).map(({ id: each, title, state }) => ({ id: each, title, state })))
const find = (id: unknown): Row => {
  const found = issues.find((issue) => issue.id === id)
  if (found === undefined) throw new Error(`no issue #${String(id)}`)
  return found
}

const answer = (op: string, args: Record<string, unknown>): unknown => {
  if (failing.has(op)) throw new Error(`${op} refused by the fixture`)
  switch (op) {
    case "issue.states":
      return { states }
    case "issue.list": {
      const closed = new Set(states.filter((state) => state.closed).map((state) => state.id))
      const q = typeof args.q === "string" ? args.q.toLowerCase() : undefined
      if (q !== undefined) return { issues: issues.filter((issue) => issue.title.toLowerCase().includes(q)) }
      return { issues: issues.filter((issue) => closed.has(issue.state) === (args.closed === true)) }
    }
    case "issue.get": {
      const issue = find(args.id)
      const own = links[issue.id] ?? { blocks: [], blockedBy: [], related: [] }
      return {
        issue,
        children: issues.filter((entry) => entry.parent === issue.id),
        links: { blocks: linked(own.blocks), blockedBy: linked(own.blockedBy), related: linked(own.related) },
        timeline: [{ id: 1, at: Date.now() - 3_600_000, actor: "owner", kind: "created", data: {}, replyTo: null }],
        earlier: null,
      }
    }
    case "issue.update": {
      const issue = find(args.id)
      Object.assign(issue, Object.fromEntries(Object.entries(args).filter(([key]) => key !== "id")), { updatedAt: issue.updatedAt + 100 })
      return issue
    }
    case "issue.create": {
      const issue = row(nextId++, String(args.title), typeof args.state === "string" ? args.state : "todo", typeof args.priority === "string" ? args.priority : "normal")
      issues.push(issue)
      return issue
    }
    case "issue.link":
    case "issue.unlink": {
      const issue = find(args.id)
      const own = (links[issue.id] ??= { blocks: [], blockedBy: [], related: [] })
      const key = args.kind === "blocked_by" ? "blockedBy" : args.kind === "blocks" ? "blocks" : "related"
      const other = Number(args.other)
      own[key] = op === "issue.link" ? [...own[key], other] : own[key].filter((id) => id !== other)
      issue.updatedAt += 100
      return issue
    }
    case "captain.crew.add":
    case "captain.crew.remove":
      return {}
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
    calls.push(frame.op === "issue.states" || frame.op === "issue.get" ? frame.op : `${frame.op}:${JSON.stringify(frame.args)}`)
    try {
      return { t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args) }
    } catch (problem) {
      return { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: problem instanceof Error ? problem.message : String(problem) } }
    }
  })
  const writes = frames.some((frame) => !["issue.states", "issue.list", "issue.get"].includes(frame.op))
  await new Promise((resolve) => setTimeout(resolve, writes ? Number(params.get("slow") ?? 20) : 20))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

type Home = { value: (value: unknown, rev: string) => void }
let home: Home | undefined
const snapshot = () => ({ projects, issues: { rev } })
const streams = {
  subscribe: (_: string, subscription: Home) => {
    home = subscription
    subscription.value(snapshot(), String(rev))
    return () => undefined
  },
}

Object.assign(window, {
  fetch: fakeFetch,
  calls,
  bump: () => {
    rev += 1
    home?.value(snapshot(), String(rev))
  },
})
trackMotion()
subscribeHome(streams as unknown as Streams)

const IssueView = lazy(() => import("../../src/components/pane/issue.tsx").then((module) => ({ default: module.IssueView })))
const opened: number[] = []
Object.assign(window, { opened })

function Body(props: { project: ProjectSummary }) {
  const context = { get project() { return props.project }, conversationId: 1, onOpenThread: (id: number) => opened.push(id) }
  if (view === "issue") return <IssueView {...context} id={Number(params.get("id") ?? 1)} />
  if (view === "crew") return <CrewView {...context} captain={captain} />
  return <IssuesSection {...context} label="Issues" />
}

render(
  () => (
    <main class="flex min-h-screen w-full justify-center bg-bg">
      <div class="w-full max-w-[432px] bg-panel p-2">
        <Show when={homeProjects()[0]}>{(project) => <Body project={project()} />}</Show>
      </div>
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
