import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import type { JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, turn } from "../../test/support.ts"
import type { IssueDetail, IssuePage } from "./issues.ts"

const call = (args: JsonObject): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall("issue", args, { id: `issue-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

describe("issue tool row", () => {
  it("ships off, and once enabled lets an agent create, update, comment on and read an issue as itself", async () => {
    const stub = fresh()
    const offers = recordOffers()
    expect(await rowState(stub, "tool-issues")).toEqual({ kind: "disabled" })
    respond([offers.step("ok")])
    await turn(stub, "issue-tools-off")
    expect(offers.latest().tools).not.toContain("issue")

    const enabled = await cmd(stub, "issue-tools-enable", "plugin.enable", { id: "tool-issues", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied" })
    respond([
      call({ action: "create", title: "Agent filed", priority: "high", labels: ["agent"] }),
      call({ action: "update", id: 1, state: "in-progress" }),
      call({ action: "comment", id: 1, body: "started" }),
      call({ action: "read", q: "agent" }),
      offers.step("done"),
    ])
    await turn(stub, "issue-tools")
    expect(offers.latest().tools).toContain("issue")

    const detail = (await cmd(stub, "issue-tools-get", "issue.get", { id: 1 })).result as IssueDetail
    expect(detail.issue).toMatchObject({ title: "Agent filed", priority: "high", state: "in-progress" })
    expect(detail.timeline.map((event) => event.kind)).toEqual(["created", "changed", "comment"])
    expect(detail.timeline.every((event) => event.actor.startsWith("thread:"))).toBe(true)
    const page = (await cmd(stub, "issue-tools-list", "issue.list", { q: "agent" })).result as IssuePage
    expect(page.issues.map((issue) => issue.id)).toEqual([1])
  })
})
