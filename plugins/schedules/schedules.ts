import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Context, JsonValue } from "@earendil-works/chord"
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTask,
  type Extension,
  type Harness,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable"
import { bool, compile, int, lit, map, obj, opt, type Static, str, union } from "@earendil-works/pi-schema"
import type { IntakeService } from "../../src/contracts/intake.ts"
import type { Notification, PushService } from "../../src/contracts/push.ts"
import {
  DEFAULT_LIST_LIMIT,
  editRequest,
  ID_SOURCE,
  MAX_LIST_LIMIT,
  MAX_PROMPT,
  MAX_RULE,
  MAX_TITLE,
  ScheduleEditArgsSchema,
  ScheduleInputError,
  type CreatedSchedule,
  type ScheduleCreateRequest,
  type ScheduleEditRequest,
  type ScheduleEditResult,
  type ScheduleListPage,
  type ScheduleListRequest,
  type SchedulePatch,
  type ScheduleTargetChoice,
  type ScheduleTask,
  type ScheduleViewResult,
  type SchedulesService,
  TargetSchema,
} from "../../src/contracts/schedules.ts"
import { defineOp, OpRejected, type Op, type OpApi } from "../../src/ops.ts"
import { serial } from "../../src/serial.ts"
import {
  type DueWindow,
  type Occurrence,
  type ParsedWhen,
  parseRuleText,
  RuleError,
  slotsOf,
  type When,
  zoneOf,
} from "./rrule.ts"

const context = BACKGROUND_CONTEXT

export const SCHEDULE_TASK = "xin.schedule"
export const SCHEDULE_VERSION = 2
const MISSED = " (missed ×"
const ID = new RegExp(ID_SOURCE)

const WhenSchema = union([
  obj({ kind: lit("at"), at: int({ minimum: 0 }) }),
  obj({ kind: lit("rrule"), rrule: str({ minLength: 1, maxLength: MAX_RULE }) }),
])

const StoredTargetSchema = union([
  obj({ kind: lit("this_session"), conversationId: int({ minimum: 0 }) }),
  obj({ kind: lit("new_once"), conversationId: opt(int({ minimum: 0 })) }),
  obj({ kind: lit("new") }),
])

const PositionSchema = obj({ last: int(), index: int({ minimum: 0 }) })

const LastDeliverySchema = obj({
  scheduledAt: str({ minLength: 1, maxLength: 100 }),
  deliveredAt: str({ minLength: 1, maxLength: 100 }),
  targetSessionId: int({ minimum: 0 }),
})

export const ScheduleRecordSchema = obj({
  id: str({ pattern: ID_SOURCE }),
  title: str({ minLength: 1, maxLength: MAX_TITLE }),
  prompt: str({ minLength: 1, maxLength: MAX_PROMPT }),
  tz: str({ minLength: 1, maxLength: 64 }),
  anchor: int(),
  when: WhenSchema,
  target: StoredTargetSchema,
  origin: int({ minimum: 0 }),
  active: bool(),
  revision: int({ minimum: 1 }),
  createdAt: int({ minimum: 0 }),
  updatedAt: str({ minLength: 1, maxLength: 100 }),
  cursor: PositionSchema,
  lastDelivery: opt(LastDeliverySchema),
})

export const SchedulesStateSchema = obj({ records: map(ScheduleRecordSchema) })

export type StoredSchedule = Static<typeof ScheduleRecordSchema>
type StoredTarget = Static<typeof StoredTargetSchema>

type Position = Static<typeof PositionSchema>

type SchedulesState = Static<typeof SchedulesStateSchema>

const RECORD = compile(ScheduleRecordSchema)
const SCHEDULES = compile(SchedulesStateSchema)

export const SchedulesDoc = defineDoc<SchedulesState>({
  kind: "xin.schedules",
  version: 1,
  scope: "session",
  initial: () => ({ records: {} }),
  checkpointWhen: () => false,
})

export type SchedulesPort = {
  readonly harness: Harness
  readonly intake: Pick<IntakeService, "enqueue">
  readonly notify: Pick<PushService, "notify" | "prefs">
  readonly arm: () => Promise<void>
}

type TimerInput = { readonly id: string; readonly revision: number }

type ScheduleState =
  | { readonly phase: "wait" }
  | { readonly phase: "fire" }
  | { readonly phase: "send"; readonly due: DueWindow }
  | { readonly phase: "retired" }

export function schedulesService(port: SchedulesPort): SchedulesService {
  const queue = serial()
  return {
    create: (request, fallback, now, defaultId) => queue(() => createSchedule(port, request, fallback, now, defaultId)),
    cancel: (id) => queue(() => cancelSchedule(port, id)),
    view: (id) => viewSchedule(port, id),
    list: (request) => listSchedules(port, request),
    edit: (request, fallback, now) => queue(() => editSchedule(port, request, fallback, now)),
  }
}

export function schedulesExtension(port: SchedulesPort): Extension {
  return defineExtension({ name: "schedules", tasks: [scheduleTask(port)] })
}

export function scheduleOps(service: SchedulesService): readonly Op[] {
  const root = rootConversation()
  return [createOp(service, root), cancelOp(service), listOp(service), viewOp(service), editOp(service, root)]
}

export function scheduleTask(port: SchedulesPort): Task<TimerInput, ScheduleState, null, object> {
  return defineTask<TimerInput, ScheduleState, null, object>({
    name: SCHEDULE_TASK,
    version: SCHEDULE_VERSION,
    initial: () => ({ phase: "wait" }),
    migrate: (input, _checkpoint, fromVersion) => {
      if (fromVersion !== 1) throw new Error(`no schedule timer migration from version ${fromVersion}`)
      return { input: { id: retiredIdOf(input), revision: 0 }, checkpoint: { phase: "retired" } }
    },
    phases: {
      wait: async (task, runtime, ctx) => {
        const record = await liveRecord(port, task.input, ctx)
        if (record === undefined) return complete(runtime, ctx)
        const next = nextOf(record)
        if (next === undefined) return complete(runtime, ctx)
        if (next.slot > runtime.now()) return runtime.sleepUntil(next.slot, { phase: "fire" }, ctx)
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire" } }), ctx)
      },
      fire: async (task, runtime, ctx) => {
        const record = await liveRecord(port, task.input, ctx)
        if (record === undefined) return complete(runtime, ctx)
        const due = dueOf(record, runtime.now())
        const checkpoint: ScheduleState = due === undefined ? { phase: "wait" } : { phase: "send", due }
        await runtime.commit(() => ({ status: "running", checkpoint }), ctx)
      },
      send: async (task, runtime, ctx) => {
        const record = await liveRecord(port, task.input, ctx)
        if (record === undefined) return complete(runtime, ctx)
        const delivered = await sendDue(port, record, task.state.checkpoint.due, runtime.now())
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(SchedulesDoc)
          const stored = doc.records[delivered.id]
          if (stored !== undefined && stored.revision === delivered.revision) doc.records[delivered.id] = delivered
          return { status: "running", checkpoint: { phase: "wait" } }
        }, ctx)
      },
      retired: (_task, runtime, ctx) => complete(runtime, ctx),
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  })
}

function complete(runtime: TaskRuntime<TimerInput, ScheduleState, null, object>, ctx: Context): Promise<void> {
  return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx)
}

function retiredIdOf(input: JsonValue): string {
  if (typeof input !== "object" || input === null) return ""
  const id: unknown = Reflect.get(input, "id")
  return typeof id === "string" ? id : ""
}

function recordsOf(state: SchedulesState | undefined): Readonly<Record<string, StoredSchedule>> {
  if (state === undefined) return {}
  if (!SCHEDULES.check(state)) {
    const reason = SCHEDULES.errors(state)
      .map((error) => `${error.path} ${error.message}`)
      .join("; ")
    throw new Error(`xin.schedules is not a valid stored document: ${reason}`)
  }
  return state.records
}

function recordOf(records: Readonly<Record<string, StoredSchedule>>, id: string): StoredSchedule | undefined {
  const stored: unknown = records[id]
  if (stored === undefined) return undefined
  if (!RECORD.check(stored)) {
    const reason = RECORD.errors(stored)
      .map((error) => `${error.path} ${error.message}`)
      .join("; ")
    throw new Error(`schedule "${id}" is not a valid stored record: ${reason}`)
  }
  return stored
}

async function liveRecord(port: SchedulesPort, input: TimerInput, ctx: Context): Promise<StoredSchedule | undefined> {
  const state = await port.harness.snapshot(SchedulesDoc, ctx)
  const record = recordOf(recordsOf(state), input.id)
  return record === undefined || record.revision !== input.revision || !record.active ? undefined : record
}

export function nextOf(record: StoredSchedule): Occurrence | undefined {
  return slotsOf(record.when, record.tz, record.anchor).next(record.cursor.last, record.cursor.index)
}

export function dueOf(record: StoredSchedule, now: number): DueWindow | undefined {
  return slotsOf(record.when, record.tz, record.anchor).due(record.cursor.last, record.cursor.index, now)
}

export function slotKey(id: string, slot: number): string {
  return `sched:${id}:${new Date(slot).toISOString()}`
}

export async function sendDue(
  port: SchedulesPort,
  record: StoredSchedule,
  due: DueWindow,
  now: number,
): Promise<StoredSchedule> {
  const delivered = await deliveryOf(port, record)
  await port.intake.enqueue({
    target: delivered.target,
    commandId: slotKey(record.id, due.latest),
    kind: "job",
    threadId: record.id,
    title: record.title,
    status: "scheduled",
    text: due.count > 1 ? `${record.prompt}${MISSED}${due.count})` : record.prompt,
    clientTs: due.latest,
  })
  await port.arm()
  await notifyDue(port, record, due.latest)
  return {
    ...delivered.record,
    cursor: { last: due.latest, index: due.index + 1 },
    lastDelivery: {
      scheduledAt: iso(due.latest),
      deliveredAt: iso(now),
      targetSessionId: delivered.target,
    },
  }
}

const NOTIFY_BODY = 120

/** The run is already queued, so its push is best effort: a push failure must never fail the run. */
async function notifyDue(port: SchedulesPort, record: StoredSchedule, slot: number): Promise<void> {
  try {
    if (!(await port.notify.prefs()).schedule) return
    const notification: Notification = {
      threadTitle: record.title,
      title: "A schedule ran",
      body: clipText(record.prompt, NOTIFY_BODY),
      tag: `schedule:${record.id}:${slot}`,
      kind: "schedule",
    }
    await port.notify.notify(notification)
  } catch (failure) {
    console.warn("schedules: notification failed", failure)
  }
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd()
}

type Delivery = { readonly target: ConversationId; readonly record: StoredSchedule }

async function deliveryOf(port: SchedulesPort, record: StoredSchedule): Promise<Delivery> {
  switch (record.target.kind) {
    case "this_session":
      return { target: record.target.conversationId as ConversationId, record }
    case "new_once": {
      const reserved = record.target.conversationId
      if (reserved !== undefined) return { target: reserved as ConversationId, record }
      const created = await createConversation(port)
      return { target: created, record: { ...record, target: { kind: "new_once", conversationId: created } } }
    }
    case "new":
      return { target: await createConversation(port), record }
    default: {
      const _exhaustive: never = record.target
      return _exhaustive
    }
  }
}

function createConversation(port: SchedulesPort): Promise<ConversationId> {
  return port.harness.createConversation({ ownership: { kind: "ownerless" } }, context).then((created) => created.id)
}

async function createSchedule(
  port: SchedulesPort,
  request: ScheduleCreateRequest,
  fallback: ConversationId,
  now: number,
  defaultId: string,
): Promise<CreatedSchedule> {
  const title = titleOf(request.title)
  const prompt = promptOf(request.prompt)
  const parsed = parsedWhen(request, now)
  const id = request.id ?? defaultId
  if (!ID.test(id)) throw invalid(`schedule id "${id}" must be 1-64 letters, digits, "_" or "-"`)
  const cursor = firstCursor(parsed.when, parsed.tz, parsed.anchor, now)
  const record: StoredSchedule = {
    id,
    title,
    prompt,
    tz: parsed.tz,
    anchor: parsed.anchor,
    when: parsed.when,
    target: storedTarget(request.target, fallback),
    origin: fallback,
    active: true,
    revision: 1,
    createdAt: now,
    updatedAt: iso(now),
    cursor,
  }
  const created = await port.harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulesDoc)
    const existing = recordOf(doc.records, id)
    // A doc draft, and every container in it, expires when the commit settles: project the plain task here.
    if (existing !== undefined) return { created: false, task: taskOf(existing) }
    doc.records[id] = record
    await startTimer(tx, port, record)
    return { created: true, task: taskOf(record) }
  }, context)
  if (created.created) await port.arm()
  return { id, created: created.created, task: created.task }
}

async function editSchedule(
  port: SchedulesPort,
  request: ScheduleEditRequest,
  fallback: ConversationId,
  now: number,
): Promise<ScheduleEditResult> {
  if (request.action === "delete") {
    const deleted = await deleteSchedule(port, request.id, request.expectedUpdatedAt)
    switch (deleted) {
      case "not_found":
        return { id: request.id, code: "schedule_not_found" }
      case "conflict":
        return { id: request.id, code: "schedule_conflict" }
      case "deleted":
        return { id: request.id, deleted: true }
      default: {
        const _exhaustive: never = deleted
        return _exhaustive
      }
    }
  }
  const outcome = await port.harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulesDoc)
    const current = recordOf(doc.records, request.id)
    if (current === undefined) return { kind: "not_found" as const }
    if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== current.updatedAt)
      return { kind: "conflict" as const }
    const next = revised(current, request.patch, fallback, now)
    doc.records[next.id] = next
    const timer = live(next) ? await startTimer(tx, port, next) : undefined
    return { kind: "updated" as const, task: taskOf(next), timer }
  }, context)
  switch (outcome.kind) {
    case "not_found":
      return { id: request.id, code: "schedule_not_found" }
    case "conflict":
      return { id: request.id, code: "schedule_conflict" }
    case "updated":
      await stopTimers(port, request.id, outcome.timer)
      await port.arm()
      return outcome.task
    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

type DeleteOutcome = "deleted" | "not_found" | "conflict"

async function deleteSchedule(port: SchedulesPort, id: string, expectedUpdatedAt?: string): Promise<DeleteOutcome> {
  const outcome = await port.harness.commit(async (tx) => {
    const doc = await tx.doc(SchedulesDoc)
    const current = recordOf(doc.records, id)
    if (current === undefined) return "not_found" as const
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) return "conflict" as const
    delete doc.records[id]
    return "deleted" as const
  }, context)
  if (outcome === "deleted") {
    await stopTimers(port, id)
    await port.arm()
  }
  return outcome
}

async function cancelSchedule(port: SchedulesPort, id: string): Promise<boolean> {
  return (await deleteSchedule(port, id)) === "deleted"
}

async function viewSchedule(port: SchedulesPort, id: string): Promise<ScheduleViewResult> {
  const state = await port.harness.snapshot(SchedulesDoc, context)
  const record = recordOf(recordsOf(state), id)
  return record === undefined ? { id, code: "schedule_not_found" } : taskOf(record)
}

async function listSchedules(port: SchedulesPort, request: ScheduleListRequest): Promise<ScheduleListPage> {
  const limit = request.limit ?? DEFAULT_LIST_LIMIT
  const offset = request.offset ?? 0
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw invalid(`limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer`)
  const state = await port.harness.snapshot(SchedulesDoc, context)
  const stored = recordsOf(state)
  const records: readonly StoredSchedule[] = Object.keys(stored).flatMap((id) => {
    const record = recordOf(stored, id)
    return record === undefined ? [] : [record]
  })
  const matching = records.filter((record) => matches(record, request.active)).toSorted(compare)
  const items = matching.slice(offset, offset + limit).map(taskOf)
  return { items, shown: items.length, total: matching.length, limit, offset }
}

function matches(record: StoredSchedule, active: boolean | undefined): boolean {
  return active === undefined ? true : active === live(record)
}

function live(record: StoredSchedule): boolean {
  return record.active && nextOf(record) !== undefined
}

function compare(left: StoredSchedule, right: StoredSchedule): number {
  const leftLive = live(left) ? 0 : 1
  const rightLive = live(right) ? 0 : 1
  if (leftLive !== rightLive) return leftLive - rightLive
  if (leftLive === 0) {
    const first = nextOf(left)?.slot ?? 0
    const second = nextOf(right)?.slot ?? 0
    return first - second || left.id.localeCompare(right.id)
  }
  return recent(right).localeCompare(recent(left)) || left.id.localeCompare(right.id)
}

function recent(record: StoredSchedule): string {
  return record.lastDelivery?.deliveredAt ?? record.updatedAt
}

function taskOf(record: StoredSchedule): ScheduleTask {
  const next = nextOf(record)
  return {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    ...(record.when.kind === "rrule" ? { rrule: record.when.rrule } : { at: iso(record.when.at) }),
    target: record.target.kind,
    active: record.active,
    nextAt: next === undefined ? null : iso(next.slot),
    updatedAt: record.updatedAt,
    ...(record.lastDelivery === undefined ? {} : { lastDelivery: record.lastDelivery }),
  }
}

async function startTimer(tx: Tx, port: SchedulesPort, record: StoredSchedule): Promise<TaskId<null>> {
  return tx.createTask(
    scheduleTask(port),
    { id: record.id, revision: record.revision },
    {
      ownership: { kind: "conversation" },
      conversationId: record.origin as ConversationId,
      background: true,
    },
  )
}

async function stopTimers(port: SchedulesPort, id: string, keep?: TaskId): Promise<void> {
  const inspection = await port.harness.inspect(context)
  for (const task of inspection.tasks) {
    if (task.record.kind !== SCHEDULE_TASK) continue
    if (keep !== undefined && task.record.id === keep) continue
    if (timerInputOf(task.record.input)?.id !== id) continue
    await port.harness.abortTask(task.record.id, context)
  }
}

function timerInputOf(value: unknown): TimerInput | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const id: unknown = Reflect.get(value, "id")
  const revision: unknown = Reflect.get(value, "revision")
  return typeof id === "string" && typeof revision === "number" ? { id, revision } : undefined
}

function revised(current: StoredSchedule, patch: SchedulePatch, fallback: ConversationId, now: number): StoredSchedule {
  const title = patch.title === undefined ? current.title : titleOf(patch.title)
  const prompt = patch.prompt === undefined ? current.prompt : promptOf(patch.prompt)
  const target = patch.target === undefined ? current.target : storedTarget(patch.target, fallback)
  let next = current
  if (patch.rrule !== undefined) {
    const parsed = guarded(() => parseRuleText(patch.rrule ?? "", current.tz, now))
    next = {
      ...current,
      when: parsed.when,
      tz: parsed.tz,
      anchor: parsed.anchor,
      cursor: firstCursor(parsed.when, parsed.tz, parsed.anchor, now),
    }
  }
  if (patch.active === true) {
    const advanced = advance(next, now)
    if (advanced === undefined)
      throw invalid("This task has no future occurrence. Set a new rrule before resuming it.", "not_future")
    next = { ...next, cursor: advanced }
  }
  return {
    ...next,
    title,
    prompt,
    target,
    active: patch.active ?? current.active,
    revision: current.revision + 1,
    updatedAt: revisedAt(current.updatedAt, now),
  }
}

function revisedAt(current: string, now: number): string {
  return iso(Math.max(now, Date.parse(current) + 1))
}

function advance(record: StoredSchedule, now: number): Position | undefined {
  const slots = slotsOf(record.when, record.tz, record.anchor)
  const missed = slots.due(record.cursor.last, record.cursor.index, now)
  const cursor = missed === undefined ? record.cursor : { last: missed.latest, index: missed.index + 1 }
  return slots.next(cursor.last, cursor.index) === undefined ? undefined : cursor
}

function firstCursor(when: When, tz: string, anchor: number, now: number): Position {
  const slots = slotsOf(when, tz, anchor)
  const missed = slots.due(anchor - 1, 0, now)
  const cursor =
    missed === undefined ? { last: anchor - 1, index: 0 } : { last: missed.latest, index: missed.index + 1 }
  if (slots.next(cursor.last, cursor.index) === undefined)
    throw invalid("the rule has no future occurrence", "not_future")
  return cursor
}

function storedTarget(choice: ScheduleTargetChoice | undefined, fallback: ConversationId): StoredTarget {
  const chosen: ScheduleTargetChoice = choice ?? "this_session"
  switch (chosen) {
    case "this_session":
      return { kind: "this_session", conversationId: fallback }
    case "new_once":
      return { kind: "new_once" }
    case "new":
      return { kind: "new" }
    default: {
      const _exhaustive: never = chosen
      return _exhaustive
    }
  }
}

function parsedWhen(request: ScheduleCreateRequest, now: number): ParsedWhen {
  const { at, rrule } = request
  if (at !== undefined && rrule !== undefined) throw invalid("give rrule or at, not both")
  if (at !== undefined) return guarded(() => ({ when: { kind: "at", at }, tz: zoneOf(request.tz), anchor: at }))
  if (rrule !== undefined) return guarded(() => parseRuleText(rrule, request.tz, now))
  throw invalid("give exactly one of rrule or at")
}

function guarded<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof RuleError) throw invalid(error.message)
    throw error
  }
}

function titleOf(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw invalid("title must be non-empty after trimming", "invalid_prompt")
  if (title.length > MAX_TITLE) throw invalid(`title must be at most ${MAX_TITLE} characters`, "invalid_prompt")
  return title
}

function promptOf(value: string): string {
  const prompt = value.trim()
  if (prompt.length === 0) throw invalid("prompt must be non-empty after trimming", "invalid_prompt")
  if (prompt.length > MAX_PROMPT) throw invalid(`prompt must be at most ${MAX_PROMPT} characters`, "invalid_prompt")
  return prompt
}

function invalid(message: string, code: ScheduleInputError["code"] = "invalid_rule"): ScheduleInputError {
  return new ScheduleInputError(code, message)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

const CREATE_ARGS = obj({
  id: opt(str({ pattern: ID_SOURCE })),
  title: str({ minLength: 1, maxLength: MAX_TITLE }),
  prompt: str({ minLength: 1, maxLength: MAX_PROMPT }),
  rrule: opt(str({ minLength: 1, maxLength: MAX_RULE })),
  at: opt(int({ minimum: 0 })),
  tz: opt(str({ minLength: 1, maxLength: 64 })),
  target: opt(TargetSchema),
})

const LIST_ARGS = obj({
  active: opt(bool()),
  limit: opt(int({ minimum: 1, maximum: MAX_LIST_LIMIT })),
  offset: opt(int({ minimum: 0 })),
})

const VIEW_ARGS = obj({ id: str({ pattern: ID_SOURCE }) })

type RootConversation = (api: OpApi) => Promise<ConversationId>

function rootConversation(): RootConversation {
  let pending: Promise<ConversationId> | undefined
  return (api) => {
    if (api.actor.kind === "agent") return Promise.resolve(api.actor.conversationId)
    pending ??= api.harness.root(context).then(
      (conversation) => conversation.id,
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    return pending
  }
}

function createOp(service: SchedulesService, root: RootConversation): Op {
  return defineOp({
    name: "schedule.create",
    args: CREATE_ARGS,
    actors: ["owner", "agent"],
    run: async (api, args) =>
      guardOp(async () => service.create(args, await root(api), Date.now(), args.id ?? stableId(api.commandId))),
  })
}

function cancelOp(service: SchedulesService): Op {
  return defineOp({
    name: "schedule.cancel",
    args: VIEW_ARGS,
    actors: ["owner", "agent"],
    run: async (_api, args) => guardOp(async () => ({ id: args.id, cancelled: await service.cancel(args.id) })),
  })
}

function listOp(service: SchedulesService): Op {
  return defineOp({
    name: "schedule.list",
    args: LIST_ARGS,
    actors: ["owner", "agent"],
    run: async (_api, args) => guardOp(async () => ({ schedules: (await service.list(args)).items })),
  })
}

function viewOp(service: SchedulesService): Op {
  return defineOp({
    name: "schedule.view",
    args: VIEW_ARGS,
    actors: ["owner", "agent"],
    run: async (_api, args) => guardOp(() => service.view(args.id)),
  })
}

function editOp(service: SchedulesService, root: RootConversation): Op {
  return defineOp({
    name: "schedule.edit",
    args: ScheduleEditArgsSchema,
    actors: ["owner", "agent"],
    run: async (api, args) => guardOp(async () => service.edit(editRequest(args), await root(api), Date.now())),
  })
}

async function guardOp<T extends JsonValue>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new OpRejected("bad_args", error.message)
    throw error
  }
}

function stableId(source: string): string {
  const cleaned = source.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)
  return cleaned === "" ? crypto.randomUUID() : cleaned
}
