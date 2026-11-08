import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { fresh } from "../../test/support.ts"
import { FileIndex, putFile } from "../../src/r2env.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import type { CommandId } from "../../src/ids.ts"
import { INLINE_BUDGET_BYTES, renderTurn, type AttachmentPort } from "./attachments.ts"
import type { MessageAttachment } from "../../src/contracts/message.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

async function upload(stub: Stub, path: string, bytes: Uint8Array): Promise<void> {
  const row = await runInDurableObject(stub, (home: Home) =>
    putFile(env.FILES, new FileIndex(home.db), { path, content: bytes }),
  )
  expect(row.path).toBe(path)
}

async function send(stub: Stub, id: string, text: string, attachments: readonly unknown[]): Promise<void> {
  const outcome = await runInDurableObject(stub, (home: Home) =>
    home.commands.run(
      { id: id as CommandId, op: "message.send", args: { text, clientTs: 1_000, attachments } },
      { kind: "owner" },
    ),
  )
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

async function waitFor(stub: Stub, check: () => Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("condition not reached")
}

type Part = { readonly type: string; readonly text?: string; readonly mimeType?: string; readonly data?: string }

async function userParts(stub: Stub): Promise<readonly Part[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const root = await home.root()
    const page = await root.entries({ order: "ascending" }, 500, undefined, context)
    return page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) => (message.role === "user" ? (message.content as readonly Part[]) : [])),
    )
  })
}

describe("attachments", () => {
  it("names every file and inline-sends an image to a vision model", async () => {
    const stub = fresh()
    await upload(stub, "/projects/attach/diagram.png", PNG)
    await upload(stub, "/projects/attach/brief.txt", new TextEncoder().encode("scope"))
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["attached"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "attach-1", "look at these", [
      { path: "/projects/attach/diagram.png", name: "diagram.png", type: "image/png", size: PNG.byteLength },
      { path: "/projects/attach/brief.txt", name: "brief.txt", type: "text/plain", size: 5 },
    ])
    await fireNow(stub)
    await waitFor(stub, async () => {
      const parts = await userParts(stub)
      return parts.some((part) => part.type === "text" && (part.text ?? "").includes("<attachments>"))
    })

    const parts = await userParts(stub)
    expect(
      parts.map((part) => part.type),
      JSON.stringify(parts).slice(0, 600),
    ).toContain("image")
    const text = parts
      .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
      .join("\n")
    expect(text).toContain("<attachments>")
    expect(text).toContain("- diagram.png (image/png, 12 bytes) at /projects/attach/diagram.png")
    expect(text).toContain("- brief.txt (text/plain, 5 bytes) at /projects/attach/brief.txt")

    const images = parts.filter((part) => part.type === "image")
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ mimeType: "image/png" })
    expect(Buffer.from(images[0]?.data ?? "", "base64")).toEqual(Buffer.from(PNG))
  }, 30_000)

  it("keeps the attachment list on the batch row and never inlines a text file", async () => {
    const stub = fresh()
    await upload(stub, "/projects/attach-two/brief.md", new TextEncoder().encode("# brief"))
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "attach-2", "read this", [
      { path: "/projects/attach-two/brief.md", name: "brief.md", type: "text/markdown", size: 7 },
    ])
    await fireNow(stub)
    await waitFor(stub, async () => (await userParts(stub)).some((part) => part.type === "text"))

    const batch = await runInDurableObject(stub, async (home: Home) => {
      const root = await home.root()
      const page = await root.entries({ order: "ascending" }, 500, undefined, context)
      return page.items.flatMap((entry) => (entry.kind === "xin.batch" ? [entry.data] : []))
    })
    expect(JSON.stringify(batch)).toContain("/projects/attach-two/brief.md")
    expect((await userParts(stub)).filter((part) => part.type === "image")).toHaveLength(0)
  }, 30_000)
})

function portOf(stored: Readonly<Record<string, Uint8Array>>, vision: boolean): AttachmentPort & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    stat: async (path) => {
      const bytes = stored[path]
      return bytes === undefined ? undefined : { size: bytes.byteLength }
    },
    readBytes: async (path) => {
      reads.push(path)
      return stored[path]
    },
    vision: async () => vision,
  }
}

const file = (name: string, type: string, path = `/a/${name}`): MessageAttachment => ({ path, name, type, size: 1 })

describe("the attachment policy", () => {
  it("inlines images only up to one turn budget", async () => {
    const half = new Uint8Array(Math.floor((INLINE_BUDGET_BYTES * 3) / 4)).fill(7)
    const port = portOf({ "/a/one.png": half, "/a/two.png": half }, true)
    const content = await renderTurn(port, 1 as ConversationId, "look", [
      file("one.png", "image/png"),
      file("two.png", "image/png"),
    ])
    expect(Array.isArray(content) ? content.filter((part) => part.type === "image") : []).toHaveLength(1)
    expect(JSON.stringify(content)).toContain("two.png (image/png, ")
  }, 30_000)

  it("leaves out a file storage does not have", async () => {
    const port = portOf({ "/a/real.txt": new Uint8Array([1, 2, 3]) }, false)
    const content = await renderTurn(port, 1 as ConversationId, "read", [
      file("real.txt", "text/plain", "/a/real.txt"),
      file("ghost.txt", "text/plain", "/a/ghost.txt"),
    ])
    const text =
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    expect(text).toContain("real.txt")
    expect(text).not.toContain("ghost.txt")
  }, 30_000)

  it("reads no bytes for a model that cannot see images", async () => {
    const port = portOf({ "/a/one.png": new Uint8Array([1]) }, false)
    const content = await renderTurn(port, 1 as ConversationId, "look", [file("one.png", "image/png")])
    expect(Array.isArray(content) ? content.filter((part) => part.type === "image") : []).toHaveLength(0)
    expect(port.reads).toEqual([])
  }, 30_000)
})
