import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { respond, M8_MODEL } from "../../test/plugins/m8.ts"
import { cmd, connect, fresh, owner, recordOffers, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { ProjectId, ThreadId } from "../../src/ids.ts"
import { ThreadDoc, transition, type ThreadEvent, type ThreadStatus } from "../../src/contracts/threaddoc.ts"
import { RequestsDoc, WorkspaceDoc } from "./workspace.ts"

type Summary = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly result?: string
}
type Project = {
  readonly id: string
  readonly slug: string
  readonly archived: boolean
  readonly coordinatorId: number
  readonly openRequests: number
  readonly threads: Record<ThreadStatus, Summary[]>
}

function projectsOf(value: unknown): Project[] {
  if (typeof value !== "object" || value === null || !("projects" in value) || !Array.isArray(value.projects))
    throw new Error("not a workspace projection")
  return value.projects.filter((project): project is Project => typeof project === "object" && project !== null)
}

const conversation = (home: Home): Promise<ConversationId> =>
  home.harness
    .createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)
    .then((created) => created.id)

type NewThread = {
  readonly projectId: ProjectId
  readonly threadId: ThreadId
  readonly title: string
  readonly status?: ThreadStatus
}

const addThread = async (tx: Tx, thread: NewThread): Promise<void> => {
  const workspace = await tx.doc(WorkspaceDoc)
  const project = workspace.projects[thread.projectId]
  if (project === undefined) throw new Error(`no project ${thread.projectId}`)
  const spaceId = Object.entries(workspace.spaces).find(
    ([, space]) => space.projectId === thread.projectId && !space.archived,
  )?.[0]
  const space = spaceId === undefined ? undefined : workspace.spaces[spaceId]
  if (spaceId === undefined || space === undefined) throw new Error(`no space for ${thread.projectId}`)
  const doc = await tx.doc(ThreadDoc, thread.threadId)
  const now = Date.now()
  Object.assign(doc, {
    projectId: thread.projectId,
    spaceId,
    title: thread.title,
    role: "thread",
    status: thread.status ?? "working",
    run: 1,
    beatAt: now,
    deadlineAt: now + project.settings.deadlineMs,
  })
  if (!space.threadIds.includes(thread.threadId)) space.threadIds.push(thread.threadId)
}

const projectOf = async (harness: Harness, threadId: ThreadId): Promise<string | undefined> =>
  (await harness.snapshot(ThreadDoc, threadId, BACKGROUND_CONTEXT))?.projectId

const statuses: readonly ThreadStatus[] = ["working", "waiting", "completed", "failed", "cancelled"]
const events: readonly ThreadEvent[] = ["done", "ask_user", "unanswered", "abort", "answer", "thread_send"]

describe("workspace", () => {
  it("creates the coordinator conversation with the workspace entry, once per command", async () => {
    const stub = fresh()
    const before = await runInDurableObject(stub, (home: Home) =>
      home.harness.commit(async (tx) => (await tx.scanConversations({}, 100)).items.length, BACKGROUND_CONTEXT),
    )
    const first = await cmd(stub, "atomic-1", "project.create", { slug: "atomic", name: "Atomic" })
    expect(first.ok).toBe(true)
    const project = first.result as { id: string; coordinatorId: number; spaceId: string }

    const after = await runInDurableObject(stub, async (home: Home) => {
      const workspace = await home.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
      const coordinator = await home.harness.conversation(project.coordinatorId as ConversationId, BACKGROUND_CONTEXT)
      const count = await home.harness.commit(
        async (tx) => (await tx.scanConversations({}, 100)).items.length,
        BACKGROUND_CONTEXT,
      )
      return { workspace, conversation: coordinator?.id, count }
    })
    expect(after.count).toBe(before + 1)
    expect(after.conversation).toBe(project.coordinatorId)
    expect(after.workspace?.projects[project.id]).toMatchObject({
      slug: "atomic",
      archived: false,
    })
    expect(after.workspace?.spaces[project.spaceId]).toMatchObject({
      projectId: project.id,
      coordinatorId: project.coordinatorId,
      threadIds: [],
      archived: false,
    })

    const replay = await cmd(stub, "atomic-1", "project.create", { slug: "atomic", name: "Atomic" })
    expect(replay).toEqual(first)
    const settled = await runInDurableObject(stub, async (home: Home) => ({
      count: await home.harness.commit(
        async (tx) => (await tx.scanConversations({}, 100)).items.length,
        BACKGROUND_CONTEXT,
      ),
      workspace: await home.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT),
    }))
    expect(settled.count).toBe(after.count)
    expect(Object.keys(settled.workspace?.projects ?? {})).toEqual([project.id])
  })

  it("rejects a duplicate slug", async () => {
    const stub = fresh()
    expect((await cmd(stub, "slug-1", "project.create", { slug: "taken", name: "One" })).ok).toBe(true)
    const duplicate = await cmd(stub, "slug-2", "project.create", { slug: "taken", name: "Two" })
    expect(duplicate).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(duplicate.error?.message).toContain("taken")
  })

  it("groups a project's threads by status on the home stream", async () => {
    const stub = owner()
    const created = await cmd(stub, "home-create-1", "project.create", { slug: "home-stream", name: "Home Stream" })
    expect(created.ok).toBe(true)
    const project = created.result as { id: string; coordinatorId: number }

    const ids = await runInDurableObject(stub, async (home: Home) => {
      const working = await conversation(home)
      const waiting = await conversation(home)
      const completed = await conversation(home)
      const failed = await conversation(home)
      const cancelled = await conversation(home)
      await home.harness.commit(async (tx) => {
        const projectId = project.id as ProjectId
        await addThread(tx, { projectId, threadId: working, title: "Working" })
        await addThread(tx, { projectId, threadId: waiting, title: "Waiting", status: "waiting" })
        await addThread(tx, { projectId, threadId: completed, title: "Completed" })
        await addThread(tx, { projectId, threadId: failed, title: "Failed" })
        await addThread(tx, { projectId, threadId: cancelled, title: "Cancelled" })
        const move = async (threadId: ThreadId, event: ThreadEvent, result?: string) => {
          const doc = await tx.doc(ThreadDoc, threadId)
          const next = transition(doc.status, event)
          if (next.kind !== "ok") throw new Error(next.reason)
          doc.status = next.status
          if (result !== undefined) doc.result = result
        }
        await move(completed, "done", "all good")
        await move(failed, "unanswered", "provider failed")
        await move(cancelled, "abort")
        const requests = await tx.doc(RequestsDoc, waiting)
        requests.open["q1"] = { kind: "question", question: "Pick one", at: Date.now() }
      }, BACKGROUND_CONTEXT)
      return { working, waiting, completed, failed, cancelled }
    })

    expect(await runInDurableObject(stub, (home: Home) => projectOf(home.harness, ids.working))).toBe(project.id)

    const socket = await connect()
    socket.send({ t: "sub", stream: "home" })
    const snapshot = await socket.next((frame) => frame.t === "snap" && frame.stream === "home")
    socket.close()

    const found = projectsOf(snapshot.value).find((entry) => entry.id === project.id)
    expect(found?.threads.working.map((thread) => thread.title)).toEqual(["Working"])
    expect(found?.threads.waiting.map((thread) => thread.title)).toEqual(["Waiting"])
    expect(found?.threads.completed).toMatchObject([{ title: "Completed", result: "all good" }])
    expect(found?.threads.failed).toMatchObject([{ title: "Failed", result: "provider failed" }])
    expect(found?.threads.cancelled.map((thread) => thread.title)).toEqual(["Cancelled"])
    expect(found?.openRequests).toBe(1)
  })

  it("accepts exactly the transitions in the state machine", () => {
    const arrows: readonly { from: ThreadStatus; event: ThreadEvent; to: ThreadStatus }[] = [
      { from: "working", event: "done", to: "completed" },
      { from: "working", event: "ask_user", to: "waiting" },
      { from: "working", event: "unanswered", to: "failed" },
      { from: "working", event: "abort", to: "cancelled" },
      { from: "waiting", event: "answer", to: "working" },
      { from: "completed", event: "thread_send", to: "working" },
      { from: "failed", event: "thread_send", to: "working" },
      { from: "cancelled", event: "thread_send", to: "working" },
    ]
    for (const status of statuses) {
      for (const event of events) {
        const arrow = arrows.find((candidate) => candidate.from === status && candidate.event === event)
        const result = transition(status, event)
        if (arrow === undefined) expect(result.kind).toBe("rejected")
        else expect(result).toEqual({ kind: "ok", status: arrow.to })
      }
    }
  })

  it("puts the owner's name and workspace instructions in the system prompt", async () => {
    const stub = fresh()
    const set = await cmd(stub, "owner-set-1", "owner.set", { name: "Ada", instructions: "Answer in Latin." })
    expect(set).toMatchObject({ ok: true, result: { name: "Ada", instructions: "Answer in Latin." } })
    expect((await cmd(stub, "owner-read-1", "owner.read")).result).toEqual({
      name: "Ada",
      instructions: "Answer in Latin.",
    })

    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, "owner-turn-1")
    expect(offers.latest().system).toContain("<owner>")
    expect(offers.latest().system).toContain("Answer in Latin.")

    await cmd(stub, "owner-set-2", "owner.set", { instructions: "   " })
    const cleared = recordOffers()
    respond([cleared.step("ok")])
    await turn(stub, "owner-turn-2")
    expect(cleared.latest().system).not.toContain("<owner>")
  })

  it("archives a project without losing its threads", async () => {
    const stub = fresh()
    const created = await cmd(stub, "archive-1", "project.create", { slug: "archived", name: "Archived" })
    expect(created.ok).toBe(true)
    const project = created.result as { id: string; coordinatorId: number; spaceId: string }

    const threadId = await runInDurableObject(stub, async (home: Home) => {
      const id = await conversation(home)
      await home.harness.commit(
        (tx) => addThread(tx, { projectId: project.id as ProjectId, threadId: id, title: "Kept" }),
        BACKGROUND_CONTEXT,
      )
      return id
    })

    const archived = await cmd(stub, "archive-2", "project.archive", { id: project.id })
    expect(archived).toMatchObject({ ok: true, result: { archived: true } })

    const read = await cmd(stub, "archive-read-1", "workspace.read")
    const projects = projectsOf(read.result)
    const found = projects.find((entry) => entry.id === project.id)
    expect(found?.archived).toBe(true)
    expect(found?.coordinatorId).toBe(project.coordinatorId)
    expect(found?.threads.working.map((thread) => thread.title)).toEqual(["Kept"])
    expect(projects.filter((entry) => !entry.archived)).toEqual([])

    const stored = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT),
    )
    expect(stored?.spaces[project.spaceId]?.threadIds).toEqual([threadId])
  })

  it("migrates a v1 project into one project and one space", () => {
    const migrate = WorkspaceDoc.definition.migrate
    if (migrate === undefined) throw new Error("xin.workspace has no migration")
    const legacy = {
      projects: {
        prj_a: {
          slug: "alpha",
          name: "Alpha",
          goal: "ship it",
          preset: "full",
          coordinatorId: 7,
          threadIds: [3, 4],
          settings: { threadLimit: 8, deadlineMs: 1_000 },
          archived: false,
        },
      },
    }
    expect(migrate(legacy, 1)).toEqual({
      projects: {
        prj_a: {
          slug: "alpha",
          name: "Alpha",
          preset: "full",
          settings: { threadLimit: 8, deadlineMs: 1_000 },
          archived: false,
        },
      },
      spaces: {
        spc_a: {
          name: "Alpha",
          goal: "ship it",
          projectId: "prj_a",
          coordinatorId: 7,
          threadIds: [3, 4],
          archived: false,
        },
      },
    })

    const migrated = migrate(legacy, 1)
    const restored = Object.fromEntries(
      Object.entries(migrated.projects).map(([id, project]) => {
        const space = Object.values(migrated.spaces).find((entry) => entry.projectId === id)
        if (space === undefined) throw new Error(`no space for ${id}`)
        return [
          id,
          {
            ...project,
            ...(space.goal === undefined ? {} : { goal: space.goal }),
            coordinatorId: space.coordinatorId,
            threadIds: space.threadIds,
          },
        ]
      }),
    )
    expect(restored).toEqual(legacy.projects)
  })

  it("renders the space and its goal into the prompt", async () => {
    const stub = fresh()
    const created = await cmd(stub, "space-goal-1", "project.create", {
      slug: "goal-space",
      name: "Goal Space",
      goal: "ship the thing",
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { coordinatorId: number }
    const offers = recordOffers()
    respond([offers.step("ok")])
    await runInDurableObject(stub, async (home: Home) => {
      const coordinator = await home.harness.conversation(project.coordinatorId as ConversationId, BACKGROUND_CONTEXT)
      if (coordinator === undefined) throw new Error("no coordinator conversation")
      await coordinator.configure({ model: M8_MODEL }, BACKGROUND_CONTEXT)
      await coordinator.submit({ type: "input", content: "hi", requestId: "space-goal-turn-1" }, BACKGROUND_CONTEXT)
      await coordinator.waitForIdle(BACKGROUND_CONTEXT)
    })
    expect(offers.latest().system).toContain("<space>")
    expect(offers.latest().system).toContain("space: Goal Space")
    expect(offers.latest().system).toContain("project: Goal Space (goal-space)")
    expect(offers.latest().system).toContain("goal: ship the thing")
  })

  it("migrates a stored v1 document when pi reads it", async () => {
    type LegacyProject = {
      slug: string
      name: string
      goal?: string
      coordinatorId: number
      threadIds: number[]
      settings: { threadLimit: number; deadlineMs: number }
      archived: boolean
    }
    const LegacyWorkspace = defineDoc<{ projects: Record<string, LegacyProject> }>({
      kind: "xin.workspace",
      version: 1,
      scope: "session",
      initial: () => ({ projects: {} }),
      checkpointWhen: () => false,
    })
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    )
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(LegacyWorkspace)
        doc.projects.prj_a = {
          slug: "alpha",
          name: "Alpha",
          goal: "ship it",
          coordinatorId: 7,
          threadIds: [3, 4],
          settings: { threadLimit: 8, deadlineMs: 1_000 },
          archived: false,
        }
      }, BACKGROUND_CONTEXT)
      const migrated = await harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT)
      expect(migrated?.projects.prj_a).toMatchObject({ slug: "alpha", name: "Alpha" })
      expect(migrated?.spaces.spc_a).toMatchObject({
        name: "Alpha",
        goal: "ship it",
        projectId: "prj_a",
        coordinatorId: 7,
        threadIds: [3, 4],
      })
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
    }
  })
})
