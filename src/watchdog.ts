import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type ConversationId,
  type Cursor,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  type Task,
  type TaskId,
  type Tx,
  ToolTask,
} from "@earendil-works/pi-durable"
import { enqueue } from "./gateway.ts"
import { isJobTool, JobsDoc, type JobRecord } from "./jobs.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { ThreadDoc, type ThreadDocState } from "./threaddoc.ts"
import { WorkspaceDoc } from "./workspace.ts"

const context = BACKGROUND_CONTEXT
export const WATCHDOG_KIND = "xin.watchdog"
export const WATCHDOG_INTERVAL_MS = 30_000
export const STALL_MS = 120_000
const PAGE = 200

type Victim =
  | {
      readonly kind: "thread"
      readonly id: number
      readonly run: number
      readonly parentId?: number
      readonly title: string
      readonly text: string
    }
  | {
      readonly kind: "job"
      readonly id: string
      readonly parentId: number
      readonly title: string
      readonly text: string
    }

type WatchdogState =
  | { readonly phase: "check" }
  | { readonly phase: "sleep" }
  | { readonly phase: "fail"; readonly victims: readonly Victim[] }

export type WatchdogTask = Task<null, WatchdogState, null, object>

export function watchdogTask(deps: ModuleDeps): WatchdogTask {
  return defineTask<null, WatchdogState, null, object>({
    name: WATCHDOG_KIND,
    version: 1,
    initial: () => ({ phase: "check" }),
    phases: {
      check: async (_task, runtime, taskContext) => {
        const now = runtime.now()
        const candidates = await sweep(deps, now)
        const idle = candidates.length === 0 && !(await anyWork(deps))
        await runtime.commit(async (tx) => {
          const victims: Victim[] = []
          for (const candidate of candidates) {
            if (candidate.kind === "thread") {
              const doc = await tx.doc(ThreadDoc, candidate.id as ConversationId)
              if (doc.status !== "working") continue
              doc.status = "failed"
              doc.result = candidate.text
              doc.beatAt = now
              delete doc.statusLine
            }
            victims.push(candidate)
          }
          if (victims.length > 0) return { status: "running", checkpoint: { phase: "fail", victims } } as const
          if (idle) return { status: "terminal", outcome: { status: "completed", result: null } } as const
          return { status: "running", checkpoint: { phase: "sleep" } } as const
        }, taskContext)
      },
      fail: async (task, runtime, taskContext) => {
        for (const victim of task.state.checkpoint.victims) await deliverFailure(deps, victim, runtime.now())
        if (!(await anyWork(deps))) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }) as const,
            taskContext,
          )
          return
        }
        await runtime.sleepUntil(runtime.now() + WATCHDOG_INTERVAL_MS, { phase: "check" }, taskContext)
      },
      sleep: (_task, runtime, taskContext) =>
        runtime.sleepUntil(runtime.now() + WATCHDOG_INTERVAL_MS, { phase: "check" }, taskContext),
    },
    abort: (_task, runtime, taskContext) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, taskContext),
  })
}

export function create(deps: ModuleDeps): HostModule {
  const task = watchdogTask(deps)
  return {
    extensions: [
      defineExtension({
        name: "xin.watchdog",
        tasks: [task],
        hooks: [
          hook(GenerationTask, {
            afterResponse: async (_message, api) => {
              await beat(deps, api.conversationId)
            },
          }),
          hook(ToolTask, {
            afterTool: async (call, _result, api) => {
              await beat(deps, api.conversationId, call.name)
              return undefined
            },
          }),
        ],
      }),
    ],
    start: () => ensureWatchdog(deps, task),
    fire: () => ensureWatchdog(deps, task),
  }
}

export async function ensureWatchdogTx(tx: Tx, task: WatchdogTask, conversationId: ConversationId): Promise<void> {
  if (await liveWatchdog(tx)) return
  await tx.createTask(task, null, {
    ownership: { kind: "conversation" },
    conversationId,
    background: true,
  })
}

export async function ensureWatchdog(deps: ModuleDeps, task: WatchdogTask): Promise<void> {
  if (!(await anyWork(deps))) return
  const root = await deps.harness().root(context)
  const created = await deps.harness().commit(async (tx) => {
    if (await liveWatchdog(tx)) return false
    await ensureWatchdogTx(tx, task, root.id)
    return true
  }, context)
  if (created) await deps.arm()
}

async function liveWatchdog(tx: Tx): Promise<boolean> {
  let cursor: Cursor | undefined
  for (;;) {
    const page = await tx.scanTasks({ kind: WATCHDOG_KIND }, PAGE, cursor)
    for (const record of page.items) {
      if (record.state.status !== "terminal" && !record.abortRequested) return true
    }
    if (page.next === undefined) return false
    cursor = page.next
  }
}

type LiveThread = { readonly id: ConversationId; readonly doc: ThreadDocState }

async function threadsOf(deps: ModuleDeps): Promise<LiveThread[]> {
  const harness = deps.harness()
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return []
  const found: LiveThread[] = []
  for (const project of Object.values(workspace.projects)) {
    for (const id of project.threadIds) {
      const conversationId = id as ConversationId
      const doc = await harness.snapshot(ThreadDoc, conversationId, context)
      if (doc !== undefined) found.push({ id: conversationId, doc })
    }
  }
  return found
}

async function jobsOf(deps: ModuleDeps): Promise<Record<string, JobRecord>> {
  const doc = await deps.harness().snapshot(JobsDoc, context)
  if (doc === undefined) return {}
  const live: Record<string, JobRecord> = {}
  for (const [id, job] of Object.entries(doc.jobs)) if (job.result === undefined) live[id] = job
  return live
}

async function anyWork(deps: ModuleDeps): Promise<boolean> {
  const threads = await threadsOf(deps)
  if (threads.some(({ doc }) => doc.status === "working")) return true
  return Object.keys(await jobsOf(deps)).length > 0
}

async function sweep(deps: ModuleDeps, now: number): Promise<Victim[]> {
  const victims: Victim[] = []
  for (const { id, doc } of await threadsOf(deps)) {
    if (doc.status !== "working") continue
    const live = await deps.harness().snapshot(LiveDoc, id, context)
    const tool = live?.tools?.find((slot) => slot.status === "running")?.name
    const covered = tool !== undefined && isJobTool(tool)
    const stalled = !covered && now - (doc.beatAt ?? now) > STALL_MS
    const overtime = doc.deadlineAt !== undefined && now > doc.deadlineAt
    if (!stalled && !overtime) continue
    victims.push({
      kind: "thread",
      id,
      run: doc.run ?? 1,
      ...(doc.parentId === undefined ? {} : { parentId: doc.parentId }),
      title: doc.title,
      text: failureText(stalled, tool),
    })
  }
  for (const [id, job] of Object.entries(await jobsOf(deps))) {
    if (now <= job.deadlineAt) continue
    if (!Number.isInteger(Number(id))) continue
    victims.push({
      kind: "job",
      id,
      parentId: job.parentId,
      title: job.title,
      text: "stopped: deadline exceeded",
    })
  }
  return victims
}

function failureText(stalled: boolean, tool: string | undefined): string {
  return stalled ? `stopped: no progress for 2 min in ${tool ?? "the model"}` : "stopped: deadline exceeded"
}

async function deliverFailure(deps: ModuleDeps, victim: Victim, now: number): Promise<void> {
  if (victim.kind === "thread") {
    if (victim.parentId !== undefined) {
      const accepted = await enqueue(
        deps.db,
        {
          target: victim.parentId as ConversationId,
          commandId: `report:${victim.id}:${victim.run}`,
          kind: "report",
          threadId: String(victim.id),
          title: victim.title,
          status: "failed",
          text: victim.text,
        },
        now,
      )
      if (accepted) await deps.arm()
    }
    const conversation = await deps.harness().conversation(victim.id as ConversationId, context)
    if (conversation !== undefined) await conversation.abort(context, { background: true })
    return
  }
  const job = (await deps.harness().snapshot(JobsDoc, context))?.jobs[victim.id]
  if (job === undefined || job.result !== undefined) return
  const accepted = await enqueue(
    deps.db,
    {
      target: victim.parentId as ConversationId,
      commandId: `job:${victim.id}`,
      kind: "job",
      threadId: victim.id,
      title: victim.title,
      status: "failed",
      text: victim.text,
    },
    now,
  )
  if (accepted) await deps.arm()
  const taskId = Number(victim.id) as TaskId
  if ((await deps.harness().getTask(taskId, context)) !== undefined) await deps.harness().abortTask(taskId, context)
  await deps.harness().commit(async (tx) => {
    const doc = await tx.doc(JobsDoc)
    delete doc.jobs[victim.id]
  }, context)
}

async function beat(deps: ModuleDeps, conversationId: ConversationId, line?: string): Promise<void> {
  const thread = await deps.harness().snapshot(ThreadDoc, conversationId, context)
  if (thread === undefined || thread.status !== "working") return
  await deps.harness().commit(async (tx) => {
    const doc = await tx.doc(ThreadDoc, conversationId)
    if (doc.status !== "working") return
    doc.beatAt = Date.now()
    if (line !== undefined) doc.statusLine = line
  }, context)
}
