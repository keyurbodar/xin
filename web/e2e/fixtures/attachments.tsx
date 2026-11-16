import "../../src/styles/app.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AttachmentGrid } from "../../src/components/composer/attachments.tsx"
import type { UploadedFile } from "../../src/lib/api.ts"
import { createAttachments, type Upload } from "../../src/lib/attachments.ts"

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

const hostile = [
  new File([shots[0]!], '<img src=x onerror="window.pwned=1">.png', { type: "image/png" }),
  new File(["x"], "../../x.txt", { type: "text/plain" }),
  new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=2"><script>window.pwned=3</script></svg>'], "evil.svg", { type: "image/svg+xml" }),
  new File(["<html><script>window.pwned=4</script></html>"], "page.png", { type: "image/png" }),
]

function App() {
  const attachments = createAttachments(() => upload)
  const [removed, setRemoved] = createSignal<readonly string[]>([])
  Object.assign(window, {
    progress: (name: string, fraction: number) => pending.get(name)?.progress(fraction),
    finish: (name: string) => pending.get(name)?.done(),
    fail: (name: string, message: string) => pending.get(name)?.fail(message),
    addAgain: () => attachments.add(files.slice(0, 2)),
    addHostile: () => attachments.add(hostile),
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
      <div class="rounded-lg bg-card shadow-composer">
        <textarea id="field" aria-label="Message" class="block w-full bg-transparent px-4 pt-3 text-base text-ink outline-none" />
        <AttachmentGrid
        items={attachments.items()}
        onRemove={(id) => {
          const name = attachments.items().find((item) => item.id === id)?.file.name ?? id
          setRemoved((current) => [...current, name])
          attachments.remove(id)
        }}
        />
      </div>
      <output id="removed">{removed().join(",")}</output>
      <output id="ready">{attachments.uploaded().map((file) => file.name).join(",")}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
