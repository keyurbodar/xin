import { describe, expect, it } from "vitest"
import { cardThread, threadReply } from "../../test/cards.ts"
import { cmd, fresh } from "../../test/support.ts"

const CARD = {
  row: "tool-connect",
  search: "connect service",
  tool: "request_connection",
  args: { service: "Linear", reason: "to file the issue" },
}

describe("request_connection", () => {
  it("loads through tool_search, opens a card and reports connected back to the thread", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "connect-yes", CARD)
    const threadRequests = thread.seen.filter((seen) => seen.thread)
    expect(threadRequests[0]?.tools).not.toContain("request_connection")
    expect(threadRequests[1]?.tools).toContain("request_connection")

    const listed = await cmd(stub, "connect-list", "request.list")
    expect(listed.result).toMatchObject({
      requests: [{ id: thread.requestId, kind: "request_connection", question: "Connect Linear: to file the issue" }],
    })
    const answered = await cmd(stub, "connect-answer", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "connected",
    })
    expect(answered.result).toMatchObject({ kind: "answered" })
    expect((await threadReply(stub, thread, "connected")).text).toContain("connected")
  }, 30_000)

  it("takes only connected or declined", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "connect-guard", CARD)
    const free = await cmd(stub, "connect-free", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: "maybe later",
    })
    expect(free).toMatchObject({ ok: false })
  }, 30_000)
})
