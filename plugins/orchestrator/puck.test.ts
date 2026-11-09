import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { threadIdsOfProject, WorkspaceDoc } from "../../src/contracts/workspace.ts"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import { cmd, contentText, eventually, field, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Project = { readonly id: string; readonly coordinatorId: number }
type ThreadRow = { readonly id: number; readonly title: string; readonly status: string }

async function makeProject(stub: Stub, slug: string): Promise<Project> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as Project
}

async function configure(stub: Stub, conversationId: number): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) throw new Error(`no conversation ${conversationId}`)
    await conversation.configure({ model: M5_MODEL }, context)
  })
}

const rootId = (stub: Stub): Promise<number> => runInDurableObject(stub, async (home: Home) => (await home.root()).id)

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) =>
    home.db.run("UPDATE inbound SET fire_at = ? WHERE status = 'pending'", Date.now() - 1),
  )
  await runDurableObjectAlarm(stub)
}

async function send(stub: Stub, id: string, conversationId: number, text: string): Promise<void> {
  const outcome = await cmd(stub, id, "message.send", { conv: conversationId, text })
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  await fireNow(stub)
}

async function threadsOf(home: Home, projectId: string): Promise<ThreadRow[]> {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  const ids = threadIdsOfProject(workspace, projectId)
  const found: ThreadRow[] = []
  for (const id of ids) {
    const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
    if (doc !== undefined) found.push({ id, title: doc.title, status: doc.status })
  }
  return found
}

async function toolResults(home: Home, conversationId: number): Promise<string[]> {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
  return page.items.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => contentText(message.content)),
  )
}

const hasReport = (home: Home, target: number): Promise<boolean> =>
  home.db
    .get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE kind = 'report' AND target = ?", target)
    .then((row) => (row?.n ?? 0) > 0)

const titlesOf = (project: { threads: Record<string, unknown[]> } | undefined): string[] =>
  project === undefined
    ? []
    : Object.values(project.threads).flatMap((group) => group.map((entry) => String(field(entry, "title"))))

describe("Puck on the session root", () => {
  it("starts a thread in the project it names, and its report returns to Puck", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    const beta = await makeProject(stub, "beta")
    const root = await rootId(stub)
    await configure(stub, root)

    await send(stub, "puck-1", root, "puck delegate to alpha")

    await eventually(stub, async (home) => (await threadsOf(home, alpha.id)).length === 1)
    const started = await runInDurableObject(stub, (home: Home) => threadsOf(home, alpha.id))
    expect(started).toHaveLength(1)
    expect(started[0]?.title).toBe("Thread 1")
    expect(await runInDurableObject(stub, (home: Home) => threadsOf(home, beta.id))).toHaveLength(0)
    await eventually(stub, (home) => hasReport(home, root))
  })

  it("refuses a Space that names another project", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    const beta = await makeProject(stub, "beta")
    await configure(stub, alpha.coordinatorId)

    await send(stub, "space-1", alpha.coordinatorId, "delegate elsewhere")

    await eventually(stub, async (home) =>
      (await toolResults(home, alpha.coordinatorId)).some((text) => text.includes("own project (alpha)")),
    )
    expect(await runInDurableObject(stub, (home: Home) => threadsOf(home, beta.id))).toHaveLength(0)
    expect(await runInDurableObject(stub, (home: Home) => threadsOf(home, alpha.id))).toHaveLength(0)
  })

  it("lets the owner start a thread in a named project", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    await configure(stub, alpha.coordinatorId)

    const created = await cmd(stub, "owner-thread-1", "thread.create", {
      project: "alpha",
      title: "Owner thread",
      task: "do it",
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    expect(typeof field(created.result, "threadId")).toBe("number")

    await eventually(stub, async (home) => (await threadsOf(home, alpha.id)).length === 1)
    const started = await runInDurableObject(stub, (home: Home) => threadsOf(home, alpha.id))
    expect(started[0]?.title).toBe("Owner thread")
  })

  it("lets Puck start a thread directly", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    const root = await rootId(stub)
    await configure(stub, root)

    await send(stub, "puck-create-1", root, "puck create a thread")

    await eventually(stub, async (home) => (await threadsOf(home, alpha.id)).length === 1)
    const started = await runInDurableObject(stub, (home: Home) => threadsOf(home, alpha.id))
    expect(started[0]?.title).toBe("Puck thread")
    await eventually(stub, (home) => hasReport(home, root))
  })

  it("archives a thread without losing it", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    await configure(stub, alpha.coordinatorId)
    const created = await cmd(stub, "archive-thread-1", "thread.create", {
      project: "alpha",
      title: "Old thread",
      task: "do it",
    })
    const threadId = Number(field(created.result, "threadId"))
    await eventually(stub, async (home) => (await threadsOf(home, alpha.id)).length === 1)

    const before = await cmd(stub, "archive-read-0", "workspace.read")
    const visible = (before.result as { projects: { id: string; threads: Record<string, unknown[]> }[] }).projects
    expect(titlesOf(visible.find((project) => project.id === alpha.id))).toContain("Old thread")

    const archived = await cmd(stub, "archive-thread-2", "thread.archive", { threadId })
    expect(archived).toMatchObject({ ok: true, result: { archived: true } })
    const stored = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(ThreadDoc, threadId as ConversationId, context),
    )
    expect(stored?.archived).toBe(true)

    const read = await cmd(stub, "archive-read-1", "workspace.read")
    const projects = (read.result as { projects: { id: string; threads: Record<string, unknown[]> }[] }).projects
    expect(titlesOf(projects.find((project) => project.id === alpha.id))).not.toContain("Old thread")

    await cmd(stub, "archive-thread-3", "thread.archive", { threadId, archived: false })
    const reopened = await cmd(stub, "archive-read-2", "workspace.read")
    const after = (reopened.result as { projects: { id: string; threads: Record<string, unknown[]> }[] }).projects
    expect(titlesOf(after.find((project) => project.id === alpha.id))).toContain("Old thread")
  })

  it("creates a Puck conversation that can delegate", async () => {
    const stub = fresh()
    const alpha = await makeProject(stub, "alpha")
    const root = await rootId(stub)
    const created = await cmd(stub, "puck-conv-1", "puck.create", { title: "Planning" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const puckId = Number(field(created.result, "id"))
    expect(Number.isInteger(puckId)).toBe(true)

    const listed = await cmd(stub, "puck-list-1", "puck.list")
    const ids = Array.isArray(listed.result) ? listed.result.map((entry) => field(entry, "id")) : []
    expect(ids).toContain(String(root))
    expect(ids).toContain(String(puckId))

    await configure(stub, puckId)
    await send(stub, "puck-conv-2", puckId, "puck delegate to alpha")

    await eventually(stub, async (home) => (await threadsOf(home, alpha.id)).length === 1)
    await eventually(stub, (home) => hasReport(home, puckId))
  })
})
