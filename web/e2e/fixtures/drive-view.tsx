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
  }),
)
const entryOf = (path: string): DriveEntry => ({
  path,
  size: files.get(path)?.length ?? 0,
  type: path.endsWith(".md") ? "text/markdown" : "text/plain",
  sha256: `${path.length.toString(16).padStart(8, "0")}cafe`,
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

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
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
render(
  () => (
    <main class="h-screen w-full max-w-[400px] border-r border-line-1 bg-panel p-2">
      <DriveView conversationId={1} prefer={{ kind: "project", id: "p1" }} projectSlug="atlas" />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
Object.assign(window, { calls, files })
