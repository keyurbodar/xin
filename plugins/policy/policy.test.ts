import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { AgentDoc, type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { respond } from "../../test/plugins/m8.ts"
import {
  cmd,
  connect,
  contentText,
  eventually,
  field,
  fresh,
  lastOwnerText,
  owner,
  recordOffers,
  type Stub,
  toolTexts,
  turn,
} from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { threadIdsOfProject, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import { cardThread, threadReply } from "../../test/cards.ts"
import { CallsDoc, canonical } from "./policy.ts"

const context = BACKGROUND_CONTEXT
const NOTE = { scope: "me", text: "The owner's dog is named Miso" }
const ROOT = ROOT_CONVERSATION_ID as number

const remember = () =>
  fauxAssistantMessage([fauxToolCall("remember", { ...NOTE }, { id: `call-${crypto.randomUUID()}` })], {
    stopReason: "toolUse",
  })

type Listed = {
  readonly id: string
  readonly kind: string
  readonly conversationId: number
  readonly question: string
  readonly options?: readonly string[]
  readonly subject?: unknown
}

const ok = async (stub: Stub, op: string, args: unknown): Promise<unknown> => {
  const ack = await cmd(stub, `${op}-${crypto.randomUUID()}`, op, args)
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
  return ack.result
}

const setMode = (stub: Stub, mode: string, projectId?: string): Promise<unknown> =>
  ok(stub, "tool.policy.set", { tool: "remember", mode, ...(projectId === undefined ? {} : { projectId }) })

const rememberRow = async (stub: Stub, projectId?: string): Promise<unknown> => {
  const read = await ok(stub, "tool.policy.read", projectId === undefined ? {} : { projectId })
  const rows = field(read, "tools")
  return Array.isArray(rows) ? rows.find((row) => field(row, "name") === "remember") : undefined
}

const listed = async (stub: Stub): Promise<Listed[]> => {
  const rows = field(await ok(stub, "request.list", {}), "requests")
  return Array.isArray(rows) ? (rows as Listed[]) : []
}

const notes = async (stub: Stub): Promise<unknown[]> => {
  const rows = field(await ok(stub, "memory.list", {}), "notes")
  return Array.isArray(rows) ? rows : []
}

const idle = (stub: Stub): Promise<void> => runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))

const answer = (stub: Stub, requestId: string, reply: string) =>
  cmd(stub, `respond-${crypto.randomUUID()}`, "request.respond", { threadId: ROOT, requestId, answer: reply })

const lastUser = (stub: Stub): Promise<string> =>
  runInDurableObject(stub, async (home: Home) => lastOwnerText((await (await home.root()).context(context)).messages))

async function asked(stub: Stub, requestId: string): Promise<Listed> {
  const offers = recordOffers()
  respond([offers.wrap(remember), offers.step("unexpected")])
  await turn(stub, requestId)
  expect(offers.seen).toHaveLength(1)
  const open = (await listed(stub)).filter((row) => row.kind === "approval")
  expect(open).toHaveLength(1)
  const [request] = open
  if (request === undefined) throw new Error("no approval request")
  return request
}

describe("tool policy", () => {
  it("off removes the tool from model requests until it is allowed again", async () => {
    const stub = fresh()
    const offers = recordOffers()
    expect(await rememberRow(stub)).toMatchObject({ name: "remember", plugin: "tool-memory", home: "allow" })

    expect(await setMode(stub, "off")).toEqual({ tool: "remember", mode: "off" })
    expect(await rememberRow(stub)).toMatchObject({ home: "off" })
    respond([offers.step("ok")])
    await turn(stub, "policy-off")
    expect(offers.latest().tools).not.toContain("remember")
    expect(offers.latest().tools).toContain("recall")

    await setMode(stub, "allow")
    respond([offers.step("ok")])
    await turn(stub, "policy-on")
    expect(offers.latest().tools).toContain("remember")
  })

  it("keeps a project's override beside Home and clears it with inherit", async () => {
    const stub = fresh()
    const project = await ok(stub, "project.create", { slug: "policy", name: "Policy" })
    const projectId = String(field(project, "id"))
    const coordinator = Number(field(project, "coordinatorId")) as ConversationId
    const removed = () =>
      runInDurableObject(stub, async (home: Home) => {
        const tools = (await home.harness.snapshot(AgentDoc, coordinator, context))?.tools
        return tools !== undefined && !Array.isArray(tools) ? tools.remove : []
      })

    await setMode(stub, "ask")
    await setMode(stub, "off", projectId)
    expect(await rememberRow(stub, projectId)).toMatchObject({ home: "ask", project: "off" })
    expect(await removed()).toContain("remember")

    const cleared = await cmd(stub, "policy-home-inherit", "tool.policy.set", { tool: "remember", mode: "inherit" })
    expect(cleared).toMatchObject({ ok: false })
    await setMode(stub, "inherit", projectId)
    expect(await rememberRow(stub, projectId)).toEqual(expect.not.objectContaining({ project: expect.anything() }))
    expect(await removed()).not.toContain("remember")
  })

  it("ask blocks the call, ends the turn and opens an approval request", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-ask")
    expect(request).toMatchObject({
      kind: "approval",
      conversationId: ROOT,
      options: ["Approve", "Always allow", "Deny"],
      subject: { tool: "remember", arguments: canonical(NOTE) },
    })
    expect(request.id).toMatch(/^approval:call-/)
    expect(await notes(stub)).toEqual([])
    expect((await toolTexts(stub)).at(-1)).toContain("waits for the owner's approval")

    const agent = await cmd(stub, "policy-agent-answer", "request.respond", {
      threadId: ROOT,
      requestId: request.id,
      answer: "Banana",
    })
    expect(agent).toMatchObject({ ok: false })
  })

  it("Approve runs the call once, and a replayed answer is already_answered", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-approve")

    respond([remember(), fauxAssistantMessage("saved")])
    const first = await answer(stub, request.id, "Approve")
    expect(first.result).toMatchObject({ kind: "answered" })
    await idle(stub)
    expect(await notes(stub)).toMatchObject([NOTE])
    expect(await listed(stub)).toEqual([])

    const replay = await answer(stub, request.id, "Deny")
    expect(replay.result).toMatchObject({ kind: "already_answered", answer: "Approve" })

    await asked(stub, "policy-approve-again")
    expect(await notes(stub)).toHaveLength(1)
  })

  it("Always allow runs the call and sets the tool to allow for Home", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-always")

    respond([remember(), fauxAssistantMessage("saved")])
    expect((await answer(stub, request.id, "Always allow")).result).toMatchObject({ kind: "answered" })
    await idle(stub)
    expect(await rememberRow(stub)).toMatchObject({ home: "allow" })
    expect(await notes(stub)).toHaveLength(1)

    respond([remember(), fauxAssistantMessage("saved again")])
    await turn(stub, "policy-always-next")
    expect(await listed(stub)).toEqual([])
  })

  it("Deny refuses the call and tells the model", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-deny")

    respond([fauxAssistantMessage("understood")])
    expect((await answer(stub, request.id, "Deny")).result).toMatchObject({ kind: "answered" })
    await idle(stub)
    expect(await lastUser(stub)).toContain("denied")
    expect(await notes(stub)).toEqual([])
  })

  it("keeps the policy, the request and the grant across an eviction", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-evict")

    await evictDurableObject(stub)
    expect((await listed(stub)).map((row) => row.id)).toEqual([request.id])
    expect(await rememberRow(stub)).toMatchObject({ home: "ask" })

    respond([remember(), fauxAssistantMessage("saved")])
    expect((await answer(stub, request.id, "Approve")).result).toMatchObject({ kind: "answered" })
    await idle(stub)
    expect(await notes(stub)).toMatchObject([NOTE])
  })

  it("asks inside a thread and resumes the thread once on Approve", async () => {
    const stub = fresh()
    const project = await ok(stub, "project.create", { slug: "asking", name: "Asking" })
    const projectId = String(field(project, "id"))
    const coordinator = Number(field(project, "coordinatorId")) as ConversationId
    await ok(stub, "tool.policy.set", { tool: "quick_tool", mode: "ask", projectId })
    await runInDurableObject(stub, async (home: Home) => {
      await (await home.harness.conversation(coordinator, context))?.configure({ model: M6_MODEL }, context)
    })
    await ok(stub, "message.send", { conv: coordinator, text: "delegate quick" })
    await runInDurableObject(stub, (home: Home) => home.fireIntake())
    await runDurableObjectAlarm(stub)

    const thread = async (home: Home) => {
      const [id] = threadIdsOfProject(await home.harness.snapshot(WorkspaceDoc, context), projectId)
      if (id === undefined) return undefined
      return { id, doc: await home.harness.snapshot(ThreadDoc, id as ConversationId, context) }
    }
    await eventually(stub, async (home: Home) => (await thread(home))?.doc?.status === "waiting")
    const waiting = await runInDurableObject(stub, thread)
    if (waiting === undefined) throw new Error("no thread")
    const [request] = await listed(stub)
    expect(request).toMatchObject({ kind: "approval", conversationId: waiting.id, subject: { tool: "quick_tool" } })
    if (request === undefined) throw new Error("no request")

    const answered = await cmd(stub, "policy-thread-approve", "request.respond", {
      threadId: waiting.id,
      requestId: request.id,
      answer: "Approve",
    })
    expect(answered.result).toMatchObject({ kind: "answered", run: 2 })
    await eventually(stub, async (home: Home) => (await thread(home))?.doc?.status === "completed")
    const results = await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(waiting.id as ConversationId, context)
      const page = await conversation?.entries({ order: "ascending" }, 200, undefined, context)
      return (page?.items ?? []).flatMap((entry) =>
        (entry.model ?? []).flatMap((message) => (message.role === "toolResult" ? [contentText(message.content)] : [])),
      )
    })
    expect(results.filter((text) => text.includes("quick done"))).toHaveLength(1)
  }, 20_000)

  it("redacts a stored secret holding JSON-escaped characters out of the approval preview before capping it", async () => {
    const stub = fresh()
    const secret = ["owner", 'pa"ss', "w\\ord", "7f3k9q"].join("-")
    expect(secret).toContain('"')
    expect(secret).toContain("\\")
    expect(await cmd(stub, "policy-secret", "secret.set", { ref: "TOKEN", value: secret })).toMatchObject({ ok: true })
    await setMode(stub, "ask")
    const text = `${"x".repeat(470)}${secret} tail`
    respond([
      fauxAssistantMessage([fauxToolCall("remember", { scope: "me", text }, { id: "call-secret" })], {
        stopReason: "toolUse",
      }),
    ])
    await turn(stub, "policy-secret-ask")
    const [row] = await listed(stub)
    expect(row?.id).toBe("approval:call-secret")
    const preview = String(field(row?.subject, "arguments"))
    expect(preview).toContain("[redac")
    expect(preview.length).toBeLessThanOrEqual(500)
    const stored = await runInDurableObject(stub, async (home: Home) =>
      JSON.stringify(await home.harness.snapshot(RequestsDoc, ROOT_CONVERSATION_ID, context)),
    )
    const forms = [secret, JSON.stringify(secret).slice(1, -1), JSON.stringify(JSON.stringify(secret)).slice(1, -1)]
    for (const seen of [JSON.stringify(row), stored]) {
      for (const form of forms) expect(seen).not.toContain(form)
      expect(seen).not.toContain("7f3k9q")
    }
  })

  it.each([
    { name: "an object key", secret: "keyzz6666q", args: { action: "create", with: { title: "t", keyzz6666q: "v" } } },
    { name: "a number", secret: "98765432", args: { action: "read", id: 98_765_432 } },
  ])("redacts a stored secret used as $name out of the approval preview", async ({ secret, args }) => {
    const stub = fresh()
    expect(await cmd(stub, "policy-secret-shape", "secret.set", { ref: "TOKEN", value: secret })).toMatchObject({
      ok: true,
    })
    await ok(stub, "tool.policy.set", { tool: "issue", mode: "ask" })
    respond([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "issue" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("issue", args, { id: "call-shape" })], { stopReason: "toolUse" }),
    ])
    await turn(stub, "policy-secret-shape-ask")
    const [row] = await listed(stub)
    expect(row?.id).toBe("approval:call-shape")
    expect(String(field(row?.subject, "arguments"))).toContain("[redacted]")
    const stored = await runInDurableObject(stub, async (home: Home) =>
      JSON.stringify(await home.harness.snapshot(RequestsDoc, ROOT_CONVERSATION_ID, context)),
    )
    for (const seen of [JSON.stringify(row), stored]) expect(seen).not.toContain(secret)
  })

  it("keeps the secret out of every row and socket frame that carries the approval", async () => {
    const stub = owner()
    const secret = "keyzz7777q"
    expect(await cmd(stub, "policy-scan-secret", "secret.set", { ref: "TOKEN", value: secret })).toMatchObject({
      ok: true,
    })
    await ok(stub, "tool.policy.set", { tool: "issue", mode: "ask" })
    const socket = await connect()
    try {
      socket.send({ t: "sub", stream: "home" })
      await socket.next((frame) => frame.t === "snap" && frame.stream === "home")
      respond([
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "issue" })], { stopReason: "toolUse" }),
        fauxAssistantMessage(
          [fauxToolCall("issue", { action: "read", id: 1, with: { [secret]: secret } }, { id: "call-scan" })],
          { stopReason: "toolUse" },
        ),
      ])
      await turn(stub, "policy-scan-ask")
      const [row] = await listed(stub)
      expect(row?.id).toBe("approval:call-scan")
      expect(JSON.stringify(row)).not.toContain(secret)

      const decoder = new TextDecoder()
      const rows = await runInDurableObject(stub, (_home: Home, state: DurableObjectState) =>
        state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
          .toArray()
          .flatMap(({ name }) =>
            state.storage.sql
              .exec(`SELECT * FROM "${name}"`)
              .toArray()
              .map((cells) =>
                JSON.stringify(
                  Object.values(cells).map((cell) =>
                    cell instanceof ArrayBuffer || ArrayBuffer.isView(cell) ? decoder.decode(cell) : cell,
                  ),
                ),
              ),
          ),
      )
      const carrying = rows.filter((text) => text.includes("Allow issue to run?"))
      expect(carrying.length, "the scan reads the request rows and the journal").toBeGreaterThan(0)
      for (const text of carrying) expect(text).not.toContain(secret)
      await socket.next((frame) => frame.stream === "home" && JSON.stringify(frame).includes("approval:call-scan"))
      const frames = socket.received().filter((frame) => frame.includes("approval:call-scan"))
      expect(frames.length, "the home stream carried the approval").toBeGreaterThan(0)
      for (const frame of frames) expect(frame).not.toContain(secret)
    } finally {
      socket.close()
    }
  })

  it("leaves an agent's own approval card to the questions service: Approve grants nothing", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const thread = await cardThread(stub, "agent-ask", {
      search: "approve action",
      tool: "request_approval",
      args: { action: "remember", detail: canonical(NOTE) },
    })
    expect(thread.requestId.startsWith("q:")).toBe(true)
    const always = await cmd(stub, "agent-ask-always", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "Always allow",
    })
    expect(always, "an agent's ask takes only Approve or Deny").toMatchObject({ ok: false })
    const answered = await cmd(stub, "agent-ask-approve", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "Approve",
    })
    expect(answered.result).toMatchObject({ kind: "answered", run: 2 })
    await threadReply(stub, thread, "Approve")
    const grants = await runInDurableObject(stub, async (home: Home) => {
      const ids = [thread.threadId, thread.coordinatorId, ROOT] as ConversationId[]
      const docs = await Promise.all(ids.map((id) => home.harness.snapshot(CallsDoc, id, context)))
      return docs.flatMap((doc) => Object.keys(doc?.grants ?? {}))
    })
    expect(grants).toEqual([])
    expect(await rememberRow(stub)).toMatchObject({ home: "ask" })
    expect(await rememberRow(stub, thread.projectId)).not.toHaveProperty("project")
  }, 30_000)

  it("refuses an agent's answer to an approval and keeps the request open", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-agent")
    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(
        {
          id: "policy-agent-approve" as CommandId,
          op: "request.respond",
          args: { threadId: ROOT, requestId: request.id, answer: "Approve" },
        },
        { kind: "agent", conversationId: ROOT_CONVERSATION_ID },
      ),
    )
    expect(outcome).toMatchObject({ kind: "rejected", code: "forbidden" })
    expect((await listed(stub)).map((row) => row.id)).toEqual([request.id])
  })

  it("asks again when the retried call's arguments differ from the approved ones", async () => {
    const stub = fresh()
    await setMode(stub, "ask")
    const request = await asked(stub, "policy-other-args")
    respond([
      fauxAssistantMessage([fauxToolCall("remember", { scope: "me", text: "Something else" }, { id: "call-other" })], {
        stopReason: "toolUse",
      }),
    ])
    expect((await answer(stub, request.id, "Approve")).result).toMatchObject({ kind: "answered" })
    await idle(stub)
    expect(await notes(stub)).toEqual([])
    expect((await listed(stub)).map((row) => row.id)).toEqual(["approval:call-other"])
  })

  it("keeps a thread's own tool removals when its project allows a tool Home turned off", async () => {
    const stub = fresh()
    const project = await ok(stub, "project.create", { slug: "child", name: "Child" })
    const projectId = String(field(project, "id"))
    const coordinator = Number(field(project, "coordinatorId")) as ConversationId
    await runInDurableObject(stub, async (home: Home) => {
      await (await home.harness.conversation(coordinator, context))?.configure({ model: M6_MODEL }, context)
    })
    await ok(stub, "message.send", { conv: coordinator, text: "delegate hello" })
    await runInDurableObject(stub, (home: Home) => home.fireIntake())
    await runDurableObjectAlarm(stub)
    const removed = async (home: Home): Promise<readonly string[]> => {
      const [id] = threadIdsOfProject(await home.harness.snapshot(WorkspaceDoc, context), projectId)
      if (id === undefined) return []
      const tools = (await home.harness.snapshot(AgentDoc, id as ConversationId, context))?.tools
      return tools !== undefined && !Array.isArray(tools) ? tools.remove : []
    }
    await eventually(stub, async (home: Home) => (await removed(home)).includes("delegate_task"))

    await setMode(stub, "off")
    expect(await runInDurableObject(stub, removed)).toEqual(expect.arrayContaining(["delegate_task", "remember"]))
    await setMode(stub, "allow", projectId)
    const kept = await runInDurableObject(stub, removed)
    expect(kept).toContain("delegate_task")
    expect(kept).not.toContain("remember")
  }, 20_000)
})
