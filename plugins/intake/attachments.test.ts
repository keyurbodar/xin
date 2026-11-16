import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Message } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { OWNER_HEADERS } from "../../test/support.ts"
import { blobKey, sha256 } from "../../src/r2env.ts"
import { FAUX_MODEL, type Home, TEXT_ONLY_MODEL } from "../../test/worker.ts"
import type { CommandId } from "../../src/ids.ts"
import type { MessageAttachment } from "../../src/contracts/message.ts"
import { IMAGE_BUDGET_BYTES, renderTurn, TEXT_BUDGET_BYTES, type AttachmentPort } from "./attachments.ts"

const context = BACKGROUND_CONTEXT

const owner = () => env.HOME.get(env.HOME.idFromName("owner"))

type Stub = ReturnType<typeof owner>

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** The browser's route: `PUT /files/<path>` through the Worker, which hashes into R2 and commits the row. */
async function upload(path: string, bytes: Uint8Array, type: string): Promise<void> {
  const reply = await exports.default.fetch(
    new Request(`https://ingle.test/files${path}`, {
      method: "PUT",
      headers: { ...OWNER_HEADERS, "content-type": type },
      body: bytes,
    }),
  )
  expect(reply.status, await reply.clone().text()).toBe(200)
}

async function send(stub: Stub, id: string, text: string, attachments: readonly unknown[]) {
  return runInDurableObject(stub, (home: Home) =>
    home.commands.run(
      { id: id as CommandId, op: "message.send", args: { text, clientTs: 1_000, attachments } },
      { kind: "owner" },
    ),
  )
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

type Part = { readonly type: string; readonly text?: string; readonly mimeType?: string; readonly data?: string }

const partsOf = (message: Message): readonly Part[] =>
  message.role === "user" && Array.isArray(message.content) ? (message.content as readonly Part[]) : []

/** The user message of the first model request whose text carries `marker`. */
async function requested(stub: Stub, marker: string): Promise<readonly Part[]> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = await runInDurableObject(stub, (home: Home) =>
      home
        .modelRequests()
        .flatMap((messages) => messages.map(partsOf))
        .find((parts) => parts.some((part) => (part.text ?? "").includes(marker))),
    )
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`no model request carried ${marker}`)
}

const textOf = (parts: readonly Part[]): string =>
  parts.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")

describe("attachments end to end", () => {
  it("stores the upload in R2, records it on the message and sends a vision model the image", async () => {
    const stub = owner()
    await upload("/projects/attach/attachments/diagram.png", PNG, "image/png")
    await upload("/projects/attach/attachments/brief.md", new TextEncoder().encode("# brief\nship it"), "text/markdown")
    const digest = await sha256(PNG)
    expect(await env.FILES.head(blobKey(digest))).not.toBeNull()

    await runInDurableObject(stub, async (home: Home) => {
      home.script(["seen"])
      await home.chooseModel(FAUX_MODEL)
    })
    const outcome = await send(stub, "attach-vision", "vision marker", [
      { path: "/projects/attach/attachments/diagram.png", name: "diagram.png", type: "image/png", size: 999 },
      { path: "/projects/attach/attachments/brief.md", name: "brief.md", type: "text/markdown" },
    ])
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })

    const stored = await runInDurableObject(stub, async (home: Home) =>
      (await home.intake()).filter((item) => item.commandId === "attach-vision").map((item) => item.body),
    )
    const recorded: unknown = JSON.parse(stored[0] ?? "{}").attachments
    expect(recorded).toEqual([
      {
        path: "/projects/attach/attachments/diagram.png",
        name: "diagram.png",
        type: "image/png",
        size: PNG.byteLength,
        sha256: digest,
      },
      expect.objectContaining({ path: "/projects/attach/attachments/brief.md", type: "text/markdown", size: 15 }),
    ])

    await fireNow(stub)
    const parts = await requested(stub, "vision marker")
    const images = parts.filter((part) => part.type === "image")
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ mimeType: "image/png" })
    expect(Buffer.from(images[0]?.data ?? "", "base64")).toEqual(Buffer.from(PNG))
    const text = textOf(parts)
    expect(text).toContain("- diagram.png (image/png, 12 bytes) at /projects/attach/attachments/diagram.png: shown below")
    expect(text).toContain('<file path="/projects/attach/attachments/brief.md">\n# brief\nship it\n</file>')

    const batch = await runInDurableObject(stub, async (home: Home) => {
      const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
      return page.items.flatMap((entry) => (entry.kind === "xin.batch" ? [entry.data] : []))
    })
    expect(JSON.stringify(batch)).toContain(digest)

    const blob = await exports.default.fetch(new Request(`https://ingle.test/blobs/${digest}`, { headers: OWNER_HEADERS }))
    expect(blob.status).toBe(200)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG)
    const refused = await exports.default.fetch(
      new Request(`https://ingle.test/blobs/${digest}`, { headers: { authorization: "Bearer nope" } }),
    )
    expect(refused.status).toBe(401)
    await refused.body?.cancel()
  }, 30_000)

  it("gives a model without image input a note instead of the image", async () => {
    const stub = owner()
    await upload("/projects/attach/attachments/photo.png", PNG, "image/png")
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(TEXT_ONLY_MODEL)
    })
    const outcome = await send(stub, "attach-text-only", "text-only marker", [
      { path: "/projects/attach/attachments/photo.png", name: "photo.png", type: "image/png" },
    ])
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
    await fireNow(stub)

    const parts = await requested(stub, "text-only marker")
    expect(parts.filter((part) => part.type === "image")).toHaveLength(0)
    expect(textOf(parts)).toContain(
      "- photo.png (image/png, 12 bytes) at /projects/attach/attachments/photo.png: not shown, this model does not take images",
    )
  }, 30_000)

  it("refuses a message that names a file the files index does not hold", async () => {
    const outcome = await send(owner(), "attach-ghost", "look", [
      { path: "/projects/attach/attachments/ghost.png", name: "ghost.png", type: "image/png" },
    ])
    expect(outcome).toMatchObject({ kind: "rejected", code: "bad_args" })
    expect(JSON.stringify(outcome)).toContain("ghost.png is not stored")
  }, 30_000)
})

function portOf(stored: Readonly<Record<string, Uint8Array>>, vision: boolean): AttachmentPort & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readBlob: async (sha) => {
      reads.push(sha)
      return stored[sha]
    },
    vision: async () => vision,
  }
}

const file = (name: string, type: string, size: number): MessageAttachment => ({
  path: `/a/${name}`,
  name,
  type,
  size,
  sha256: name,
})

const imagesOf = (content: Awaited<ReturnType<typeof renderTurn>>) =>
  Array.isArray(content) ? content.filter((part) => part.type === "image") : []

const textIn = (content: Awaited<ReturnType<typeof renderTurn>>): string =>
  typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

describe("the attachment policy", () => {
  it("inlines images only up to one turn budget", async () => {
    const size = Math.floor((IMAGE_BUDGET_BYTES * 3) / 4)
    const half = new Uint8Array(size).fill(7)
    const port = portOf({ "one.png": half, "two.png": half }, true)
    const content = await renderTurn(port, 1 as ConversationId, "look", [
      file("one.png", "image/png", size),
      file("two.png", "image/png", size),
    ])
    expect(imagesOf(content)).toHaveLength(1)
    expect(port.reads).toEqual(["one.png"])
    expect(textIn(content)).toContain("two.png (image/png, 786432 bytes) at /a/two.png: not shown, over this turn's")
  }, 30_000)

  it("inlines text files up to the text budget and lists the rest", async () => {
    const small = new TextEncoder().encode("hello")
    const port = portOf({ "notes.txt": small, "big.json": new Uint8Array(TEXT_BUDGET_BYTES) }, false)
    const content = await renderTurn(port, 1 as ConversationId, "read", [
      file("big.json", "application/json", TEXT_BUDGET_BYTES + 1),
      file("notes.txt", "text/plain", small.byteLength),
    ])
    expect(port.reads).toEqual(["notes.txt"])
    const text = textIn(content)
    expect(text).toContain('<file path="/a/notes.txt">\nhello\n</file>')
    expect(text).toContain("big.json (application/json, 65537 bytes) at /a/big.json: not inlined")
  }, 30_000)

  it("treats an SVG as text, since providers take only raster images", async () => {
    const svg = new TextEncoder().encode("<svg/>")
    const port = portOf({ "logo.svg": svg }, true)
    const content = await renderTurn(port, 1 as ConversationId, "see", [file("logo.svg", "image/svg+xml", 6)])
    expect(imagesOf(content)).toHaveLength(0)
    expect(textIn(content)).toContain("<svg/>")
  }, 30_000)

  it("names any other file by path and reads none of it", async () => {
    const port = portOf({ "deck.pdf": new Uint8Array(3) }, true)
    const content = await renderTurn(port, 1 as ConversationId, "see", [file("deck.pdf", "application/pdf", 3)])
    expect(port.reads).toEqual([])
    expect(textIn(content)).toContain("- deck.pdf (application/pdf, 3 bytes) at /a/deck.pdf\n</attachments>")
  }, 30_000)

  it("reads no bytes for a model that cannot see images", async () => {
    const port = portOf({ "one.png": new Uint8Array([1]) }, false)
    const content = await renderTurn(port, 1 as ConversationId, "look", [file("one.png", "image/png", 1)])
    expect(imagesOf(content)).toHaveLength(0)
    expect(port.reads).toEqual([])
    expect(textIn(content)).toContain("not shown, this model does not take images")
  }, 30_000)

  it("says so when a recorded blob is gone", async () => {
    const port = portOf({}, true)
    const content = await renderTurn(port, 1 as ConversationId, "look", [file("gone.png", "image/png", 1)])
    expect(textIn(content)).toContain("gone.png (image/png, 1 bytes) at /a/gone.png: no longer stored")
  }, 30_000)
})
