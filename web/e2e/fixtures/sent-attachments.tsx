import "../../src/styles/app.css"
import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { OwnerBubble } from "../../src/components/chat/entries.tsx"
import { SentBlobsScope } from "../../src/components/composer/attachment-card.tsx"
import type { Attachment } from "../../src/state/conversation.ts"

async function swatch(token: string, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")!
  const style = getComputedStyle(document.documentElement)
  context.fillStyle = style.getPropertyValue("--color-muted")
  context.fillRect(0, 0, width, height)
  context.fillStyle = style.getPropertyValue(token)
  for (let row = 0; row < height; row += 24) context.fillRect(16, row + 8, width * (0.3 + ((row / 24) % 4) * 0.15), 8)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
}

const SHOT = "a".repeat(64)
const DIAGRAM = "b".repeat(64)
const GONE = "c".repeat(64)
const PAGE = "f".repeat(64)
const LOGO = "9".repeat(64)
const longSha = (index: number) => `e${index.toString(16).padStart(63, "0")}`
const LONG = 34

const shot = await swatch("--color-primary", 640, 400)
const blobs = new Map<string, Blob>([
  [SHOT, shot],
  [DIAGRAM, await swatch("--color-ink-3", 480, 480)],
  [PAGE, new Blob(["<html><script>window.pwned=1</script></html>"])],
  [LOGO, new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=2"/>'])],
  ...Array.from({ length: LONG }, (_, index) => [longSha(index), shot] as const),
])

const requested: string[] = []
const live = new Set<string>()
const create = URL.createObjectURL.bind(URL)
const revoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (object: Blob | MediaSource) => {
  const url = create(object)
  live.add(url)
  return url
}
URL.revokeObjectURL = (url: string) => {
  live.delete(url)
  revoke(url)
}
const realFetch = window.fetch.bind(window)
Object.assign(window, {
  requested,
  live: () => live.size,
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const sha = /\/blobs\/([0-9a-f]{64})$/u.exec(url)?.[1]
    if (sha === undefined) return realFetch(input, init)
    requested.push(sha)
    const blob = blobs.get(sha)
    return blob === undefined
      ? new Response("not found", { status: 404 })
      : new Response(blob, { headers: { "content-type": "application/octet-stream" } })
  },
})

const path = (name: string) => `/projects/demo/attachments/${name}`
const first: readonly Attachment[] = [
  { path: path("screenshot.png"), name: "screenshot.png", type: "image/png", size: 215 * 1024, sha256: SHOT },
  { path: path("brief.md"), name: "brief.md", type: "text/markdown", size: 26, sha256: "d".repeat(64) },
  { path: path("diagram.png"), name: "diagram.png", type: "image/png", size: 1_363_149, sha256: DIAGRAM },
  { path: path("old.png"), name: "old.png", type: "image/png", size: 900, sha256: undefined },
  { path: path("gone.png"), name: "gone.png", type: "image/png", size: 4096, sha256: GONE },
  { path: path("page.png"), name: "page.png", type: "image/png", size: 44, sha256: PAGE },
  { path: path("logo.svg"), name: "logo.svg", type: "image/svg+xml", size: 66, sha256: LOGO },
]
const thread = (index: number): readonly Attachment[] => [
  { path: path(`step-${index}.png`), name: `step-${index}.png`, type: "image/png", size: 4096, sha256: longSha(index) },
]

const params = new URLSearchParams(location.search)
const density = params.get("density") === "panel" ? "panel" : "chat"
const long = params.get("long") === "1"

function App() {
  const [current, setCurrent] = createSignal("a")
  return (
    <main class="mx-auto flex w-full max-w-[760px] flex-col gap-6 p-6">
      <div class="flex gap-2 self-start">
        <button id="before" type="button">
          Before
        </button>
        <button id="switch" type="button" onClick={() => setCurrent("b")}>
          Other thread
        </button>
      </div>
      <SentBlobsScope scope={current()}>
        <Show when={current() === "a"} fallback={<OwnerBubble text="A thread with no files." density={density} />}>
          <OwnerBubble text="Here are the screenshots from the review." attachments={first} density={density} />
          <Show when={long}>
            <For each={Array.from({ length: LONG }, (_, index) => index)}>
              {(index) => <OwnerBubble text={`Step ${index}`} attachments={thread(index)} density={density} />}
            </For>
          </Show>
        </Show>
      </SentBlobsScope>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
