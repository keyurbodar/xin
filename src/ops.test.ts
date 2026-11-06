import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { api, owner } from "../test/support.ts"
import { Counter, type Home } from "../test/worker.ts"
import type { CommandId } from "./ids.ts"

const cmd = (id: string, op: string, args?: unknown) =>
  api("/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }).then((reply) => reply.json())

const count = () =>
  runInDurableObject(
    owner(),
    async (home: Home) => (await home.harness.snapshot(Counter, BACKGROUND_CONTEXT))?.count ?? 0,
  )

describe("ops and receipts", () => {
  it("runs a duplicate command once and returns the first result", async () => {
    const before = await count()
    const first = await cmd("dup-1", "test.bump")
    const again = await cmd("dup-1", "test.bump")
    const racing = await Promise.all([cmd("dup-2", "test.bump", { by: 5 }), cmd("dup-2", "test.bump", { by: 5 })])
    expect(first).toEqual({ t: "ack", id: "dup-1", ok: true, result: before + 1 })
    expect(again).toEqual(first)
    expect(racing[0]).toEqual(racing[1])
    expect(await count()).toBe(before + 6)
  })

  it("keeps receipts across an eviction", async () => {
    const first = await cmd("evict-1", "test.bump")
    const after = await count()
    await evictDurableObject(owner())
    expect(await cmd("evict-1", "test.bump")).toEqual(first)
    expect(await count()).toBe(after)
  })

  it("rejects unknown ops, bad args and actors above the op's ceiling without an effect", async () => {
    const before = await count()
    expect(await cmd("rej-1", "nope")).toMatchObject({ ok: false, error: { code: "unknown_op" } })
    expect(await cmd("rej-2", "test.bump", { by: 0 })).toMatchObject({ ok: false, error: { code: "bad_args" } })
    const agent = await runInDurableObject(owner(), (home: Home) =>
      home.commands.run(
        { id: "rej-3" as CommandId, op: "test.bump", args: {} },
        { kind: "agent", conversationId: ROOT_CONVERSATION_ID },
      ),
    )
    expect(agent).toMatchObject({ kind: "rejected", code: "forbidden" })
    expect(await count()).toBe(before)
    expect((await api("/v1/cmd", { method: "POST", body: "{" })).status).toBe(400)
  })
})
