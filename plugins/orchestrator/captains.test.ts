import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import { addThreads, cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import { captainPrompt, CaptainsDoc, captainsHome } from "./captains.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Project = { readonly id: string; readonly coordinatorId: number; readonly spaceId: string }
type Captain = { readonly id: string; readonly coordinatorId: number; readonly spaceId: string; readonly alias: string }
type CrewRow = { readonly threadId: number; readonly status: string; readonly idleMs: number; readonly report?: string }

const read = <T>(stub: Stub, work: (home: Home) => Promise<T>): Promise<T> => runInDurableObject(stub, work)

async function ok(stub: Stub, id: string, op: string, args: unknown): Promise<unknown> {
  const outcome = await cmd(stub, id, op, args)
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  return outcome.result
}

async function setup(stub: Stub, slug: string): Promise<{ project: Project; captain: Captain }> {
  const project = (await ok(stub, `project-${slug}`, "project.create", { slug, name: slug })) as Project
  const captain = (await ok(stub, `captain-${slug}`, "captain.create", {
    projectId: project.id,
    name: "Bosun Prime",
    description: "Runs the backend crew.",
    model: M5_MODEL,
    rules: "Never merge without a green gate.",
    crewRules: "Open one PR per change.",
  })) as Captain
  return { project, captain }
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

async function send(stub: Stub, id: string, conv: number, text: string): Promise<void> {
  await ok(stub, id, "message.send", { conv, text })
  await fireNow(stub)
}

const idle = async (home: Home, id: number): Promise<boolean> =>
  (await home.harness.snapshot(LiveDoc, id as ConversationId, context))?.run === undefined

const batchRows = async (home: Home, id: number): Promise<number[]> => {
  const conversation = await home.harness.conversation(id as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
  return page.items
    .filter((entry) => entry.kind === "xin.batch" && Array.isArray(entry.data))
    .map((entry) =>
      (Array.isArray(entry.data) ? entry.data : []).filter(
        (row: unknown) => typeof row === "object" && row !== null && "kind" in row && row.kind === "report",
      ),
    )
    .map((rows) => rows.length)
    .filter((count) => count > 0)
}

const crew = async (stub: Stub, id: string, captainId: string): Promise<CrewRow[]> =>
  ((await ok(stub, id, "captain.get", { id: captainId })) as { crew: CrewRow[] }).crew

const rows = (home: Home) => {
  const meter = home.meter()
  return {
    written: meter.sql.writes + meter.kv.writes + meter.alarm.writes,
    read: meter.sql.reads + meter.kv.reads + meter.alarm.reads,
  }
}

describe("captains", () => {
  it("creates a Captain with its own conversation, model, space and profile", async () => {
    const stub = fresh()
    const { project, captain } = await setup(stub, "profile")
    expect(captain.alias).toBe("bosun-prime")

    const got = (await ok(stub, "get-1", "captain.get", { id: captain.id })) as Record<string, unknown>
    expect(got).toMatchObject({
      name: "Bosun Prime",
      alias: "bosun-prime",
      avatarSeed: "bosun-prime",
      projectId: project.id,
      model: M5_MODEL,
      rules: "Never merge without a green gate.",
      crew: [],
    })
    const listed = (await ok(stub, "list-1", "captain.list", {})) as { id: string }[]
    expect(listed.map((row) => row.id)).toEqual([captain.id])

    const taken = await cmd(stub, "dup", "captain.create", { projectId: project.id, name: "Bosun Prime" })
    expect(taken.ok).toBe(false)

    await ok(stub, "rename", "captain.update", { id: captain.id, name: "Bosun", alias: "bosun", avatarSeed: "s1" })
    const space = await read(stub, async (home) => (await home.harness.snapshot(WorkspaceDoc, context))?.spaces)
    expect(space?.[captain.spaceId]).toMatchObject({ name: "Bosun", coordinatorId: captain.coordinatorId })

    await ok(stub, "archive", "captain.archive", { id: captain.id })
    expect(await ok(stub, "list-2", "captain.list", {})).toEqual([])
    expect(((await ok(stub, "list-3", "captain.list", { archived: true })) as unknown[]).length).toBe(1)
  })

  it("follows its space when the space moves project or is archived outside the Captain ops", async () => {
    const stub = fresh()
    const { captain } = await setup(stub, "drift")
    const other = (await ok(stub, "project-other", "project.create", { slug: "other", name: "other" })) as Project
    await ok(stub, "move-space", "space.update", { id: captain.spaceId, projectId: other.id })
    expect(await ok(stub, "drift-get", "captain.get", { id: captain.id })).toMatchObject({ projectId: other.id })

    await ok(stub, "archive-project", "project.archive", { id: other.id })
    expect(await ok(stub, "drift-list", "captain.list", {})).toEqual([])
    expect(await ok(stub, "drift-get-2", "captain.get", { id: captain.id })).toMatchObject({ archived: true })
    const home = await read(stub, (h) => captainsHome(h.harness))
    expect(home).toEqual({ captains: [] })
  })

  it("never returns a removed crew member to another Captain's crew", async () => {
    const stub = fresh()
    const { project, captain } = await setup(stub, "return")
    const second = (await ok(stub, "captain-return-2", "captain.create", {
      projectId: project.id,
      name: "Second",
    })) as Captain
    const [thread] = await addThreads(stub, project.id, ["member"])
    if (thread === undefined) throw new Error("no thread")
    await ok(stub, "join", "captain.crew.add", { id: second.id, threadId: thread.id })
    await ok(stub, "archive-default", "space.archive", { id: project.spaceId })

    const removed = await cmd(stub, "leave", "captain.crew.remove", { id: second.id, threadId: thread.id })
    expect(removed.ok).toBe(false)
    const doc = await read(stub, (home) => home.harness.snapshot(ThreadDoc, thread.id, context))
    expect(doc).toMatchObject({ spaceId: second.spaceId, parentId: second.coordinatorId })
    expect(doc?.spaceId).not.toBe(captain.spaceId)
  })

  it("gives the Captain its rules and notes, and every crew thread its crew rules", async () => {
    const stub = fresh()
    const { project, captain } = await setup(stub, "prompt")
    const [loose] = await addThreads(stub, project.id, ["loose"])
    if (loose === undefined) throw new Error("no thread")

    const [own, before] = await read(stub, (home) =>
      Promise.all([
        captainPrompt(home.harness, captain.coordinatorId as ConversationId),
        captainPrompt(home.harness, loose.id),
      ]),
    )
    expect(own).toContain("You are Captain Bosun Prime (@bosun-prime). Runs the backend crew.")
    expect(own).toContain("<captain-rules>\nNever merge without a green gate.\n</captain-rules>")
    expect(before).toBeUndefined()

    await ok(stub, "join", "captain.crew.add", { id: captain.id, threadId: loose.id })
    const after = await read(stub, (home) => captainPrompt(home.harness, loose.id))
    expect(after).toContain("<crew-rules>\nOpen one PR per change.\n</crew-rules>")
  })

  it("lets a Captain rewrite its own notes with captain_notes", async () => {
    const stub = fresh()
    const { captain } = await setup(stub, "notes")
    await send(stub, "notes-1", captain.coordinatorId, "captain notes")
    await eventually(stub, async (home) => {
      const doc = await home.harness.snapshot(CaptainsDoc, context)
      return doc?.captains[captain.id]?.notes === "Ship small PRs."
    })
    const prompt = await read(stub, (home) => captainPrompt(home.harness, captain.coordinatorId as ConversationId))
    expect(prompt).toContain("<captain-notes>\nShip small PRs.\n</captain-notes>")
  }, 20_000)

  it("puts threads a Captain starts in its crew and turns eight reports into one Captain turn", async () => {
    const stub = fresh()
    const { project, captain } = await setup(stub, "crew")
    await send(stub, "crew-1", captain.coordinatorId, "delegate 8")

    await eventually(stub, async (home) => {
      const workspace = await home.harness.snapshot(WorkspaceDoc, context)
      return workspace?.spaces[captain.spaceId]?.threadIds.length === 8
    })
    await eventually(stub, async (home) => (await home.intake()).filter((item) => item.kind === "report").length === 8)
    await eventually(stub, (home) => idle(home, captain.coordinatorId))
    await fireNow(stub)
    await eventually(stub, async (home) => (await batchRows(home, captain.coordinatorId)).includes(8))

    expect(await read(stub, (home) => batchRows(home, captain.coordinatorId))).toEqual([8])
    const members = await crew(stub, "crew-get", captain.id)
    expect(members).toHaveLength(8)
    for (const member of members) {
      expect(member.status).toBe("completed")
      expect(member.report).toMatch(/^thread answer: do task \d$/)
      expect(member.idleMs).toBeGreaterThanOrEqual(0)
    }
    const listed = (await ok(stub, "crew-list", "captain.list", {})) as { crew: Record<string, number> }[]
    expect(listed[0]?.crew).toEqual({ total: 8, working: 0, waiting: 0, failed: 0 })
    const workspace = await read(stub, (home) => home.harness.snapshot(WorkspaceDoc, context))
    expect(workspace?.spaces[project.spaceId]?.threadIds).toEqual([])
  }, 30_000)

  it("adds a running thread to a crew so its report reaches the Captain, and removes it again", async () => {
    const stub = fresh()
    const { project, captain } = await setup(stub, "move")
    const coordinator = (
      await read(stub, async (home) => (await home.harness.snapshot(WorkspaceDoc, context))?.spaces[project.spaceId])
    )?.coordinatorId
    await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(coordinator as ConversationId, context)
      await conversation?.configure({ model: M5_MODEL }, context)
    })
    await send(stub, "move-1", project.coordinatorId, "delegate stop")
    const threadId = await (async () => {
      let found: number | undefined
      await eventually(stub, async (home) => {
        const workspace = await home.harness.snapshot(WorkspaceDoc, context)
        found = workspace?.spaces[project.spaceId]?.threadIds[0]
        return found !== undefined
      })
      return found ?? -1
    })()

    await ok(stub, "join", "captain.crew.add", { id: captain.id, threadId })
    const joined = await read(stub, (home) => home.harness.snapshot(ThreadDoc, threadId as ConversationId, context))
    expect(joined).toMatchObject({ spaceId: captain.spaceId, parentId: captain.coordinatorId, status: "working" })
    expect((await crew(stub, "join-get", captain.id)).map((row) => row.threadId)).toEqual([threadId])

    await eventually(stub, async (home) =>
      (await home.intake()).some((item) => item.kind === "report" && item.commandId === `report:${threadId}:1`),
    )
    const report = await read(stub, async (home) =>
      (await home.intake()).find((item) => item.commandId === `report:${threadId}:1`),
    )
    expect(report?.target).toBe(captain.coordinatorId)

    await ok(stub, "leave", "captain.crew.remove", { id: captain.id, threadId })
    const left = await read(stub, (home) => home.harness.snapshot(ThreadDoc, threadId as ConversationId, context))
    expect(left).toMatchObject({ spaceId: project.spaceId, parentId: project.coordinatorId })
    expect(await crew(stub, "leave-get", captain.id)).toEqual([])
    const again = await cmd(stub, "leave-2", "captain.crew.remove", { id: captain.id, threadId })
    expect(again.ok).toBe(false)
  }, 30_000)

  it("forks a side thread from a Captain's context and reports back to it", async () => {
    const stub = fresh()
    const { captain } = await setup(stub, "side")
    await send(stub, "side-1", captain.coordinatorId, "remember the plan")
    await eventually(stub, (home) => idle(home, captain.coordinatorId))

    const side = (await ok(stub, "side-2", "thread.side", {
      conv: captain.coordinatorId,
      title: "Aside",
      task: "check one thing",
    })) as { threadId: number; spaceId: string }
    expect(side.spaceId).toBe(captain.spaceId)

    await eventually(stub, async (home) =>
      (await home.intake()).some((item) => item.commandId === `report:${side.threadId}:1`),
    )
    const texts = await read(stub, async (home) => {
      const conversation = await home.harness.conversation(side.threadId as ConversationId, context)
      const page = await conversation?.entries({ order: "ascending" }, 100, undefined, context)
      return JSON.stringify(page?.items.map((entry) => entry.model ?? []))
    })
    expect(texts).toContain("remember the plan")
    expect(texts).toContain("thread answer: check one thing")
    const doc = await read(stub, (home) => home.harness.snapshot(ThreadDoc, side.threadId as ConversationId, context))
    expect(doc).toMatchObject({ parentId: captain.coordinatorId, status: "completed" })

    const thread = await cmd(stub, "side-3", "thread.side", { conv: side.threadId, title: "x", task: "y" })
    expect(thread.ok).toBe(false)
  }, 30_000)

  it("costs no more rows to read a Captain and its crew than a plain read op", async () => {
    const stub = fresh()
    const { captain } = await setup(stub, "cost")
    await send(stub, "cost-0", captain.coordinatorId, "delegate 8")
    await eventually(stub, async (home) => (await home.intake()).filter((item) => item.kind === "report").length === 8)
    const cost = async (id: string, op: string, args: unknown) => {
      const before = await read(stub, async (home) => rows(home))
      await ok(stub, id, op, args)
      const after = await read(stub, async (home) => rows(home))
      return { written: after.written - before.written, read: after.read - before.read }
    }
    // Only the command receipt is billed: the Captain, its crew and their thread documents are read from memory.
    const baseline = await cost("cost-base", "workspace.read", {})
    expect(await cost("cost-get", "captain.get", { id: captain.id })).toEqual(baseline)
    expect(await cost("cost-list", "captain.list", {})).toEqual(baseline)
  }, 30_000)
})
