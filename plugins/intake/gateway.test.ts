import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { type Conversation, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { M2_MODEL, script as scriptM2 } from "../../test/plugins/m2.ts"
import { connect, eventually, fresh, owner } from "../../test/support.ts"
import { decrypt, pushTopic, subscriber, type Subscriber } from "../../test/webpush.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { createGateway, enqueue, type IntakeHost } from "./gateway.ts"
import { IntakeDoc, type IntakeItem } from "../../src/contracts/intake.ts"
import type { CommandId } from "../../src/ids.ts"

const context = BACKGROUND_CONTEXT

const command = (stub: ReturnType<typeof fresh>, id: string, op: string, args: unknown = {}) =>
  runInDurableObject(stub, (home: Home) => home.commands.run({ id: id as CommandId, op, args }, { kind: "owner" }))

const send = async (stub: ReturnType<typeof fresh>, id: string, text: string, clientTs: number) => {
  const outcome = await command(stub, id, "message.send", { text, clientTs })
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
  return outcome
}

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
  return [...page.items]
}

const texts = (entries: readonly EntryRecord[], role: "user" | "assistant"): string[] =>
  entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === role && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : message.role === role && typeof message.content === "string"
          ? [message.content]
          : [],
    ),
  )

const rows = (stub: ReturnType<typeof fresh>): Promise<readonly IntakeItem[]> =>
  runInDurableObject(stub, (home: Home) => home.intake())

const users = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, async (home: Home) => texts(await history(await home.root()), "user"))

const answers = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, async (home: Home) => texts(await history(await home.root()), "assistant"))

async function fireNow(stub: ReturnType<typeof fresh>): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

const transcriptOf = (stub: ReturnType<typeof fresh>): Promise<readonly EntryRecord[]> =>
  runInDurableObject(
    stub,
    async (home: Home) => (await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)).items,
  )

/** The transcript position of the first entry whose `role` message carries `text`; -1 when none does. */
const positionOf = (entries: readonly EntryRecord[], role: "user" | "assistant", text: string): number =>
  entries.findIndex((entry) =>
    (entry.model ?? []).some((message) => message.role === role && JSON.stringify(message.content).includes(text)),
  )

describe("gateway intake and dispatch", () => {
  it("drops done rows past the retention window on the alarm, not only at boot", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      await home.harness.commit(async (tx) => {
        const doc = await tx.doc(IntakeDoc)
        doc.items.push({
          id: 1,
          target: 1,
          kind: "user",
          commandId: "old-row",
          body: "{}",
          clientTs: 1,
          firstAt: 1,
          fireAt: Date.now() - 8 * 24 * 60 * 60_000,
          status: "done",
          batchId: "batch-old",
        })
        doc.nextId = 2
      }, BACKGROUND_CONTEXT)
      await home.arm(home.harness.wake())
    })
    await runDurableObjectAlarm(stub)
    expect(await rows(stub)).toEqual([])
  })

  it("refuses a new message once the month's spend reaches the cap, and takes it again once raised", async () => {
    const stub = fresh()
    const day = new Date().toISOString().slice(0, 10)
    expect(await command(stub, "cap-set", "usage.cap.set", { usd: 5 })).toMatchObject({ kind: "ok" })
    expect(await command(stub, "cap-msg-1", "message.send", { text: "before the cap", clientTs: 1 })).toMatchObject({
      kind: "ok",
    })
    await runInDurableObject(stub, (home: Home) =>
      home.db.run("INSERT INTO usage_daily (day, spend, tokens) VALUES (?, 6, 1)", day),
    )
    const refused = await command(stub, "cap-msg-2", "message.send", { text: "over the cap", clientTs: 2 })
    expect(refused).toMatchObject({ kind: "rejected", code: "forbidden" })
    expect(await command(stub, "cap-clear", "usage.cap.set", { clear: true })).toMatchObject({ kind: "ok" })
    expect(await command(stub, "cap-msg-3", "message.send", { text: "cap raised", clientTs: 3 })).toMatchObject({
      kind: "ok",
    })
  })

  it("answers a burst of three messages with one turn", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["one answer"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "b1", "so like", 1_000)
    await send(stub, "b2", "https://x.test", 2_000)
    await send(stub, "b3", "can u setup", 3_000)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => texts(await history(await home.root()), "assistant").length === 1)
    expect(await answers(stub)).toEqual(["one answer"])
    const said = await users(stub)
    expect(said).toHaveLength(1)
    const text = said[0] ?? ""
    expect(text.indexOf("so like")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("so like")).toBeLessThan(text.indexOf("https://x.test"))
    expect(text.indexOf("https://x.test")).toBeLessThan(text.indexOf("can u setup"))
    await eventually(stub, async (home: Home) => (await home.intake()).every((item) => item.status === "done"))
    const batches = new Set((await rows(stub)).map((item) => item.batchId))
    expect(batches.size).toBe(1)
  })

  it("stores a retried message command once", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["ok"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "dup", "hello", 1_000)
    await send(stub, "dup", "hello", 1_000)
    expect(await rows(stub)).toHaveLength(1)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => texts(await history(await home.root()), "assistant").length === 1)
    expect(await users(stub)).toHaveLength(1)
  })

  it("stops a running turn", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "s1", "do the thing", 1_000)
    await fireNow(stub)
    await runInDurableObject(stub, (home: Home) => home.hanging.promise)
    const stopped = await command(stub, "stop-1", "conv.stop")
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ kind: "ok", result: { stopped: true } })
    const live = await runInDurableObject(stub, async (home: Home) =>
      home.harness.snapshot(LiveDoc, (await home.root()).id, context),
    )
    expect(live?.run).toBeUndefined()
    expect(await answers(stub)).toEqual([])
  })

  it("restarts an untouched turn when another batch arrives", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang", "combined"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "r1", "alpha", 1_000)
    await fireNow(stub)
    await runInDurableObject(stub, (home: Home) => home.hanging.promise)
    await send(stub, "r2", "beta", 2_000)
    await fireNow(stub)
    await eventually(stub, async (home: Home) =>
      texts(await history(await home.root()), "assistant").includes("combined"),
    )
    expect(await answers(stub)).toEqual(["combined"])
    const said = await users(stub)
    expect(said).toHaveLength(2)
    const last = said.at(-1) ?? ""
    expect(last.indexOf("alpha")).toBeGreaterThanOrEqual(0)
    expect(last.indexOf("alpha")).toBeLessThan(last.indexOf("beta"))
  })

  it("steers into the running turn instead of waiting for its answer", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      scriptM2([
        fauxAssistantMessage([fauxToolCall("pause", { ms: 3_000 }, { id: "pause-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ])
      await (await home.root()).configure({ model: M2_MODEL }, context)
    })
    await send(stub, "t1", "alpha", 1_000)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => {
      const live = await home.harness.snapshot(LiveDoc, (await home.root()).id, context)
      return live?.tools?.some((slot) => slot.name === "pause" && slot.status === "running") === true
    })
    await send(stub, "t2", "beta", 2_000)
    await fireNow(stub)
    const status = await runInDurableObject(stub, async (home: Home) => {
      const item = (await home.intake()).find((candidate) => candidate.commandId === "t2")
      if (item === undefined || item.batchId === null) return undefined
      const inspection = await home.harness.inspect(context)
      return inspection.submissions.find((submission) => submission.requestId === `batch:${item.batchId}`)?.status
    })
    expect(status).toBe("queued")

    await eventually(stub, async (home: Home) => {
      const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
      return positionOf(page.items, "assistant", "done") >= 0
    })
    const entries = await transcriptOf(stub)
    const beta = positionOf(entries, "user", "beta")
    expect(beta).toBeGreaterThanOrEqual(0)
    expect(positionOf(entries, "assistant", "done")).toBeGreaterThan(beta)
  }, 15_000)

  it("resubmits a claimed batch after eviction and answers once", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang", "recovered"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "e1", "hello", 1_000)
    await fireNow(stub)
    await runInDurableObject(stub, (home: Home) => home.hanging.promise)
    expect((await rows(stub))[0]?.status).toBe("claimed")
    await evictDurableObject(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await eventually(stub, async (home: Home) =>
      texts(await history(await home.root()), "assistant").includes("recovered"),
    )
    expect(await answers(stub)).toEqual(["recovered"])
    expect(await users(stub)).toHaveLength(1)
    await eventually(stub, async (home: Home) => (await home.intake()).every((item) => item.status === "done"))
  })

  it("does not fire a batch before its debounce elapses", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["too early"])
      await home.chooseModel(FAUX_MODEL)
    })
    await send(stub, "w1", "hold on", 1_000)
    await runDurableObjectAlarm(stub)
    expect(await answers(stub)).toEqual([])
    expect((await rows(stub))[0]?.status).toBe("pending")
  })
})

type Stub = ReturnType<typeof fresh>

type CapturedPush = {
  readonly url: string
  readonly topic: string | null
  readonly body: Uint8Array
}

function capturePush(): CapturedPush[] {
  const sent: CapturedPush[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    const captured = request instanceof Request ? request : new Request(request)
    sent.push({
      url: captured.url,
      topic: captured.headers.get("topic"),
      body: new Uint8Array(await captured.arrayBuffer()),
    })
    return new Response(null, { status: 201 })
  })
  return sent
}

async function subscribe(stub: Stub, id: string, target: Subscriber): Promise<void> {
  const outcome = await command(stub, id, "push.subscribe", { endpoint: target.endpoint, keys: target.keys })
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
}

async function enqueueReport(stub: Stub, commandId: string, title: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const accepted = await enqueue(home, {
      target: (await home.root()).id,
      commandId,
      kind: "report",
      threadId: "7",
      title,
      status: "completed",
      text: "the parser is done",
    })
    expect(accepted).toBe(true)
  })
}

const payloadOf = (target: Subscriber, push: CapturedPush): Promise<unknown> => decrypt(target, push.body)

describe("dispatch push", () => {
  afterEach(() => vi.restoreAllMocks())

  it("pushes one notification with the thread title when a report lands and no socket is open", async () => {
    const stub = fresh()
    const target = await subscriber("https://push.example.test/report")
    await subscribe(stub, "push-sub-report", target)
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(FAUX_MODEL)
    })
    const sent = capturePush()

    await enqueueReport(stub, "report:7:1", "Parser thread")
    await fireNow(stub)

    expect(sent).toHaveLength(1)
    const request = sent[0]
    if (request === undefined) throw new Error("missing push request")
    expect(request.url).toBe(target.endpoint)
    expect(request.topic).toBe(await pushTopic("report:7:1"))
    expect(await payloadOf(target, request)).toMatchObject({ threadTitle: "Parser thread", tag: "report:7:1" })
  })

  it("sends nothing when a socket is open", async () => {
    const stub = owner()
    await runInDurableObject(stub, (home: Home) => home.db.run("DELETE FROM push_subs"))
    const target = await subscriber("https://push.example.test/connected")
    await subscribe(stub, "push-sub-connected", target)
    const socket = await connect()
    try {
      const sent = capturePush()
      await enqueueReport(stub, "report:8:1", "Connected thread")
      await fireNow(stub)
      expect(sent).toHaveLength(0)
    } finally {
      socket.close()
    }
  })

  it("replays a claimed report after eviction with the same topic and tag", async () => {
    const stub = fresh()
    const target = await subscriber("https://push.example.test/replay")
    await subscribe(stub, "push-sub-replay", target)
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang", "recovered"])
      await home.chooseModel(FAUX_MODEL)
    })
    const sent = capturePush()

    await enqueueReport(stub, "report:9:1", "Replay thread")
    await fireNow(stub)
    expect(sent).toHaveLength(1)
    expect((await rows(stub))[0]?.status).toBe("claimed")

    await evictDurableObject(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(sent).toHaveLength(2)

    const [first, second] = sent
    if (first === undefined || second === undefined) throw new Error("missing push request")
    const topic = first.topic
    expect(topic).not.toBeNull()
    expect(second.topic).toBe(topic)
    expect(second.url).toBe(first.url)
    expect(await payloadOf(target, first)).toMatchObject({ threadTitle: "Replay thread", tag: "report:9:1" })
    expect(await payloadOf(target, second)).toMatchObject({ threadTitle: "Replay thread", tag: "report:9:1" })
    await eventually(stub, async (home: Home) => (await home.intake()).every((item) => item.status === "done"))
  })
})

/** An IntakeHost over a real home, so a test can make one step of the dispatch fail. */
const hostOf = (home: Home, overrides: Partial<IntakeHost> = {}): IntakeHost => ({
  harness: home.harness,
  ledger: { processed: () => false, mark: () => undefined, forget: () => undefined, ids: () => [] },
  readBytes: async () => undefined,
  stat: async () => undefined,
  vision: async () => false,
  arm: async () => undefined,
  push: () => undefined,
  batchEvent: (_batch, next) => next(),
  fail: () => undefined,
  ...overrides,
})

describe("gateway retries", () => {
  it("retries a claimed batch whose dispatch throws, and reports the failure", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(FAUX_MODEL)
      const failures: unknown[] = []
      let broken = true
      const gateway = createGateway(
        hostOf(home, {
          fail: (error) => failures.push(error),
          batchEvent: (batch, next) =>
            broken ? Promise.reject(new Error(`dispatch failed for ${batch.batchId}`)) : next(),
        }),
      )
      const target = (await home.root()).id
      await gateway.intake.enqueue({
        target,
        commandId: "stranded-1",
        kind: "user",
        text: "hello",
        attachments: [],
        clientTs: 1_000,
      })
      const now = Date.now() + 10_000

      await gateway.fire(now)
      expect(failures).toHaveLength(1)
      expect((await home.intake()).map((item) => item.status)).toEqual(["claimed"])
      expect(await gateway.due()).toBe(now + 60_000)

      broken = false
      await gateway.fire(now + 60_000)
      expect(failures).toHaveLength(1)
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await home.intake()).every((item) => item.status === "done")) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect((await home.intake()).every((item) => item.status === "done")).toBe(true)
    })
  }, 30_000)
})
