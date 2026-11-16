import "../../src/styles/app.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AttachmentCardGrid, MessageAttachments } from "../../src/components/composer/attachment-card.tsx"
import type { UploadedFile } from "../../src/lib/api.ts"
import { createAttachments, type SentAttachment, type Upload } from "../../src/lib/attachments.ts"

type Pending = { readonly progress: (fraction: number) => void; readonly done: () => void; readonly fail: (message: string) => void }

const pending = new Map<string, Pending>()

const upload: Upload = (file, onProgress) =>
  new Promise<UploadedFile>((resolve, reject) => {
    pending.set(file.name, {
      progress: onProgress,
      done: () => resolve({ path: `/projects/demo/attachments/${file.name}`, name: file.name, type: file.type, size: file.size }),
      fail: (message) => reject(new Error(message)),
    })
  })

async function swatch(token: string, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")!
  const style = getComputedStyle(document.documentElement)
  context.fillStyle = style.getPropertyValue("--color-muted")
  context.fillRect(0, 0, width, height)
  context.fillStyle = style.getPropertyValue(token)
  for (let row = 0; row < height; row += 12) context.fillRect(8, row + 4, width * (0.3 + ((row / 12) % 4) * 0.15), 4)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
}

const padded = (blob: Blob, size: number): Blob => new Blob([blob, new Uint8Array(Math.max(0, size - blob.size))])

const shots = await Promise.all([swatch("--color-primary", 96, 96), swatch("--color-ink-3", 96, 96)])
const files = [
  new File([padded(shots[0]!, 215 * 1024)], "screenshot.png", { type: "image/png" }),
  new File([padded(shots[1]!, 1_363_149)], "diagram.png", { type: "image/png" }),
  new File(["# Brief\nShip attachments."], "brief.md", { type: "text/markdown" }),
  new File([new Uint8Array(4096)], "deck.pdf", { type: "application/pdf" }),
  new File([new Uint8Array(51 * 1024 * 1024)], "capture.mov", { type: "video/quicktime" }),
]

const blobs = new Map<string, Blob>([["a".repeat(64), shots[0]!], ["b".repeat(64), shots[1]!]])
const realFetch = window.fetch.bind(window)
Object.assign(window, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const sha = /\/blobs\/([0-9a-f]{64})$/u.exec(url)?.[1]
    const blob = sha === undefined ? undefined : blobs.get(sha)
    if (blob !== undefined) return new Response(blob)
    return realFetch(input, init)
  },
})

const sent: readonly SentAttachment[] = [
  { name: "screenshot.png", type: "image/png", size: 215 * 1024, sha256: "a".repeat(64) },
  { name: "diagram.png", type: "image/png", size: 1_363_149, sha256: "b".repeat(64) },
  { name: "brief.md", type: "text/markdown", size: 26 },
]

function App() {
  const attachments = createAttachments(() => upload)
  const [removed, setRemoved] = createSignal<readonly string[]>([])
  const [opened, setOpened] = createSignal("")
  Object.assign(window, {
    progress: (name: string, fraction: number) => pending.get(name)?.progress(fraction),
    finish: (name: string) => pending.get(name)?.done(),
    fail: (name: string, message: string) => pending.get(name)?.fail(message),
    addAgain: () => attachments.add(files.slice(0, 2)),
  })
  attachments.add(files)
  queueMicrotask(() => {
    pending.get("screenshot.png")?.done()
    pending.get("diagram.png")?.progress(0.42)
    pending.get("brief.md")?.done()
    pending.get("deck.pdf")?.fail("deck.pdf: HTTP 500")
  })
  return (
    <main class="flex max-w-[720px] flex-col gap-6 p-6">
      <button id="before" type="button">
        Before
      </button>
      <AttachmentCardGrid
        items={attachments.items()}
        onRemove={(id) => {
          const name = attachments.items().find((item) => item.id === id)?.file.name ?? id
          setRemoved((current) => [...current, name])
          attachments.remove(id)
        }}
      />
      <output id="removed">{removed().join(",")}</output>
      <output id="ready">{attachments.uploaded().map((file) => file.name).join(",")}</output>
      <div class="flex justify-end">
        <MessageAttachments attachments={sent} onOpen={(index) => setOpened(String(index))} />
      </div>
      <output id="opened">{opened()}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
