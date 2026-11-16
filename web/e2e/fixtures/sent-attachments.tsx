import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { OwnerBubble } from "../../src/components/chat/entries.tsx"
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
const blobs = new Map<string, Blob>([
  [SHOT, await swatch("--color-primary", 640, 400)],
  [DIAGRAM, await swatch("--color-ink-3", 480, 480)],
])
const requested: string[] = []
const realFetch = window.fetch.bind(window)
Object.assign(window, {
  requested,
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
const attachments: readonly Attachment[] = [
  { path: path("screenshot.png"), name: "screenshot.png", type: "image/png", size: 215 * 1024, sha256: SHOT },
  { path: path("brief.md"), name: "brief.md", type: "text/markdown", size: 26, sha256: "d".repeat(64) },
  { path: path("diagram.png"), name: "diagram.png", type: "image/png", size: 1_363_149, sha256: DIAGRAM },
  { path: path("old.png"), name: "old.png", type: "image/png", size: 900, sha256: undefined },
  { path: path("gone.png"), name: "gone.png", type: "image/png", size: 4096, sha256: GONE },
]

const density = new URLSearchParams(location.search).get("density") === "panel" ? "panel" : "chat"

render(
  () => (
    <main class="mx-auto flex w-full max-w-[760px] flex-col gap-6 p-6">
      <button id="before" type="button" class="self-start">
        Before
      </button>
      <OwnerBubble text="Here are the screenshots from the review." attachments={attachments} density={density} />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
