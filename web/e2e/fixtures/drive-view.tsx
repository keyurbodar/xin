import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { DriveView } from "../../src/components/pane/drive.tsx"
import type { DriveEntry } from "../../src/lib/drive.ts"
import { trackMotion } from "../../src/lib/motion.ts"

const at = Date.now() - 3_600_000
const files = new Map<string, string>(
  Object.entries({
    "AGENTS.md": "# Instructions\n\nKeep replies short.",
    "README.md": "# Atlas\n\nThe project drive.",
    "package.json": '{ "name": "atlas" }',
    "notes.txt": "Ship the tree.",
    "docs/plan.md": "# Plan",
    "docs/design/tokens.css": ":root {}",
    "docs/design/logo.svg": "<svg/>",
    "skills/review/SKILL.md": "---\nname: review\n---",
    "src/index.ts": "export {}",
    "src/app.tsx": "export {}",
    "src/lib/format.ts": "export {}",
    "photos/harbour.png": "",
    "photos/missing.jpg": "",
    "photos/poster.png": "",
  }),
)
const entryOf = (path: string): DriveEntry => ({
  path,
  size: path.endsWith("poster.png") ? 5 * 1024 * 1024 : (files.get(path)?.length ?? 0),
  type: path.endsWith(".md") ? "text/markdown" : path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "text/plain",
  sha256: path.endsWith("missing.jpg") ? "gone" : `${path.length.toString(16).padStart(8, "0")}cafe`,
  updated_at: at,
})
const scopes = [
  { scope: { kind: "project", id: "p1" }, root: "/projects/atlas/", label: "Project" },
  { scope: { kind: "user" }, root: "/me/", label: "Personal" },
]
const calls: string[] = []

const answer = (op: string, args: Record<string, unknown>): unknown => {
  const path = typeof args.path === "string" ? args.path : ""
  switch (op) {
    case "drive.scopes":
      return scopes
    case "drive.list": {
      const prefix = typeof args.prefix === "string" ? args.prefix : ""
      return {
        root: "/projects/atlas/",
        files: [...files.keys()].filter((key) => key.startsWith(prefix)).map(entryOf),
        shares: prefix === "" ? { "README.md": "s1" } : {},
      }
    }
    case "drive.read":
      return { ...entryOf(path), text: files.get(path) ?? null }
    case "drive.history":
      return {
        path,
        current: { sha256: "c0ffee00aa", size: 40, type: "text/plain", at },
        versions: [
          { sha256: "beef0001aa", size: 32, type: "text/plain", at: at - 86_400_000 },
          { sha256: "beef0002aa", size: 18, type: "text/plain", at: at - 172_800_000 },
        ],
      }
    case "drive.move": {
      const from = String(args.from)
      const to = String(args.to)
      files.set(to, files.get(from) ?? "")
      files.delete(from)
      return entryOf(to)
    }
    case "drive.delete":
      files.delete(path)
      return { deleted: true }
    default:
      throw new Error(`fixture has no ${op}`)
  }
}

const blobs: string[] = []
async function blob(url: string): Promise<Response> {
  blobs.push(url.slice(url.lastIndexOf("/") + 1))
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (url.endsWith("/gone")) return new Response("not found", { status: 404 })
  const canvas = new OffscreenCanvas(320, 200)
  const paint = canvas.getContext("2d")
  if (paint === null) throw new Error("no 2d context")
  const sky = paint.createLinearGradient(0, 0, 0, 200)
  sky.addColorStop(0, "#5b7a99")
  sky.addColorStop(1, "#d9c3a5")
  paint.fillStyle = sky
  paint.fillRect(0, 0, 320, 200)
  paint.fillStyle = "#2f3e4c"
  paint.fillRect(0, 140, 320, 60)
  return new Response(await canvas.convertToBlob({ type: "image/png" }), { headers: { "content-type": "application/octet-stream" } })
}

const urls = { created: [] as string[], revoked: [] as string[] }
const create = URL.createObjectURL.bind(URL)
const revoke = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob: Blob | MediaSource) => {
  const href = create(blob)
  urls.created.push(href)
  return href
}
URL.revokeObjectURL = (href: string) => {
  urls.revoked.push(href)
  revoke(href)
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.includes("/blobs/")) return blob(url)
  if (!url.endsWith("/v1/cmd")) throw new Error(`fixture fetch ${url}`)
  const body: unknown = JSON.parse(String(init?.body))
  const frames = (Array.isArray(body) ? body : [body]) as { id: string; op: string; args: Record<string, unknown> }[]
  const acks = frames.map((frame) => {
    calls.push(frame.op === "drive.list" ? `drive.list:${String(frame.args.prefix ?? "")}` : frame.op)
    try {
      return { t: "ack", id: frame.id, ok: true, result: answer(frame.op, frame.args) }
    } catch (problem) {
      return { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: String(problem) } }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]), { headers: { "content-type": "application/json" } })
}

Object.assign(window, { fetch: fakeFetch })
trackMotion()
const unmount = render(
  () => (
    <main class="h-screen w-full max-w-[400px] border-r border-line-1 bg-panel p-2">
      <DriveView conversationId={1} prefer={{ kind: "project", id: "p1" }} projectSlug="atlas" />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
Object.assign(window, { calls, files, blobs, urls, unmount })
