import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { trackMotion } from "../../src/lib/motion.ts"
import { subscribeCaptains } from "../../src/state/captains.ts"
import { connect } from "../../src/state/connection.ts"
import { subscribeHome } from "../../src/state/home.ts"
import { Sidebar } from "../../src/components/shell/sidebar.tsx"

const NOW = Date.now()
const thread = (id: number, title: string, minutes: number) => ({ id, title, status: "completed", run: 1, beatAt: NOW - minutes * 60_000 })
const groups = (...threads: ReturnType<typeof thread>[]) => ({ working: [], waiting: [], completed: threads, failed: [], cancelled: [] })
const HOME = {
  projects: [
    { id: "p1", slug: "alpha", name: "Alpha", coordinatorId: 1, threads: groups(thread(11, "Alpha first", 1), thread(12, "Alpha second", 2)), spaces: [] },
    { id: "p2", slug: "beta", name: "Beta", coordinatorId: 2, threads: groups(thread(21, "Beta first", 3), thread(22, "Beta second", 4)), spaces: [] },
    { id: "p3", slug: "gamma", name: "Gamma", coordinatorId: 3, threads: groups(thread(31, "Gamma first", 5)), spaces: [] },
  ],
  captains: [
    { id: "c1", name: "Bosun", alias: "bosun", projectId: "p2", spaceId: "s1", coordinatorId: 4, crew: { total: 1, working: 0, waiting: 0, failed: 0 } },
  ],
}

const params = new URLSearchParams(location.search)
const snapAt = Number(params.get("snap") ?? 0)
const routeAt = Number(params.get("route") ?? 0)
const to = params.get("to") ?? "/"
const titles = new Set(HOME.projects.flatMap((project) => project.threads.completed.map((entry) => entry.title)))
/** Every thread title the sidebar adds from the moment the later of the snapshot and the route starts landing. */
const added: string[] = []
/** Empty-state copy the sidebar showed at any point, though the home always has projects and every route names one. */
const claimed: string[] = []
const EMPTY = ["No projects yet", "Open a project to see its threads"]
let landed = 0
let watching = false
let settle: () => void = () => undefined
const settled = new Promise<void>((resolve) => (settle = resolve))
const land = (step: () => void): void => {
  landed += 1
  if (landed === 2) watching = true
  step()
  if (landed === 2) requestAnimationFrame(() => requestAnimationFrame(() => settle()))
}

class FakeSocket extends EventTarget {
  static readonly OPEN = 1
  readyState = 0
  #subscribed = false
  constructor() {
    super()
    setTimeout(() => {
      this.readyState = 1
      this.dispatchEvent(new Event("open"))
      this.#emit({ t: "hello", socket: "fixture" })
    }, 0)
  }
  send(raw: string): void {
    const frame: unknown = JSON.parse(raw)
    if (this.#subscribed || typeof frame !== "object" || frame === null || Reflect.get(frame, "stream") !== "home") return
    this.#subscribed = true
    setTimeout(() => land(() => this.#emit({ t: "snap", stream: "home", value: HOME, rev: "r1" })), Math.max(0, snapAt - performance.now()))
  }
  close(): void {}
  #emit(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }))
  }
}

new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes) claimed.push(...EMPTY.filter((text) => node.textContent?.includes(text) === true))
  if (!watching) return
  for (const record of records)
    for (const node of record.addedNodes)
      if (node instanceof Element)
        for (const button of [node, ...node.querySelectorAll("button")]) {
          const title = button.querySelector(".truncate")?.textContent ?? ""
          if (button.tagName === "BUTTON" && titles.has(title)) added.push(title)
        }
}).observe(document.body, { subtree: true, childList: true })

const ack = (frame: { id: string; op: string }) => ({ t: "ack", id: frame.id, ok: true, result: frame.op === "owner.read" ? { name: "Ada", instructions: "" } : {} })
const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const body: unknown = JSON.parse(String(init?.body))
  const acks = (Array.isArray(body) ? body : [body]).map(ack)
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

Object.assign(window, { WebSocket: FakeSocket, fetch, settled, added, claimed })
setTimeout(() => land(() => (location.hash = to)), Math.max(0, routeAt - performance.now()))

trackMotion()
const streams = connect()
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
