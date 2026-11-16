import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type {
  ConversationId,
  JsonObject,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, type Stub, toolTexts } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { CommandId } from "../../src/ids.ts"
import { commentTool } from "./comment.ts"
import type { IssueDetail, IssuePage } from "./issues.ts"
import { type IssueToolPort, issueTool } from "./tools.ts"

const heldApi = (conversationId: number, taskId: number): ToolExecutionApi =>
  ({ taskId: taskId as TaskId, conversationId: conversationId as ConversationId }) as unknown as ToolExecutionApi

const textOf = (result: ToolExecutionResult): string =>
  (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

type Tools = { readonly issue: ReturnType<typeof issueTool>; readonly comment: ReturnType<typeof commentTool> }

type Run = IssueToolPort["run"]

const withTools = <T>(
  stub: Stub,
  work: (tools: Tools, root: number) => Promise<T>,
  wrap: (run: Run) => Run = (run) => run,
): Promise<T> =>
  runInDurableObject(stub, async (home: Home) => {
    const issues = home.loader.ctx.get("issues")
    const ops = home.loader.ctx.get("ops")
    if (issues === undefined || ops === undefined) throw new Error("no issues or ops service")
    const port = { issues, run: wrap(ops.run.bind(ops)) }
    return work({ issue: issueTool(port), comment: commentTool(port) }, (await home.root()).id)
  })

const detail = async (stub: Stub, id: number): Promise<IssueDetail> =>
  (await cmd(stub, `replay-get-${crypto.randomUUID()}`, "issue.get", { id })).result as IssueDetail

const linkedCreate = (other: number) =>
  ({ action: "create", with: { title: "Linked", link: { kind: "blocks", other } } }) as const

const kinds = (issue: IssueDetail): string[] => issue.timeline.map((event) => event.kind)

/**
 * Runs one model tool call, holds it after its op writes, flushes the running task to the journal with an owner commit,
 * then evicts the home and returns the tool results once pi has rerun the call.
 */
async function evictMidCall(stub: Stub, tool: string, args: JsonObject, op: string): Promise<readonly string[]> {
  respond([
    fauxAssistantMessage([fauxToolCall(tool, args, { id: "evicted" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ])
  const written = Promise.withResolvers<void>()
  await runInDurableObject(stub, async (home: Home) => {
    const ops = home.loader.ctx.get("ops")
    if (ops === undefined) throw new Error("no ops service")
    const run = ops.run.bind(ops)
    ops.run = async (command, actor) => {
      const outcome = await run(command, actor)
      if (command.op !== op) return outcome
      await run(
        { id: "flush" as CommandId, op: "project.create", args: { slug: "flush", name: "flush" } },
        { kind: "owner" },
      )
      written.resolve()
      return new Promise<never>(() => undefined)
    }
    await home.chooseModel(M8_MODEL)
    await home.submit("go", `evict-${tool}`)
  })
  const reached = await Promise.race([
    written.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  expect(reached, "the call never reached its write").toBe(true)
  expect(await toolTexts(stub)).toEqual([])
  await evictDurableObject(stub)
  let texts: readonly string[] = []
  for (let attempt = 0; attempt < 500 && texts.length === 0; attempt += 1) {
    await runDurableObjectAlarm(stub).catch(() => undefined)
    texts = await toolTexts(stub)
    if (texts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return texts
}

describe("issue tool replay keys", () => {
  it("lands two distinct calls with the same arguments", async () => {
    const stub = fresh()
    await withTools(stub, async ({ issue, comment }, root) => {
      for (const task of [11, 12])
        await issue.execute({ action: "create", with: { title: "Twin" } }, heldApi(root, task), BACKGROUND_CONTEXT)
      for (const task of [13, 14])
        await comment.execute({ id: 1, body: "same words" }, heldApi(root, task), BACKGROUND_CONTEXT)
      for (const task of [15, 16])
        await issue.execute(
          { action: "update", id: 2, with: { labels: [`l${task}`] } },
          heldApi(root, task),
          BACKGROUND_CONTEXT,
        )
    })
    const page = (await cmd(stub, "twins", "issue.list", {})).result as IssuePage
    expect(page.issues.map((found) => found.title)).toEqual(["Twin", "Twin"])
    expect(kinds(await detail(stub, 1))).toEqual(["created", "comment", "comment"])
    const second = await detail(stub, 2)
    expect(kinds(second)).toEqual(["created", "changed", "changed"])
    expect(second.issue.labels).toEqual(["l16"])
  })

  it("applies an update and its link once each when the call is replayed", async () => {
    const stub = fresh()
    const texts = await withTools(stub, async ({ issue }, root) => {
      for (const task of [21, 22])
        await issue.execute(
          { action: "create", with: { title: `Issue ${task}` } },
          heldApi(root, task),
          BACKGROUND_CONTEXT,
        )
      const call = {
        action: "update",
        id: 1,
        with: { labels: ["linked"], link: { kind: "blocks", other: 2 } },
      } as const
      const api = heldApi(root, 23)
      return [
        textOf(await issue.execute(call, api, BACKGROUND_CONTEXT)),
        textOf(await issue.execute(call, api, BACKGROUND_CONTEXT)),
      ]
    })
    expect(texts[1]).toBe(texts[0])
    const first = await detail(stub, 1)
    expect(first.issue.labels).toEqual(["linked"])
    expect(first.links.blocks.map((other) => other.id)).toEqual([2])
    expect(kinds(first)).toEqual(["created", "changed", "linked"])
  })

  it("reruns a create cut off by an eviction and still writes one issue", async () => {
    const stub = fresh()
    const texts = await evictMidCall(stub, "issue", { action: "create", with: { title: "Survives" } }, "issue.create")
    expect(texts).toEqual([expect.stringMatching(/^Created #1 /)])
    const page = (await cmd(stub, "evicted-list", "issue.list", {})).result as IssuePage
    expect(page.issues.map((found) => found.title)).toEqual(["Survives"])
  })

  it("reruns a comment cut off by an eviction and still writes one comment", async () => {
    const stub = fresh()
    await cmd(stub, "evicted-comment-issue", "issue.create", { title: "Talked about" })
    const texts = await evictMidCall(stub, "issue_comment", { id: 1, body: "once" }, "issue.comment")
    expect(texts).toEqual([expect.stringMatching(/^Commented on #1 /)])
    expect(kinds(await detail(stub, 1))).toEqual(["created", "comment"])
  })

  it("refuses a create whose link target is missing or in another project, and writes nothing", async () => {
    const stub = fresh()
    const mine = (await cmd(stub, "link-mine", "project.create", { slug: "mine", name: "mine" })).result as {
      readonly coordinatorId: number
    }
    const theirs = (await cmd(stub, "link-theirs", "project.create", { slug: "theirs", name: "theirs" })).result as {
      readonly coordinatorId: number
    }
    await cmd(stub, "link-their-issue", "issue.create", { title: "Theirs", threads: [theirs.coordinatorId] })
    const texts = await withTools(stub, async ({ issue }) => [
      textOf(await issue.execute(linkedCreate(1), heldApi(mine.coordinatorId, 41), BACKGROUND_CONTEXT)),
      textOf(await issue.execute(linkedCreate(99), heldApi(mine.coordinatorId, 42), BACKGROUND_CONTEXT)),
    ])
    expect(texts).toEqual(["Not done: no issue #1.", "Not done: no issue #99."])
    const page = (await cmd(stub, "link-refused-list", "issue.list", {})).result as IssuePage
    expect(page.issues.map((found) => found.title)).toEqual(["Theirs"])
  })

  it("creates one issue when a refused linked create is retried after its target exists", async () => {
    const stub = fresh()
    const call = { action: "create", with: { title: "Retry", link: { kind: "related", other: 1 } } } as const
    const texts = await withTools(stub, async ({ issue }, root) => {
      const first = textOf(await issue.execute(call, heldApi(root, 51), BACKGROUND_CONTEXT))
      await issue.execute({ action: "create", with: { title: "Target" } }, heldApi(root, 52), BACKGROUND_CONTEXT)
      return [first, textOf(await issue.execute(call, heldApi(root, 53), BACKGROUND_CONTEXT))]
    })
    expect(texts[0]).toBe("Not done: no issue #1.")
    expect(texts[1]).toMatch(/^Created #2 /)
    const page = (await cmd(stub, "retry-list", "issue.list", {})).result as IssuePage
    expect(page.issues.map((found) => found.title).toSorted()).toEqual(["Retry", "Target"])
    expect((await detail(stub, 2)).links.related.map((other) => other.id)).toEqual([1])
  })

  it("refuses a root agent's linked create that would land in another project, on every retry", async () => {
    const stub = fresh()
    const east = (await cmd(stub, "root-east", "project.create", { slug: "east", name: "east" })).result as {
      readonly coordinatorId: number
    }
    const west = (await cmd(stub, "root-west", "project.create", { slug: "west", name: "west" })).result as {
      readonly coordinatorId: number
    }
    await cmd(stub, "root-west-issue", "issue.create", { title: "West", threads: [west.coordinatorId] })
    const call = {
      action: "create",
      with: { title: "East", threads: [east.coordinatorId], link: { kind: "blocks", other: 1 } },
    } as const
    const texts = await withTools(stub, async ({ issue }, root) => [
      textOf(await issue.execute(call, heldApi(root, 61), BACKGROUND_CONTEXT)),
      textOf(await issue.execute(call, heldApi(root, 62), BACKGROUND_CONTEXT)),
    ])
    expect(texts).toEqual(["Not done: #1 is in another project.", "Not done: #1 is in another project."])
    const page = (await cmd(stub, "root-list", "issue.list", {})).result as IssuePage
    expect(page.issues.map((found) => found.title)).toEqual(["West"])
  })

  it("reports a create whose link fails after the pre-check as created but not linked", async () => {
    const stub = fresh()
    const texts = await withTools(
      stub,
      async ({ issue }, root) => {
        await issue.execute({ action: "create", with: { title: "Target" } }, heldApi(root, 71), BACKGROUND_CONTEXT)
        return textOf(
          await issue.execute(
            { action: "create", with: { title: "Raced", link: { kind: "related", other: 1 } } },
            heldApi(root, 72),
            BACKGROUND_CONTEXT,
          ),
        )
      },
      (run) => async (command, actor) =>
        command.op === "issue.link"
          ? { kind: "rejected", code: "bad_args", message: "#1 was deleted meanwhile" }
          : run(command, actor),
    )
    expect(texts).toMatch(/^Created #2 \[todo\] Raced, but not linked: #1 was deleted meanwhile\.$/)
    const raced = await detail(stub, 2)
    expect(raced.links.related).toEqual([])
    expect(kinds(raced)).toEqual(["created"])
  })

  it("applies a link given to create, once, under its own key", async () => {
    const stub = fresh()
    const texts = await withTools(stub, async ({ issue }, root) => {
      await issue.execute({ action: "create", with: { title: "Target" } }, heldApi(root, 31), BACKGROUND_CONTEXT)
      const call = { action: "create", with: { title: "Blocker", link: { kind: "blocks", other: 1 } } } as const
      const api = heldApi(root, 32)
      return [
        textOf(await issue.execute(call, api, BACKGROUND_CONTEXT)),
        textOf(await issue.execute(call, api, BACKGROUND_CONTEXT)),
        textOf(
          await issue.execute(
            { action: "create", with: { title: "Odd", link: { kind: "related", other: 1, remove: true } } },
            heldApi(root, 33),
            BACKGROUND_CONTEXT,
          ),
        ),
      ]
    })
    expect(texts[0]).toMatch(/^Created #2 /)
    expect(texts[1]).toBe(texts[0])
    expect(texts[2]).toBe("Not done: create cannot remove a link.")
    const blocker = await detail(stub, 2)
    expect(blocker.links.blocks.map((other) => other.id)).toEqual([1])
    expect(kinds(blocker)).toEqual(["created", "linked"])
    const page = (await cmd(stub, "create-link-list", "issue.list", {})).result as IssuePage
    expect(page.issues).toHaveLength(2)
  })
})
