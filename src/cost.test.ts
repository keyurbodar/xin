import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M5_MODEL } from "../test/plugins/m5.ts"
import { eventually, fresh } from "../test/support.ts"
import { freshProduct, measureTurn, type Move, productCmd, type ProductStub, type TurnCost } from "../test/turncost.ts"
import { FAUX_MODEL, type Home } from "../test/worker.ts"

const context = BACKGROUND_CONTEXT
const MESSAGE_ROW_BOUND = 18
const MESSAGE_READ_BOUND = 22
const DELEGATE_ROW_BOUND = 36
const DELEGATE_READ_BOUND = 46

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly result?: unknown }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

/** What Cloudflare bills: rows written by SQL (index entries included), key-value puts and alarm writes. */
async function written(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (home: Home) => {
    const meter = home.meter()
    return meter.sql.writes + meter.kv.writes + meter.alarm.writes
  })
}

/** What Cloudflare bills as reads: SQL rows read, key-value gets and alarm reads. */
async function read(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (home: Home) => {
    const meter = home.meter()
    return meter.sql.reads + meter.kv.reads + meter.alarm.reads
  })
}

const idle = (stub: Stub): Promise<void> => runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))

const intakeDone = async (home: Home): Promise<boolean> => {
  const items = await home.intake()
  return items.length > 0 && items.every((item) => item.status === "done")
}

async function reportCount(home: Home): Promise<number> {
  return (await home.intake()).filter((item) => item.kind === "report").length
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

describe("a message, in what the platform bills", () => {
  it("answers one message within the measured row bound", async () => {
    const stub = fresh()
    const rootId = await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
      return (await home.root()).id
    })
    const before = await written(stub)
    const readBefore = await read(stub)

    const sent = await cmd(stub, "cost-message", "message.send", { text: "hello" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)
    await eventually(stub, (home: Home) => intakeDone(home))
    await idle(stub)

    const after = await written(stub)
    const readAfter = await read(stub)
    expect(await runInDurableObject(stub, (home: Home) => replies(home, rootId))).toEqual(["one answer"])
    expect(after - before).toBeLessThanOrEqual(MESSAGE_ROW_BOUND)
    expect(readAfter - readBefore).toBeLessThanOrEqual(MESSAGE_READ_BOUND)
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
    const readBefore = await read(stub)

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
    await eventually(stub, (home: Home) => intakeDone(home))
    await idle(stub)

    const after = await written(stub)
    const readAfter = await read(stub)
    expect(after - before).toBeLessThanOrEqual(DELEGATE_ROW_BOUND)
    expect(readAfter - readBefore).toBeLessThanOrEqual(DELEGATE_READ_BOUND)
  })
})

/** A file the edit tasks read and change: long enough that a read result is a real share of the prompt. */
const source = (name: string): string =>
  Array.from(
    { length: 40 },
    (_, index) => `export const ${name}${index} = (value: number): number => value + ${index}`,
  ).join("\n")

async function seed(stub: ProductStub, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const put = await productCmd(stub, `seed-${name}`, "file.put", { path: `/projects/p/${name}`, text: source(name) })
    expect(put.ok, JSON.stringify(put)).toBe(true)
  }
}

const edit = (name: string): Move => ({
  calls: [
    { name: "edit", args: { path: `/projects/p/${name}`, edits: [{ oldText: `${name}0`, newText: `${name}0x` }] } },
  ],
})

type TurnTask = {
  readonly name: string
  readonly text: string
  readonly files: readonly string[]
  readonly moves: readonly Move[]
  readonly bound: Partial<Record<keyof TurnCost, number>>
}

/**
 * What a turn costs the model, and the ceiling each number may not pass. The bounds sit just above the measured
 * value, so a change that doubles one — a second copy of the prompt, a tool result echoed twice, an extra round
 * trip, a plugin adding a kilobyte of declarations — fails here instead of on the owner's bill.
 */
const TURN_TASKS: readonly TurnTask[] = [
  {
    name: "a two-file edit",
    text: "rename the first constant in a.ts and b.ts",
    files: ["a.ts", "b.ts"],
    moves: [
      {
        calls: [
          { name: "read", args: { path: "/projects/p/a.ts" } },
          { name: "read", args: { path: "/projects/p/b.ts" } },
        ],
      },
      edit("a.ts"),
      edit("b.ts"),
      { answer: "renamed both" },
    ],
    bound: {
      modelCalls: 4,
      promptBytes: 87_000,
      freshBytes: 24_000,
      schemaBytes: 16_000,
      toolResultBytes: 6_000,
      wallMs: 5_000,
    },
  },
  {
    name: "a question over three files",
    text: "what do a.ts, b.ts and c.ts add up to",
    files: ["a.ts", "b.ts", "c.ts"],
    moves: [
      {
        calls: [
          { name: "read", args: { path: "/projects/p/a.ts" } },
          { name: "read", args: { path: "/projects/p/b.ts" } },
          { name: "read", args: { path: "/projects/p/c.ts" } },
        ],
      },
      { answer: "they add" },
    ],
    bound: { modelCalls: 2, promptBytes: 43_000, freshBytes: 26_000, toolResultBytes: 8_400, wallMs: 5_000 },
  },
  {
    name: "a call that fails and retries",
    text: "read missing.ts",
    files: ["a.ts"],
    moves: [
      { calls: [{ name: "read", args: { path: "/projects/p/missing.ts" } }] },
      { calls: [{ name: "read", args: { path: "/projects/p/a.ts" } }] },
      { answer: "read it" },
    ],
    bound: { modelCalls: 3, promptBytes: 54_500, freshBytes: 20_500, toolResultBytes: 3_000, wallMs: 5_000 },
  },
]

describe("a turn, in what the model bills", () => {
  for (const task of TURN_TASKS) {
    it(`keeps ${task.name} within the measured turn bound`, async () => {
      const stub = freshProduct()
      await seed(stub, task.files)
      const cost = await measureTurn(stub, `turn-${task.name.replaceAll(" ", "-")}`, task.moves, { text: task.text })

      expect(cost.modelCalls, "model calls").toBe(task.moves.length)
      for (const [key, limit] of Object.entries(task.bound))
        expect(cost[key as keyof TurnCost], key).toBeLessThanOrEqual(limit)
      for (const request of cost.requests) expect(request.systemEntries, "system entries").toBe(1)
    })
  }

  it("adds only the new messages to a turn that follows another", async () => {
    const stub = freshProduct()
    await seed(stub, ["a.ts"])
    const moves: readonly Move[] = [{ calls: [{ name: "read", args: { path: "/projects/p/a.ts" } }] }, { answer: "ok" }]
    const first = await measureTurn(stub, "warm-1", moves, { text: "read a.ts" })
    const warm = await measureTurn(stub, "warm-2", moves, { text: "read it again", carry: first.carry })

    expect(warm.modelCalls).toBe(2)
    expect(warm.promptBytes).toBeLessThanOrEqual(50_000)
    expect(warm.freshBytes).toBeLessThanOrEqual(3_100)
    expect(warm.toolResultBytes).toBeLessThanOrEqual(2_800)
    for (const request of warm.requests) expect(request.systemEntries, "system entries").toBe(1)
  })
})
