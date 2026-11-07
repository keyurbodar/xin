import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { EntryRecord } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Page = { readonly ids: readonly number[]; readonly nextBefore?: number }

function pageOf(value: unknown): Page {
  if (typeof value !== "object" || value === null) throw new Error("history.page returned no object")
  const entries = Reflect.get(value, "entries")
  const next = Reflect.get(value, "nextBefore")
  const ids = Array.isArray(entries)
    ? entries.map((entry) => {
        const id = typeof entry === "object" && entry !== null ? Reflect.get(entry, "id") : undefined
        if (typeof id !== "number") throw new Error("history.page returned an entry without an id")
        return id
      })
    : []
  return { ids, ...(typeof next === "number" ? { nextBefore: next } : {}) }
}

describe("history.page", () => {
  it("pages older entries backwards until the transcript starts", async () => {
    const stub = fresh()
    const { rootId, all } = await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      await home.submit("hello", "history-1")
      await home.harness.waitForIdle(context)
      const root = await home.root()
      const page = await root.entries({ order: "ascending" }, 500, undefined, context)
      return { rootId: root.id, all: page.items.map((entry: EntryRecord) => entry.id) }
    })
    expect(all.length).toBeGreaterThan(2)

    const pages: number[][] = []
    let before: number | undefined
    for (let index = 0; index < 100; index += 1) {
      const ack = await cmd(stub, `history-${index}`, "history.page", {
        conversationId: rootId,
        limit: 2,
        ...(before === undefined ? {} : { before }),
      })
      expect(ack.ok, JSON.stringify(ack)).toBe(true)
      const page = pageOf(ack.result)
      expect(page.ids.length).toBeLessThanOrEqual(2)
      expect(page.ids).toEqual([...page.ids].toSorted((left, right) => left - right))
      pages.push([...page.ids])
      before = page.nextBefore
      if (before === undefined) break
    }
    expect(before).toBeUndefined()
    expect(pages.flat().toSorted((left, right) => left - right)).toEqual(
      [...all].toSorted((left, right) => left - right),
    )
  })

  it("starts a page at the first entry the view is missing", async () => {
    const stub = fresh()
    const { rootId, all, before, windowIds } = await runInDurableObject(stub, async (home: Home) => {
      home.script(["first answer", "second answer", "third answer"])
      await home.chooseModel(FAUX_MODEL)
      for (const [index, text] of ["first", "second", "third"].entries()) {
        await home.submit(text, `window-${index}`)
        await home.harness.waitForIdle(context)
      }
      const root = await home.root()
      const page = await root.entries({ order: "ascending" }, 500, undefined, context)
      const watch = await root.watch(context, { min: 2, max: 3 })
      return {
        rootId: root.id,
        all: page.items.map((entry: EntryRecord) => entry.id),
        before: watch.value.before,
        windowIds: watch.value.entries.map((entry) => entry.id),
      }
    })
    expect(before).toBeDefined()
    expect(windowIds.length).toBeLessThan(all.length)

    const ack = await cmd(stub, "history-window", "history.page", {
      conversationId: rootId,
      before,
      limit: 200,
    })
    expect(ack.ok, JSON.stringify(ack)).toBe(true)
    expect(pageOf(ack.result).ids).toEqual(all.filter((id) => !windowIds.includes(id)))
  })

  it("rejects an unknown conversation and an empty window before the first entry", async () => {
    const stub = fresh()
    const rootId = await runInDurableObject(stub, async (home: Home) => (await home.root()).id)
    expect(
      await cmd(stub, "history-missing", "history.page", { conversationId: rootId + 1_000 }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    const empty = await cmd(stub, "history-zero", "history.page", { conversationId: rootId, before: 0 })
    expect(empty.ok).toBe(true)
    expect(pageOf(empty.result).ids).toEqual([])
  })
})
