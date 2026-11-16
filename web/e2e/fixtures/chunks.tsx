import "../../src/styles/app.css"
import { Show } from "solid-js"
import { render } from "solid-js/web"
import type { Streams } from "../../src/lib/api.ts"
import { route } from "../../src/lib/router.ts"
import { WelcomeRoute } from "../../src/app.tsx"
import { Shell } from "../../src/components/shell/shell.tsx"
import { subscribeHome } from "../../src/state/home.ts"
import { setPaneOpen, showPaneView } from "../../src/state/tabs.ts"

const empty = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }
const projects = [{ id: "p1", slug: "atlas", name: "Atlas", coordinatorId: 1, threads: empty }]
const calls: string[] = []

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith("/v1/cmd")) return new Response("not found", { status: 404 })
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string }[]
  const acks = frames.map((frame) => {
    calls.push(frame.op)
    return { t: "ack", id: frame.id, ok: true, result: frame.op === "drive.scopes" ? [] : {} }
  })
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

const streams = {
  subscribe: (_: string, subscription: { value: (value: unknown, rev: string) => void }) => {
    subscription.value({ projects }, "1")
    return () => undefined
  },
}

class QuietSocket extends EventTarget {
  readonly readyState = 0
  send(): void {}
  close(): void {}
}

Object.assign(window, { fetch: fakeFetch, WebSocket: QuietSocket, calls, setPaneOpen, showPaneView })
subscribeHome(streams as unknown as Streams)
render(
  () => (
    <main class="h-screen w-full">
      <Show when={route().parts[0] === "welcome"} fallback={<Shell />}>
        <WelcomeRoute />
      </Show>
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
