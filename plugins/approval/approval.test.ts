import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai"
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
  row: "tool-approval",
  search: "approve action",
  tool: "request_approval",
  args: { action: "delete the staging bucket" },
}

type Declared = { readonly name: string; readonly bytes: number }

async function declared(stub: ReturnType<typeof fresh>, requestId: string): Promise<readonly Declared[]> {
  const found: Declared[][] = []
  const encoder = new TextEncoder()
  respond([
    (request) => {
      found.push(
        getCurrentTools(request.messages).map((tool) => ({
          name: tool.name,
          bytes: encoder.encode(JSON.stringify(tool)).length,
        })),
      )
      return fauxAssistantMessage("noted")
    },
  ])
  await turn(stub, requestId)
  return found[0] ?? []
}

describe("a card row, in what every turn bills", () => {
  it("adds only the shared tool_search declaration while no card is loaded", async () => {
    const stub = fresh()
    const off = await declared(stub, "cost-off")
    await setRow(stub, "tool-approval", true)
    const on = await declared(stub, "cost-on")

    const added = on.filter((tool) => !off.some((before) => before.name === tool.name))
    expect(added.map((tool) => tool.name)).toEqual(["tool_search"])
    expect(off.filter((tool) => !on.some((after) => after.name === tool.name))).toEqual([])
    expect(added[0]?.bytes).toBeLessThanOrEqual(640)
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
