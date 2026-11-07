import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord"
import {
  type ConversationId,
  type Cursor,
  defineExtension,
  defineTask,
  type Extension,
  type Harness,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable"
import { compile, int, lit, obj, str, union } from "@earendil-works/pi-schema"
import type { IntakeService } from "../../src/contracts/intake.ts"
import {
  ID_SOURCE,
  SCHEDULE_FIELDS,
  type ScheduleRequest,
  type SchedulesService,
} from "../../src/contracts/schedules.ts"
import { defineOp, type Op, type OpApi, OpRejected } from "../../src/ops.ts"
import { type DueWindow, type Occurrence, parseRule, RuleError, slotsOf, validateZone, type When } from "./rrule.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"

const context = BACKGROUND_CONTEXT

export const SCHEDULE_TASK = "xin.schedule"
export const SCHEDULE_VERSION = 1
const ID = new RegExp(ID_SOURCE)
const MISSED = " (missed ×"
const TITLE_LENGTH = 60
const PAGE = 200

const WHEN = union([
  obj({ kind: lit("at"), at: int({ minimum: 0 }) }),
  obj({ kind: lit("rrule"), rrule: str({ minLength: 1, maxLength: 512 }) }),
])

const INPUT = compile(
  obj({
    id: str({ minLength: 1, maxLength: 64 }),
    prompt: str({ minLength: 1, maxLength: 4000 }),
    tz: str({ minLength: 1, maxLength: 64 }),
    target: int({ minimum: 0 }),
    anchor: int({ minimum: 0 }),
    when: WHEN,
  }),
)

export type ScheduleInput = {
  readonly id: string
  readonly prompt: string
  readonly tz: string
  readonly target: ConversationId
  readonly anchor: number
  readonly when: When
}

type Progress = { readonly last: number; readonly index: number }

type ScheduleState =
  | ({ readonly phase: "wait" } & Progress)
  | ({ readonly phase: "fire" } & Progress)
  | ({ readonly phase: "send"; readonly due: DueWindow } & Progress)

export type FirePorts = {
  readonly intake: Pick<IntakeService, "enqueue">
  readonly arm: () => Promise<void>
}

export type SchedulesPort = FirePorts & { readonly harness: Harness }

type LiveSchedule = {
  readonly taskId: TaskId
  readonly input: ScheduleInput
  readonly until: number | undefined
}

export function schedulesService(port: SchedulesPort): SchedulesService {
  return {
    create: async (request, fallback, now, defaultId) => {
      const created = await createSchedule(port, request, fallback, now, defaultId)
      return { id: created.id, created: created.created }
    },
    cancel: (id) => cancelSchedules(port, id),
  }
}

export function schedulesExtension(port: SchedulesPort): Extension {
  return defineExtension({ name: "schedules", tasks: [scheduleTask(port)] })
}

export function scheduleOps(port: SchedulesPort): readonly Op[] {
  return [createOp(port), cancelOp(port), listOp(port)]
}

function complete(runtime: TaskRuntime<ScheduleInput, ScheduleState, null, object>, ctx: Context): Promise<void> {
  return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx)
}

export function scheduleTask(port: SchedulesPort): Task<ScheduleInput, ScheduleState, null, object> {
  return defineTask<ScheduleInput, ScheduleState, null, object>({
    name: SCHEDULE_TASK,
    version: SCHEDULE_VERSION,
    initial: (input): ScheduleState => ({ phase: "wait", last: input.anchor - 1, index: 0 }),
    phases: {
      wait: async (task, runtime, ctx) => {
        const { last, index } = task.state.checkpoint
        const next = nextSlot(task.input, last, index)
        if (next === undefined) return complete(runtime, ctx)
        if (next.slot > runtime.now()) return runtime.sleepUntil(next.slot, { phase: "fire", last, index }, ctx)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire", last, index } }), ctx)
      },
      fire: async (task, runtime, ctx) => {
        const { last, index } = task.state.checkpoint
        const due = dueOf(task.input, last, index, runtime.now())
        const checkpoint: ScheduleState =
          due === undefined ? { phase: "wait", last, index } : { phase: "send", last, index, due }
        await runtime.commit(() => ({ status: "running", checkpoint }), ctx)
      },
      send: async (task, runtime, ctx) => {
        const { due } = task.state.checkpoint
        await sendDue(port, task.input, due)
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "wait", last: due.latest, index: due.index } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  })
}

function nextSlot(input: ScheduleInput, last: number, index: number): Occurrence | undefined {
  return slotsOf(input.when, input.tz, input.anchor).next(last, index)
}

export function dueOf(input: ScheduleInput, last: number, index: number, now: number): DueWindow | undefined {
  return slotsOf(input.when, input.tz, input.anchor).due(last, index, now)
}

export async function sendDue(ports: FirePorts, input: ScheduleInput, due: DueWindow): Promise<void> {
  await ports.intake.enqueue({
    target: input.target,
    commandId: slotKey(input.id, due.latest),
    kind: "job",
    threadId: input.id,
    title: titleOf(input.prompt),
    status: "scheduled",
    text: due.count > 1 ? `${input.prompt}${MISSED}${due.count})` : input.prompt,
    clientTs: due.latest,
  })
  await ports.arm()
}

function titleOf(prompt: string): string {
  return prompt.length <= TITLE_LENGTH ? prompt : `${prompt.slice(0, TITLE_LENGTH)}...`
}

export function slotKey(id: string, slot: number): string {
  return `sched:${id}:${new Date(slot).toISOString()}`
}

async function createSchedule(
  port: SchedulesPort,
  request: ScheduleRequest,
  fallback: ConversationId,
  now: number,
  defaultId: string,
): Promise<{ id: string; taskId: number; created: boolean }> {
  const when = whenOf(request)
  checkZone(request.tz)
  if (when.kind === "rrule") checkRule(when.rrule)
  const id = request.id ?? defaultId
  if (!ID.test(id)) throw new OpRejected("bad_args", `schedule id "${id}" must be 1-64 letters, digits, "_" or "-"`)
  const target = await targetOf(port, request, fallback)
  const input: ScheduleInput = { id, prompt: request.prompt, tz: request.tz, target, anchor: now, when }
  const created = await port.harness.commit(async (tx) => {
    const existing = await scheduledTask(tx, id)
    if (existing !== undefined) return { id, taskId: existing, created: false }
    const taskId = await tx.createTask(scheduleTask(port), input, {
      ownership: { kind: "conversation" },
      conversationId: target,
      background: true,
    })
    return { id, taskId, created: true }
  }, context)
  if (created.created) await port.arm()
  return created
}

function whenOf(request: ScheduleRequest): When {
  const at = request.at
  const rrule = request.rrule
  if (at !== undefined && rrule !== undefined) throw new OpRejected("bad_args", "give rrule or at, not both")
  if (at !== undefined) return { kind: "at", at }
  if (rrule !== undefined) return { kind: "rrule", rrule }
  throw new OpRejected("bad_args", "give exactly one of rrule or at")
}

async function targetOf(
  port: SchedulesPort,
  request: ScheduleRequest,
  fallback: ConversationId,
): Promise<ConversationId> {
  if (request.projectId !== undefined) {
    if (request.conv !== undefined) throw new OpRejected("bad_args", "give conv or projectId, not both")
    return coordinatorOf(port, request.projectId)
  }
  return request.conv === undefined ? fallback : conversationOf(port, request.conv)
}

async function coordinatorOf(port: SchedulesPort, projectId: string): Promise<ConversationId> {
  const workspace = await port.harness.snapshot(WorkspaceDoc, context)
  const project = workspace?.projects[projectId]
  if (project === undefined) throw new OpRejected("bad_args", `no project ${projectId}`)
  return project.coordinatorId as ConversationId
}

function checkZone(tz: string): void {
  try {
    validateZone(tz)
  } catch (error) {
    throw reject(error)
  }
}

function checkRule(text: string): void {
  try {
    parseRule(text)
  } catch (error) {
    throw reject(error)
  }
}

function reject(error: unknown): Error {
  return error instanceof RuleError
    ? new OpRejected("bad_args", error.message)
    : error instanceof Error
      ? error
      : new Error(String(error))
}

async function conversationOf(port: SchedulesPort, conv: number): Promise<ConversationId> {
  const found = await port.harness.conversation(conv as ConversationId, context)
  if (found === undefined) throw new OpRejected("bad_args", `no conversation ${conv}`)
  return found.id
}

async function scheduledTask(tx: Tx, id: string): Promise<TaskId | undefined> {
  let cursor: Cursor | undefined
  for (;;) {
    const page = await tx.scanTasks({ kind: SCHEDULE_TASK }, PAGE, cursor)
    for (const record of page.items) {
      if (record.abortRequested || record.state.status === "terminal") continue
      if (scheduleInputOf(record.input)?.id === id) return record.id
    }
    if (page.next === undefined) return undefined
    cursor = page.next
  }
}

async function liveSchedules(port: SchedulesPort): Promise<readonly LiveSchedule[]> {
  const inspection = await port.harness.inspect(context)
  const live: LiveSchedule[] = []
  for (const task of inspection.tasks) {
    if (task.record.kind !== SCHEDULE_TASK || task.record.abortRequested) continue
    const input = scheduleInputOf(task.record.input)
    if (input === undefined) continue
    live.push({ taskId: task.record.id, input, until: task.state.kind === "sleeping" ? task.state.until : undefined })
  }
  return live
}

function scheduleInputOf(value: unknown): ScheduleInput | undefined {
  if (!INPUT.check(value)) return undefined
  return {
    id: value.id,
    prompt: value.prompt,
    tz: value.tz,
    anchor: value.anchor,
    target: value.target as ConversationId,
    when: value.when,
  }
}

async function cancelSchedules(port: SchedulesPort, id: string): Promise<boolean> {
  const matching = (await liveSchedules(port)).filter((schedule) => schedule.input.id === id)
  for (const schedule of matching) await port.harness.abortTask(schedule.taskId, context)
  if (matching.length > 0) await port.arm()
  return matching.length > 0
}

function stableId(source: string): string {
  const cleaned = source.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)
  return cleaned === "" ? crypto.randomUUID() : cleaned
}

function createOp(port: SchedulesPort): Op {
  return defineOp({
    name: "schedule.create",
    args: obj(SCHEDULE_FIELDS),
    actors: ["owner", "agent"],
    run: async (api, args) =>
      createSchedule(port, args, await fallbackConversation(port, api), Date.now(), args.id ?? stableId(api.commandId)),
  })
}

function cancelOp(port: SchedulesPort): Op {
  return defineOp({
    name: "schedule.cancel",
    args: obj({ id: str({ pattern: ID_SOURCE }) }),
    actors: ["owner", "agent"],
    run: async (_api, args) => ({ id: args.id, cancelled: await cancelSchedules(port, args.id) }),
  })
}

function listOp(port: SchedulesPort): Op {
  return defineOp({
    name: "schedule.list",
    args: obj({}),
    actors: ["owner", "agent"],
    run: async () => ({
      schedules: (await liveSchedules(port)).map((schedule) => ({
        id: schedule.input.id,
        prompt: schedule.input.prompt,
        tz: schedule.input.tz,
        target: schedule.input.target,
        ...(schedule.input.when.kind === "at" ? { at: schedule.input.when.at } : {}),
        ...(schedule.input.when.kind === "rrule" ? { rrule: schedule.input.when.rrule } : {}),
        ...(schedule.until === undefined ? {} : { nextAt: schedule.until }),
      })),
    }),
  })
}

async function fallbackConversation(port: SchedulesPort, api: OpApi): Promise<ConversationId> {
  if (api.actor.kind === "agent") return api.actor.conversationId
  return (await port.harness.root(context)).id
}
