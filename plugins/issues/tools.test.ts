import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai"
import type {
  ConversationId,
  JsonObject,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, recordOffers, type Stub, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { commentTool } from "./comment.ts"
import type { IssueDetail, IssuePage } from "./issues.ts"
import { issueTool } from "./tools.ts"

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

type Project = { readonly id: string; readonly coordinatorId: number }

const project = async (stub: Stub, slug: string): Promise<Project> =>
  (await cmd(stub, `tools-project-${slug}`, "project.create", { slug, name: slug })).result as Project

function heldApi(conversationId: number, taskId: number): ToolExecutionApi {
  return { taskId: taskId as TaskId, conversationId: conversationId as ConversationId } as unknown as ToolExecutionApi
}

const textOf = (result: ToolExecutionResult): string =>
  (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

type Tools = { readonly issue: ReturnType<typeof issueTool>; readonly comment: ReturnType<typeof commentTool> }

const withTools = <T>(stub: Stub, work: (tools: Tools, home: Home) => Promise<T>): Promise<T> =>
  runInDurableObject(stub, async (home: Home) => {
    const issues = home.loader.ctx.get("issues")
    const ops = home.loader.ctx.get("ops")
    if (issues === undefined || ops === undefined) throw new Error("no issues or ops service")
    const port = { issues, run: ops.run.bind(ops) }
    return work({ issue: issueTool(port), comment: commentTool(port) }, home)
  })

describe("issue tool calls", () => {
  it("refuses a with that is not an object, and anything the inner schema refuses", async () => {
    const stub = fresh()
    const work = await project(stub, "shapes")
    const texts = await withTools(stub, async ({ issue }) => {
      const api = heldApi(work.coordinatorId, 1)
      await issue.execute({ action: "create", with: { title: "Shape" } }, api, BACKGROUND_CONTEXT)
      const out: string[] = []
      let task = 10
      for (const extra of ["state=done", ["done"], null, 7, { priority: "whenever" }, { title: 5 }, { labels: "x" }])
        out.push(
          textOf(
            await issue.execute(
              { action: "update", id: 1, with: extra },
              heldApi(work.coordinatorId, (task += 1)),
              BACKGROUND_CONTEXT,
            ),
          ),
        )
      return out
    })
    expect(
      texts.every((text) => text.startsWith("Not done:")),
      JSON.stringify(texts),
    ).toBe(true)
    expect(texts.slice(0, 4).every((text) => text.includes("with must be an object"))).toBe(true)
    const detail = (await cmd(stub, "shapes-get", "issue.get", { id: 1 })).result as IssueDetail
    expect(detail.issue).toMatchObject({ title: "Shape", priority: "normal", labels: [] })
    expect(detail.timeline.map((event) => event.kind)).toEqual(["created"])
  })

  it("writes once when a create, update or comment call is replayed", async () => {
    const stub = fresh()
    const work = await project(stub, "replay")
    const texts = await withTools(stub, async ({ issue, comment }) => {
      const create = heldApi(work.coordinatorId, 501)
      const update = heldApi(work.coordinatorId, 502)
      const note = heldApi(work.coordinatorId, 503)
      const out: string[] = []
      for (let round = 0; round < 2; round += 1) {
        out.push(textOf(await issue.execute({ action: "create", with: { title: "Once" } }, create, BACKGROUND_CONTEXT)))
        out.push(
          textOf(
            await issue.execute(
              { action: "update", id: 1, with: { labels: ["a"], link: { kind: "related", other: 1 } } },
              update,
              BACKGROUND_CONTEXT,
            ),
          ),
        )
        out.push(textOf(await comment.execute({ id: 1, body: "only once" }, note, BACKGROUND_CONTEXT)))
      }
      return out
    })
    expect(texts.slice(3)).toEqual(texts.slice(0, 3))
    const page = (await cmd(stub, "replay-list", "issue.list", {})).result as IssuePage
    expect(page.issues).toHaveLength(1)
    const detail = (await cmd(stub, "replay-get", "issue.get", { id: 1 })).result as IssueDetail
    expect(detail.timeline.filter((event) => event.kind === "comment")).toHaveLength(1)
    expect(detail.timeline.filter((event) => event.kind === "changed")).toHaveLength(1)
  })

  it("passes issue_comment mentions through, and wakes the mentioned thread", async () => {
    const stub = fresh()
    const work = await project(stub, "mentions")
    const [helper] = await addThreads(stub, work.id, ["helper"])
    if (helper === undefined) throw new Error("no thread")
    const text = await withTools(stub, async ({ issue, comment }) => {
      await issue.execute(
        { action: "create", with: { title: "Ping" } },
        heldApi(work.coordinatorId, 601),
        BACKGROUND_CONTEXT,
      )
      return textOf(
        await comment.execute(
          { id: 1, body: "look", mentions: [helper.id] },
          heldApi(work.coordinatorId, 602),
          BACKGROUND_CONTEXT,
        ),
      )
    })
    expect(text).toMatch(/^Commented on #1 \(comment \d+\)\.$/)
    const detail = (await cmd(stub, "mentions-get", "issue.get", { id: 1 })).result as IssueDetail
    expect(detail.timeline.find((event) => event.kind === "comment")?.data["mentions"]).toEqual([helper.id])
  })

  it("refuses a forged call that reaches into another project", async () => {
    const stub = fresh()
    const mine = await project(stub, "mine")
    const theirs = await project(stub, "theirs")
    const owned = (
      await cmd(stub, "forge-theirs", "issue.create", { title: "Theirs", threads: [theirs.coordinatorId] })
    ).result as { id: number }
    const api = (task: number) => heldApi(mine.coordinatorId, task)
    const texts = await withTools(stub, async ({ issue, comment }) => {
      return [
        await issue.execute(
          { action: "create", with: { title: "Forged", project: theirs.id } },
          api(701),
          BACKGROUND_CONTEXT,
        ),
        await issue.execute(
          { action: "create", with: { title: "Forged", threads: [theirs.coordinatorId] } },
          api(702),
          BACKGROUND_CONTEXT,
        ),
        await issue.execute({ action: "update", id: owned.id, with: { title: "Taken" } }, api(703), BACKGROUND_CONTEXT),
        await issue.execute({ action: "read", id: owned.id }, api(704), BACKGROUND_CONTEXT),
        await comment.execute({ id: owned.id, body: "hi" }, api(705), BACKGROUND_CONTEXT),
      ].map(textOf)
    })
    expect(texts[0], texts[0]).toMatch(/^Not done:/)
    expect(texts[1]).toContain("outside this project")
    expect(texts[2]).toMatch(/^Not done: .*no issue/)
    expect(texts[3]).toBe(`No issue #${owned.id}.`)
    expect(texts[4]).toMatch(/^Not done: .*no issue/)
    const page = (await cmd(stub, "forge-list", "issue.list", {})).result as IssuePage
    expect(page.issues.map((issue) => issue.title)).toEqual(["Theirs"])
  })
})
