import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { ProjectPane } from "../../src/components/pane/pane.tsx"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"
import { setPaneOpen } from "../../src/state/tabs.ts"

const now = Date.now()
const empty = new URLSearchParams(location.search).has("empty")
const thread = (id: number, title: string, status: string, ago: number, statusLine?: string): ThreadSummary => ({
  id,
  title,
  status,
  run: 1,
  beatAt: now - ago,
  ...(statusLine === undefined ? {} : { statusLine }),
})
const project: ProjectSummary = {
  id: "p1",
  slug: "atlas",
  name: "Atlas",
  archived: false,
  coordinatorId: 1,
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
  threads: empty
    ? { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
    : {
        working: [thread(11, "Web UI on the new primitives", "working", 60_000, "Running the e2e suite")],
        waiting: [],
        completed: [
          thread(12, "PR reviewer for the crew", "completed", 120_000),
          thread(13, "Captains and crews", "completed", 16 * 3_600_000),
        ],
        failed: [],
        cancelled: [],
      },
}
const pull = (n: number): string => `https://github.com/acme/atlas/pull/${n}`
const issue = (
  id: number,
  title: string,
  state: string,
  priority: string,
  threads: number[],
  prs: string[],
  ago: number,
) => ({
  id,
  title,
  state,
  priority,
  due: null,
  parent: null,
  assignees: threads.map((id) => ({ kind: "thread", id })),
  threads,
  prs,
  updatedAt: now - ago,
  project: "p1",
})
const issues = empty
  ? []
  : [
      issue(1, "Port the dialog shell", "in-progress", "urgent", [11], [pull(81), pull(82)], 60_000),
      issue(2, "Review queue for the crew", "in-review", "high", [12], [pull(77)], 120_000),
      issue(3, "Plan the release notes", "todo", "normal", [], [], 3_600_000),
      issue(4, "Theme picker", "backlog", "low", [13], [pull(15)], 86_400_000),
    ]
const states = [
  { id: "in-progress", name: "In progress", closed: false, position: 1, isDefault: false },
  { id: "in-review", name: "In review", closed: false, position: 2, isDefault: false },
  { id: "todo", name: "Todo", closed: false, position: 3, isDefault: true },
  { id: "backlog", name: "Backlog", closed: false, position: 4, isDefault: false },
  { id: "done", name: "Done", closed: true, position: 5, isDefault: true },
]
const file = (path: string, type: string, size = 2_000) => ({
  path,
  type,
  size,
  sha256: path.replace(/\W/gu, "-"),
  updated_at: now - path.length * 60_000,
})
const files = empty
  ? []
  : [
      file("renders/list-1280.png", "image/png"),
      file("renders/list-390.png", "image/png"),
      file("reports/XIN-25.md", "text/markdown"),
      file("renders/poster.png", "image/png", 5 * 1024 * 1024),
      file("notes.txt", "text/plain"),
      file("renders/menu-1280.png", "image/png"),
      file("renders/menu-390.png", "image/png"),
      file("data.json", "application/json"),
      file("renders/bubble.png", "image/png"),
      file("renders/lightbox.png", "image/png"),
    ]
const calls: string[] = []

const answer = (op: string, args: Record<string, unknown>): unknown => {
  switch (op) {
    case "issue.list":
      return { issues: args.closed === true ? [] : issues }
    case "issue.states":
      return { states }
    case "drive.scopes":
      return [{ scope: { kind: "project", id: "p1" }, root: "/projects/atlas/", label: "Atlas" }]
    case "drive.list":
      return { root: "/projects/atlas/", files, shares: {} }
    case "drive.read": {
      const found = files.find((entry) => entry.path === args.path)
      return {
        ...found,
        text: found?.type.startsWith("text/") ? `# ${String(args.path)}\n\nThe body of ${String(args.path)}.` : null,
      }
    }
    default:
      return {}
  }
}

async function picture(url: string): Promise<Response> {
  const canvas = new OffscreenCanvas(240, 320)
  const paint = canvas.getContext("2d")
  if (paint === null) throw new Error("no 2d context")
  paint.fillStyle = "#1d2430"
  paint.fillRect(0, 0, 240, 320)
  paint.fillStyle = url.includes("menu") ? "#7a5cc2" : "#3f7f6a"
  paint.fillRect(16, 24, 208, 40)
  for (let row = 0; row < 7; row += 1) paint.fillRect(16, 84 + row * 30, 140 + ((row * 37) % 60), 12)
  return new Response(await canvas.convertToBlob({ type: "image/png" }), {
    headers: { "content-type": "application/octet-stream" },
  })
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.includes("/blobs/")) {
    calls.push(`blob:${url.slice(url.lastIndexOf("/") + 1)}`)
    return picture(url)
  }
  if (!url.endsWith("/v1/cmd")) throw new Error(`fixture fetch ${url}`)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  const acks = frames.map((frame) => {
    calls.push(frame.op)
    return { t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args ?? {}) }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), {
    headers: { "content-type": "application/json" },
  })
}

localStorage.removeItem("ingle.tabs")
Object.assign(window, { fetch: fakeFetch, calls })
setPaneOpen(true)
render(
  () => (
    <main class="flex h-screen w-full justify-end bg-bg">
      <div class="flex w-[440px] flex-col border-l border-line-1 bg-panel">
        <ProjectPane
          project={project}
          conversationId={1}
          expanded={false}
          onExpand={() => undefined}
          onOpenThread={() => undefined}
        />
      </div>
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
