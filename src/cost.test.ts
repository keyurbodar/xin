import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M5_MODEL } from "../test/plugins/m5.ts"
import { eventually, fresh } from "../test/support.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"

const context = BACKGROUND_CONTEXT
const MESSAGE_ROW_BOUND = 60
const DELEGATE_ROW_BOUND = 250

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly result?: unknown }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

async function written(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_home: Home, state) => {
    const row = state.storage.sql.exec<{ n: number }>("SELECT total_changes() AS n").one()
    return Promise.resolve(row.n)
  })
}

const idle = (stub: Stub): Promise<void> => runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))

const inboundDone = async (home: Home): Promise<boolean> => {
  const rows = await home.db.all<{ status: string }>("SELECT status FROM inbound")
  return rows.length > 0 && rows.every((row) => row.status === "done")
}

async function reportCount(home: Home): Promise<number> {
  const row = await home.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'report'")
  return row?.n ?? 0
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

async function replies(home: Home, conversationId: number): Promise<string[]> {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "assistant").map(textOf),
  )
}

function projectOf(result: unknown): { readonly id: string; readonly coordinatorId: number } {
  if (typeof result !== "object" || result === null) throw new Error("project.create returned no object")
  const id = Reflect.get(result, "id")
  const coordinatorId = Reflect.get(result, "coordinatorId")
  if (typeof id !== "string" || typeof coordinatorId !== "number") throw new Error("project.create returned no ids")
  return { id, coordinatorId }
}

describe("DO SQLite rows written", () => {
  it("answers one message within the measured row bound", async () => {
    const stub = fresh()
    const rootId = await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      return (await home.root()).id
    })
    const before = await written(stub)

    const sent = await cmd(stub, "cost-message", "message.send", { text: "hello" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)
    await eventually(stub, (home: Home) => inboundDone(home))
    await idle(stub)

    const after = await written(stub)
    expect(await runInDurableObject(stub, (home: Home) => replies(home, rootId))).toEqual(["one answer"])
    expect(after - before).toBeLessThanOrEqual(MESSAGE_ROW_BOUND)
  })

  it("delegates, reports and replies within the measured row bound", async () => {
    const stub = fresh()
    const created = await cmd(stub, "cost-project", "project.create", { slug: "cost", name: "cost" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = projectOf(created.result)
    await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
      if (conversation === undefined) throw new Error("no coordinator conversation")
      await conversation.configure({ model: M5_MODEL }, context)
    })
    const before = await written(stub)

    const sent = await cmd(stub, "cost-delegate", "message.send", {
      conv: project.coordinatorId,
      text: "delegate one",
    })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => (await reportCount(home)) === 1)
    await idle(stub)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => (await replies(home, project.coordinatorId)).includes("delegated"))
    await eventually(stub, (home: Home) => inboundDone(home))
    await idle(stub)

    const after = await written(stub)
    expect(after - before).toBeLessThanOrEqual(DELEGATE_ROW_BOUND)
  })
})
