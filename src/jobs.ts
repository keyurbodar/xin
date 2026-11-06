import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import { isJsonValue } from "@earendil-works/chord"
import {
  type CommitObserver,
  type ConversationId,
  type DocumentReader,
  defineDoc,
  defineExtension,
  defineTask,
  type JsonObject,
  type Task,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Models } from "@earendil-works/pi-ai"
import { bool, compile, int, map, num, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import { enqueue } from "./gateway.ts"
import type { HostModule, ModuleDeps } from "./module.ts"
import { projectInScope, ThreadDoc } from "./threaddoc.ts"
import { DEFAULT_DEADLINE_MS, WorkspaceDoc } from "./workspace.ts"

const context = BACKGROUND_CONTEXT
export const JOB_KIND = "xin.job"
export const JOB_WAIT_MS = 8_000

const JobSchema = obj({
  tool: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  startedAt: num(),
  deadlineAt: num(),
  parentId: int({ minimum: 0 }),
  detached: opt(bool()),
  result: opt(obj({ text: str(), isError: bool(), details: opt(obj({}, { open: true })) }, { open: true })),
})
const JobsSchema = obj({ jobs: map(JobSchema), calls: opt(map(int({ minimum: 0 }))) })

export type JobRecord = Static<typeof JobSchema>
export type JobsState = Static<typeof JobsSchema>

const parseJobs = compile(JobsSchema)

export const JobsDoc = defineDoc<JobsState>({
  kind: "xin.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => false,
})

export type JobSummary = {
  readonly text: string
  readonly isError: boolean
  readonly details?: JsonObject
}

export type JobInput = {
  readonly tool: string
  readonly title: string
  readonly args: JsonObject
  readonly parentId: number
}

export type JobState = { readonly phase: "run" } | { readonly phase: "finish"; readonly summary: JobSummary }

export type JobTask = Task<JobInput, JobState, JobSummary, object>

export type JobRun = {
  readonly signal: AbortSignal
  readonly models: Models
  now(): number
  env(): Promise<ExecutionEnv | undefined>
}

export type JobWork = (args: JsonObject, run: JobRun, context: Context) => Promise<ToolExecutionResult>

const RUNNERS = new Map<string, JobWork>()

export const isJobTool = (name: string): boolean => RUNNERS.has(name)

export type JobTool = Omit<ToolRegistration, "execute">

export function jobTool(tool: JobTool, work: JobWork): ToolRegistration {
  RUNNERS.set(tool.name, work)
  return {
    ...tool,
    replay: "safe",
    execute: async (args, api, callContext) => {
      const startedAt = api.now()
      const deadlineAt = startedAt + (await deadlineOf(api, api.conversationId))
      const inThread = (await api.snapshot(ThreadDoc, api.conversationId, callContext)) !== undefined
      const claim = await api.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc)
        const reused = doc.calls?.[String(api.taskId)]
        if (reused !== undefined) return { id: reused, detached: doc.jobs[String(reused)]?.detached === true }
        const input: JobInput = {
          tool: tool.name,
          title: tool.name,
          args: jsonObjectOf(args),
          parentId: api.conversationId,
        }
        const id = await tx.createTask(Job, input, {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        })
        doc.jobs[String(id)] = {
          tool: tool.name,
          title: tool.name,
          startedAt,
          deadlineAt,
          parentId: api.conversationId,
        }
        doc.calls = { ...doc.calls, [String(api.taskId)]: id }
        return { id, detached: false }
      }, callContext)

      if (claim.detached) return started(claim.id)
      const waiter = withCancel(callContext)
      let expired = false
      const limit = Math.max(0, inThread ? deadlineAt - api.now() : JOB_WAIT_MS)
      const timer = setTimeout(() => {
        expired = true
        waiter.cancel(new Error("job deadline"))
      }, limit)
      try {
        const settled = await api.waitForTask(claim.id as TaskId, waiter.context)
        await drop(api, claim.id, callContext)
        return resultOf(summaryOf(settled.state.outcome))
      } catch (error) {
        if (!expired) throw error
        if (inThread) return deadlineMissed(claim.id)
        await detach(api, claim.id, callContext)
        return started(claim.id)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export const Job: JobTask = defineTask<JobInput, JobState, JobSummary, object>({
  name: JOB_KIND,
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, callContext) => {
      const work = RUNNERS.get(task.input.tool)
      const summary = work === undefined ? missing(task.input.tool) : await runWork(work, task, runtime, callContext)
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish", summary } }), callContext)
    },
    finish: async (task, runtime, callContext) => {
      const summary = task.state.checkpoint.summary
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc)
        const entry = doc.jobs[String(task.id)]
        if (entry !== undefined) entry.result = { ...summary }
        return { status: "terminal", outcome: { status: "completed", result: summary } } as const
      }, callContext)
    },
  },
  abort: (task, runtime, callContext) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(JobsDoc)
      delete doc.jobs[String(task.id)]
      return { status: "terminal", outcome: { status: "aborted" } } as const
    }, callContext),
})

async function runWork(
  work: JobWork,
  task: { readonly input: JobInput },
  runtime: TaskRuntime<JobInput, JobState, JobSummary, object>,
  callContext: Context,
): Promise<JobSummary> {
  try {
    return summarize(await work(task.input.args, jobRun(runtime, callContext), callContext))
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

function jobRun(runtime: TaskRuntime<JobInput, JobState, JobSummary, object>, callContext: Context): JobRun {
  return {
    signal: runtime.signal,
    models: runtime.models,
    now: () => runtime.now(),
    env: () => runtime.env(callContext),
  }
}

function missing(tool: string): JobSummary {
  return { text: `no runner for ${tool}`, isError: true }
}

function summarize(result: ToolExecutionResult): JobSummary {
  const text = (result.output ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  return {
    text: text === "" ? "(no output)" : text,
    isError: result.isError === true,
    ...(result.details === undefined ? {} : { details: jsonObjectOf(result.details) }),
  }
}

function resultOf(summary: JobSummary): ToolExecutionResult {
  return {
    output: [{ type: "text", text: summary.text }],
    isError: summary.isError,
    ...(summary.details === undefined ? {} : { details: summary.details }),
  }
}

function started(id: number): ToolExecutionResult {
  return {
    output: [{ type: "text", text: `started (job ${id}), result will follow` }],
    details: { jobId: id },
  }
}

function deadlineMissed(id: number): ToolExecutionResult {
  return {
    output: [{ type: "text", text: `job ${id} did not finish before its deadline` }],
    isError: true,
    details: { jobId: id },
  }
}

type Outcome =
  | { readonly status: "completed"; readonly result?: unknown }
  | { readonly status: "failed" | "faulted"; readonly error?: { readonly message: string } }
  | { readonly status: "aborted" }
  | { readonly status: "orphaned"; readonly reason?: string }

export function summaryOf(outcome: Outcome): JobSummary {
  switch (outcome.status) {
    case "completed": {
      const result = outcome.result
      if (typeof result !== "object" || result === null) return { text: "(no output)", isError: false }
      const text = Reflect.get(result, "text")
      const details = Reflect.get(result, "details")
      return {
        text: typeof text === "string" ? text : "(no output)",
        isError: Reflect.get(result, "isError") === true,
        ...(details === undefined ? {} : { details: jsonObjectOf(details) }),
      }
    }
    case "failed":
    case "faulted":
      return { text: outcome.error?.message ?? outcome.status, isError: true }
    case "aborted":
      return { text: "cancelled", isError: true }
    case "orphaned":
      return { text: outcome.reason ?? "orphaned", isError: true }
    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

function detach(api: ToolExecutionApi, id: number, callContext: Context): Promise<void> {
  return api.commit(async (tx) => {
    const doc = await tx.doc(JobsDoc)
    const entry = doc.jobs[String(id)]
    if (entry !== undefined) entry.detached = true
  }, callContext)
}

function drop(api: ToolExecutionApi, id: number, callContext: Context): Promise<void> {
  return api.commit(async (tx) => {
    const doc = await tx.doc(JobsDoc)
    delete doc.jobs[String(id)]
  }, callContext)
}

async function deadlineOf(read: DocumentReader, conversationId: ConversationId): Promise<number> {
  const workspace = await read.snapshot(WorkspaceDoc, context)
  if (workspace === undefined) return DEFAULT_DEADLINE_MS
  for (const project of Object.values(workspace.projects)) {
    if (project.coordinatorId === conversationId || project.threadIds.includes(conversationId))
      return project.settings.deadlineMs
  }
  return DEFAULT_DEADLINE_MS
}

function jsonObjectOf(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const found: JsonObject = {}
  for (const [key, item] of Object.entries(value)) if (isJsonValue(item)) found[key] = item
  return found
}

export async function cancelJob(deps: ModuleDeps, callerId: ConversationId, jobId: number): Promise<boolean> {
  const harness = deps.harness()
  const scope = await projectInScope(harness, callerId)
  if (scope === undefined) return false
  const doc = await harness.snapshot(JobsDoc, context)
  const job = doc?.jobs[String(jobId)]
  if (job === undefined || job.result !== undefined) return false
  if (job.parentId !== scope.project.coordinatorId && !scope.project.threadIds.includes(job.parentId)) return false
  await harness.abortTask(jobId as TaskId, context)
  return true
}

export function create(deps: ModuleDeps): HostModule {
  const pending = new Set<string>()
  let scheduled = false

  const collect = (value: JsonObject): void => {
    if (!parseJobs.check(value)) return
    for (const [id, job] of Object.entries(value.jobs)) {
      if (job.detached === true && job.result !== undefined) pending.add(id)
    }
  }

  const observe: CommitObserver = {
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change") continue
        if (change.record.kind !== "xin.jobs") continue
        collect(change.value)
      }
      if (pending.size > 0) schedule()
    },
    end: () => undefined,
  }

  const deliver = async (): Promise<void> => {
    if (pending.size === 0) return
    const ids = [...pending]
    pending.clear()
    const harness = deps.harness()
    const doc = await harness.snapshot(JobsDoc, context)
    if (doc === undefined) return
    for (const id of ids) {
      const job = doc.jobs[id]
      if (job?.result === undefined || job.detached !== true) continue
      const accepted = await enqueue(
        deps.db,
        {
          target: job.parentId as ConversationId,
          commandId: `job:${id}`,
          kind: "job",
          threadId: id,
          title: job.title,
          status: job.result.isError ? "failed" : "completed",
          text: job.result.text,
        },
        Date.now(),
      )
      if (accepted) await deps.arm()
      await harness.commit(async (tx) => {
        const current = await tx.doc(JobsDoc)
        const entry = current.jobs[id]
        if (entry?.result !== undefined && entry.detached === true) delete current.jobs[id]
      }, context)
    }
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void deliver().catch((failure: unknown) => console.warn("jobs: delivery failed", failure))
    })
  }

  return {
    extensions: [defineExtension({ name: "xin.jobs", tasks: [Job] })],
    async start() {
      const observation = deps.harness().observeCommits(observe)
      const doc = await deps.harness().snapshot(JobsDoc, context)
      if (doc !== undefined) collect(doc)
      schedule()
      return () => observation.detach()
    },
  }
}
