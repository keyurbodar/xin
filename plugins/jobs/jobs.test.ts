import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, TaskId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { describe, expect, it } from "vitest"
import { M6_MODEL } from "../../test/plugins/m6.ts"
import { eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { jobTool, JobsDoc } from "./jobs.ts"
import { ThreadDoc } from "../workspace/threaddoc.ts"
import { WorkspaceDoc } from "../workspace/workspace.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function chooseModel(stub: Stub, coordinatorId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M6_MODEL }, context)
  })
}

async function send(stub: Stub, id: string, coordinatorId: number, text: string): Promise<void> {
  const outcome = await cmd(stub, id, "message.send", { conv: coordinatorId, text })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

const toolResults = async (home: Home, coordinatorId: number): Promise<string[]> => {
  const conversation = await home.harness.conversation(coordinatorId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 100, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "toolResult").map(textOf),
  )
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

const jobRows = (home: Home): Promise<{ command_id: string; status: string; body: string }[]> =>
  home.db.all<{ command_id: string; status: string; body: string }>(
    "SELECT command_id, status, body FROM inbound WHERE kind = 'job' ORDER BY id",
  )

async function waitFor(stub: Stub, check: (home: Home) => Promise<boolean>, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await runInDurableObject(stub, check)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition not reached")
}

function statusOf(body: string): string {
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null) return ""
  const status = Reflect.get(value, "status")
  return typeof status === "string" ? status : ""
}

const release = Promise.withResolvers<void>()

function held(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("interrupted", "AbortError"))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    void release.promise.then(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    })
  })
}

const replayTool = jobTool(
  { name: "replay_tool", description: "Waits for the test to release it.", parameters: obj({}) },
  async (_args, run) => {
    await held(run.signal)
    return { output: [{ type: "text", text: "replayed" }] }
  },
)

const threadOf = async (home: Home, projectId: string) => {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  const id = workspace?.projects[projectId]?.threadIds[0]
  if (id === undefined) return undefined
  const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
  return doc === undefined ? undefined : { id, doc }
}

async function threadResults(home: Home, threadId: number): Promise<string[]> {
  const conversation = await home.harness.conversation(threadId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 100, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "toolResult").map(textOf),
  )
}

function heldJobApi(home: Home, conversationId: ConversationId, taskId: number): ToolExecutionApi {
  return {
    taskId: taskId as TaskId,
    conversationId,
    now: () => Date.now(),
    snapshot: home.harness.snapshot.bind(home.harness),
    commit: home.harness.commit.bind(home.harness),
    waitForTask: home.harness.waitForTask.bind(home.harness),
  } as unknown as ToolExecutionApi
}

describe("jobs", () => {
  it("returns a fast tool's result inline without a job report", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "quick")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "quick-1", project.coordinatorId, "quick tool")
    await fireNow(stub)

    await eventually(stub, async (home: Home) =>
      (await toolResults(home, project.coordinatorId)).some((text) => text === "quick done"),
    )
    expect(await runInDurableObject(stub, jobRows)).toHaveLength(0)
    const jobs = await runInDurableObject(stub, async (home: Home) =>
      Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {}),
    )
    expect(jobs).toEqual([])
  }, 20_000)

  it("returns a slow tool as started and reports the job exactly once", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "slow")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "slow-1", project.coordinatorId, "slow tool")
    await fireNow(stub)

    await waitFor(
      stub,
      async (home: Home) => {
        const texts = await toolResults(home, project.coordinatorId)
        return texts.some((text) => text.startsWith("started (job "))
      },
      600,
    )
    const id = await runInDurableObject(stub, async (home: Home) => {
      const doc = await home.harness.snapshot(JobsDoc, context)
      return Object.keys(doc?.jobs ?? {})[0]
    })
    expect(id).toBeDefined()
    if (id === undefined) return

    await waitFor(
      stub,
      async (home: Home) => {
        const rows = await jobRows(home)
        return rows.some((row) => row.command_id === `job:${id}` && statusOf(row.body) === "completed")
      },
      2_500,
    )
    const found = await runInDurableObject(stub, async (home: Home) => {
      const rows = await jobRows(home)
      const report = rows.find((row) => row.command_id === `job:${id}`)
      return {
        count: rows.filter((row) => row.command_id === `job:${id}`).length,
        text: report?.body ?? "",
        jobs: Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {}),
      }
    })
    expect(found).toEqual({ count: 1, text: expect.stringContaining("slow done"), jobs: [] })

    await runDurableObjectAlarm(stub)
    const again = await runInDurableObject(stub, jobRows)
    expect(again.filter((row) => row.command_id === `job:${id}`)).toHaveLength(1)
  }, 60_000)

  it("keeps a thread's job result inline and never detaches it", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "thread-job")
    await chooseModel(stub, project.coordinatorId)
    await send(stub, "thread-job-1", project.coordinatorId, "delegate slow")
    await fireNow(stub)

    await waitFor(stub, async (home: Home) => (await threadOf(home, project.id))?.doc.status === "completed", 3_000)
    const found = await runInDurableObject(stub, async (home: Home) => {
      const thread = await threadOf(home, project.id)
      return {
        text: thread === undefined ? [] : await threadResults(home, thread.id),
        jobs: Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {}),
        rows: await jobRows(home),
      }
    })
    expect(found.text).toContain("thread slow done")
    expect(found.jobs).toEqual([])
    expect(found.rows).toEqual([])
  }, 40_000)

  it("reuses one job when the wrapper call is replayed", async () => {
    const stub = fresh()
    const first = await runInDurableObject(stub, async (home: Home) => {
      const root = await home.root()
      const api = heldJobApi(home, root.id, 987_654)
      const inline = await replayTool.execute({}, api, context)
      const after = Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {})
      const again = await replayTool.execute({}, api, context)
      const kept = Object.keys((await home.harness.snapshot(JobsDoc, context))?.jobs ?? {})
      return { inline: textOfResult(inline), again: textOfResult(again), after, kept }
    })
    expect(first.inline).toContain("started (job ")
    expect(first.again).toContain("started (job ")
    expect(first.after).toHaveLength(1)
    expect(first.kept).toEqual(first.after)

    release.resolve()
    await waitFor(stub, async (home: Home) => (await jobRows(home)).length === 1, 500)
    const rows = await runInDurableObject(stub, jobRows)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command_id).toMatch(/^job:/)
  }, 40_000)
})

function textOfResult(result: ToolExecutionResult): string {
  return (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}
