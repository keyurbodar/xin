import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, turn } from "../../test/support.ts"
import type { IssueDetail, IssuePage } from "./issues.ts"

const call = (name: string, args: JsonObject): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

describe("issue tool rows", () => {
  it("let an agent create, update, comment on and read an issue as itself", async () => {
    const stub = fresh()
    const offers = recordOffers()
    respond([
      call("issue", { action: "create", with: { title: "Agent filed", priority: "high", labels: ["agent"] } }),
      call("issue", { action: "update", id: 1, with: { state: "in-progress" } }),
      call("issue_comment", { id: 1, body: "started" }),
      call("issue", { action: "update", id: 1, with: { assignees: ["robot"] } }),
      call("issue", { action: "read", with: { q: "agent" } }),
      offers.step("done"),
    ])
    await turn(stub, "issue-tools")
    expect(offers.latest().tools).toEqual(expect.arrayContaining(["issue", "issue_comment"]))

    const detail = (await cmd(stub, "issue-tools-get", "issue.get", { id: 1 })).result as IssueDetail
    expect(detail.issue).toMatchObject({ title: "Agent filed", priority: "high", state: "in-progress", assignees: [] })
    expect(detail.timeline.map((event) => event.kind)).toEqual(["created", "changed", "comment"])
    expect(detail.timeline.every((event) => event.actor.startsWith("thread:"))).toBe(true)
    const page = (await cmd(stub, "issue-tools-list", "issue.list", { q: "agent" })).result as IssuePage
    expect(page.issues.map((issue) => issue.id)).toEqual([1])
  })
})
