import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { type Conversation, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { M2_MODEL, script as scriptM2 } from "../../test/plugins/m2.ts"
import { connect, eventually, fresh, owner } from "../../test/support.ts"
import { decrypt, pushTopic, subscriber, type Subscriber } from "../../test/webpush.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { enqueue } from "./gateway.ts"
import type { CommandId } from "../../src/ids.ts"

const context = BACKGROUND_CONTEXT

type Row = { readonly status: string; readonly batch_id: string | null; readonly command_id: string }

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

const rows = (stub: ReturnType<typeof fresh>): Promise<Row[]> =>
  runInDurableObject(stub, (home: Home) =>
    home.db.all<Row>("SELECT status, batch_id, command_id FROM inbound ORDER BY id"),
  )

const users = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, async (home: Home) => texts(await history(await home.root()), "user"))

const answers = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, async (home: Home) => texts(await history(await home.root()), "assistant"))

async function fireNow(stub: ReturnType<typeof fresh>): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1)
  })
  await runDurableObjectAlarm(stub)
}

describe("gateway intake and dispatch", () => {
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
    await eventually(stub, async (home: Home) =>
      (await home.db.all<Row>("SELECT status, batch_id, command_id FROM inbound")).every(
        (row) => row.status === "done",
      ),
    )
    const batches = new Set((await rows(stub)).map((row) => row.batch_id))
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

  it("steers instead once a tool call is live", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      scriptM2([
        fauxAssistantMessage([fauxToolCall("hold", {}, { id: "hold-1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ])
      await (await home.root()).configure({ model: M2_MODEL }, context)
    })
    await send(stub, "t1", "alpha", 1_000)
    await fireNow(stub)
    await eventually(stub, async (home: Home) => {
      const live = await home.harness.snapshot(LiveDoc, (await home.root()).id, context)
      return (live?.tools?.length ?? 0) > 0
    })
    await send(stub, "t2", "beta", 2_000)
    await fireNow(stub)
    const status = await runInDurableObject(stub, async (home: Home) => {
      const row = await home.db.get<{ batch_id: string }>("SELECT batch_id FROM inbound WHERE command_id = 't2'")
      if (row === undefined) return undefined
      const inspection = await home.harness.inspect(context)
      return inspection.submissions.find((submission) => submission.requestId === `batch:${row.batch_id}`)?.status
    })
    expect(status).toBe("queued")
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
    await eventually(stub, async (home: Home) =>
      (await home.db.all<Row>("SELECT status, batch_id, command_id FROM inbound")).every(
        (row) => row.status === "done",
      ),
    )
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
    const accepted = await enqueue(home.db, {
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
    await eventually(stub, async (home: Home) =>
      (await home.db.all<Row>("SELECT status, batch_id, command_id FROM inbound")).every(
        (row) => row.status === "done",
      ),
    )
  })
})
