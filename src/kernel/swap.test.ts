import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, rowState } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const PATH = "/notes/a.md"
const CONTENT = "hello fake"

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

const toolResults = async (home: Home): Promise<string[]> => {
  const page = await (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)
  return page.items.flatMap((entry: EntryRecord) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    ),
  )
}

const r2Texts = async (): Promise<string[]> => {
  const texts: string[] = []
  for (const object of (await env.FILES.list()).objects) {
    const body = await env.FILES.get(object.key)
    if (body !== null) texts.push(await body.text())
  }
  return texts
}

describe("files seam", () => {
  it("swaps the files service for an in-memory provider and then restores the real one", async () => {
    const stub = fresh()

    const disabled = await cmd(stub, "off", "plugin.enable", { id: "files", enabled: false })
    expect(disabled.result).toMatchObject({ application: "applied", row: { state: { kind: "disabled" } } })
    expect(await rowState(stub, "tool-files")).toEqual({ kind: "pending" })

    const inserted = await cmd(stub, "in", "plugin.insert", { id: "fake-files", plugin: "fake-files", config: {} })
    expect(inserted.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })
    expect(await rowState(stub, "tool-files")).toEqual({ kind: "active" })

    respond([
      call("write", { path: PATH, content: CONTENT }),
      call("read", { path: PATH }),
      fauxAssistantMessage("done"),
    ])
    const results = await runInDurableObject(stub, async (home: Home) => {
      const before = (await toolResults(home)).length
      await home.chooseModel(M8_MODEL)
      await home.submit("go", `swap-${crypto.randomUUID()}`)
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return (await toolResults(home)).slice(before)
    })
    expect(results.some((text) => text.includes(`Successfully wrote to ${PATH}`))).toBe(true)
    expect(results.some((text) => text.includes(CONTENT))).toBe(true)

    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.files.read(PATH))).toBe(CONTENT)
    const indexed = await runInDurableObject(stub, (home: Home) =>
      home.db.get("SELECT 1 AS n FROM files WHERE path = ?", PATH),
    )
    expect(indexed).toBeUndefined()
    expect(await r2Texts()).not.toContain(CONTENT)

    expect(await cmd(stub, "rm", "plugin.remove", { id: "fake-files" })).toMatchObject({ ok: true })
    const enabled = await cmd(stub, "on", "plugin.enable", { id: "files", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })
    expect(await rowState(stub, "tool-files")).toEqual({ kind: "active" })
    expect(await runInDurableObject(stub, (home: Home) => home.loader.ctx.files.read(PATH))).toBeUndefined()
    expect(await r2Texts()).not.toContain(CONTENT)
  })
})
