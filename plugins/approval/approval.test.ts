import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import type { CommandId } from "../../src/ids.ts"
import { cardThread, threadReply, threadStatus } from "../../test/cards.ts"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, eventually, fresh, setRow, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const CARD = {
  search: "approve action",
  tool: "request_approval",
  args: { action: "delete the staging bucket" },
}

const CARD_ROWS = ["tool-approval", "tool-connect", "tool-secret-input"] as const
const CARD_TOOLS = ["request_approval", "request_connection", "request_secret"] as const

type Offered = { readonly tools: readonly string[]; readonly schemaBytes: number; readonly system: string }

async function offered(stub: ReturnType<typeof fresh>, requestId: string): Promise<Offered> {
  const found: Offered[] = []
  const encoder = new TextEncoder()
  respond([
    (request) => {
      const tools = getCurrentTools(request.messages)
      found.push({
        tools: tools.map((tool) => tool.name),
        schemaBytes: encoder.encode(JSON.stringify(tools)).length,
        system: getCurrentSystemPrompt(request.messages),
      })
      return fauxAssistantMessage("noted")
    },
  ])
  await turn(stub, requestId)
  const first = found[0]
  if (first === undefined) throw new Error("the turn made no request")
  return first
}

describe("the card rows, in what every turn bills", () => {
  it("add one deferred-tools index line per card tool and no declaration", async () => {
    const stub = fresh()
    const on = await offered(stub, "cost-on")
    for (const row of CARD_ROWS) await setRow(stub, row, false)
    const off = await offered(stub, "cost-off")

    expect(on.tools).toEqual(off.tools)
    expect(on.schemaBytes).toBe(off.schemaBytes)
    for (const tool of CARD_TOOLS) expect(on.tools).not.toContain(tool)
    const added = on.system.split("\n").filter((line) => !off.system.split("\n").includes(line))
    expect(added.map((line) => /^- ([^:]+):/.exec(line)?.[1])).toEqual([...CARD_TOOLS])
    const bytes = new TextEncoder().encode(on.system).length - new TextEncoder().encode(off.system).length
    expect(bytes).toBeLessThanOrEqual(240)
  }, 30_000)
})

describe("request_approval", () => {
  it("is deferred, loads through tool_search, and ends the turn on an open card", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "approve-load", CARD)
    const threadRequests = thread.seen.filter((seen) => seen.thread)
    expect(threadRequests[0]?.tools).toContain("tool_search")
    expect(threadRequests[0]?.tools).not.toContain("request_approval")
    expect(threadRequests[1]?.tools).toContain("request_approval")
    expect(threadRequests).toHaveLength(2)

    const requests = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(RequestsDoc, thread.threadId as ConversationId, context),
    )
    expect(requests?.open[thread.requestId]).toMatchObject({
      kind: "request_approval",
      question: "Approve: delete the staging bucket",
      options: ["approved", "declined"],
    })
    const listed = await cmd(stub, "approve-list", "request.list")
    expect(listed.result).toMatchObject({
      requests: [{ id: thread.requestId, kind: "request_approval", conversationId: thread.threadId }],
    })
  }, 30_000)

  it("takes the owner's decision as the next run's input", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "approve-yes", CARD)
    const answered = await cmd(stub, "approve-answer", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "approved",
    })
    expect(answered.result).toMatchObject({ kind: "answered", run: 2 })
    const reply = await threadReply(stub, thread, "approved")
    expect(reply.text).toContain("approved")
    await eventually(stub, async (home: Home) => (await threadStatus(home, thread.threadId)) === "completed")

    const listed = await cmd(stub, "approve-listed", "request.list")
    expect(listed.result).toMatchObject({
      requests: [],
      answered: [{ id: thread.requestId, kind: "request_approval", answer: "approved" }],
    })
  }, 30_000)

  it("refuses an answer that is not a decision, and any answer from an agent", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "approve-guard", CARD)
    const free = await cmd(stub, "approve-free", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "sure, go ahead",
    })
    expect(free).toMatchObject({ ok: false })

    const agent = await runInDurableObject(stub, (home: Home) =>
      home.loader.ctx.ops.run(
        {
          id: "approve-agent" as CommandId,
          op: "request.respond",
          args: { threadId: thread.threadId, requestId: thread.requestId, answer: "approved" },
        },
        { kind: "agent", conversationId: thread.coordinatorId as ConversationId },
      ),
    )
    expect(agent).toMatchObject({ kind: "rejected", code: "forbidden" })
    expect(await runInDurableObject(stub, (home: Home) => threadStatus(home, thread.threadId))).toBe("waiting")
  }, 30_000)
})
