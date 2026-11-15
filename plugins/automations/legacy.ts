import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable"
import { bool, compile, int, lit, map, obj, opt, type Static, str, union } from "@earendil-works/pi-schema"
import { scopeOf } from "../../src/contracts/scope.ts"
import type { CreateInput, Engine, TriggerInput } from "./automations.ts"
import { nextCron, parseCron } from "./cron.ts"

const context = BACKGROUND_CONTEXT

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
const MAPPED_PARTS: ReadonlySet<string> = new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"])

const LegacyRecordSchema = obj(
  {
    id: str({ minLength: 1, maxLength: 64 }),
    title: str({ minLength: 1 }),
    prompt: str({ minLength: 1 }),
    tz: str({ minLength: 1 }),
    anchor: int(),
    when: union([
      obj({ kind: lit("at"), at: int({ minimum: 0 }) }),
      obj({ kind: lit("rrule"), rrule: str({ minLength: 1 }) }),
    ]),
    target: union([
      obj({ kind: lit("this_session"), conversationId: int({ minimum: 0 }) }),
      obj({ kind: lit("new_once"), conversationId: opt(int({ minimum: 0 })) }),
      obj({ kind: lit("new") }),
    ]),
    origin: int({ minimum: 0 }),
    active: bool(),
    cursor: obj({ last: int(), index: int({ minimum: 0 }) }),
  },
  { open: true },
)

const LegacyStateSchema = obj({ records: map(LegacyRecordSchema) })

type LegacyRecord = Static<typeof LegacyRecordSchema>
type LegacyState = Static<typeof LegacyStateSchema>

const LEGACY_STATE = compile(LegacyStateSchema)

export const LegacySchedulesDoc = defineDoc<LegacyState>({
  kind: "xin.schedules",
  version: 1,
  scope: "session",
  initial: () => ({ records: {} }),
  checkpointWhen: () => false,
})

/**
 * Converts the `xin.schedules` records the schedules plugin left into automations `sched-<id>`, queues one run for a
 * slot that was due and not yet delivered, then retires the document. Every step is keyed by the record id, so a boot
 * that crashed halfway repeats the import without duplicates.
 */
export async function importSchedules(engine: Engine, harness: Harness, now: number): Promise<void> {
  const state = await harness.snapshot(LegacySchedulesDoc, context)
  if (state === undefined) return
  if (!LEGACY_STATE.check(state)) {
    const reason = LEGACY_STATE.errors(state)
      .map((error) => `${error.path} ${error.message}`)
      .join("; ")
    throw new Error(`xin.schedules is not a valid stored document: ${reason}`)
  }
  for (const record of Object.values(state.records)) await importRecord(engine, harness, record, now)
  await harness.commit((tx) => tx.retireDoc(LegacySchedulesDoc), context)
}

async function importRecord(engine: Engine, harness: Harness, record: LegacyRecord, now: number): Promise<void> {
  const id = `sched-${record.id}`
  const cron = record.when.kind === "rrule" ? cronOf(record.when.rrule, record.tz, record.anchor, now) : undefined
  const due = record.active ? dueSlot(record, cron, now) : undefined
  if (due !== undefined)
    await engine.store.addRun({
      id: `legacy:${record.id}:${due}`,
      automation_id: id,
      trigger_id: null,
      source: "schedule",
      input: null,
      inputs: 0,
      created_at: now,
    })
  const triggers: TriggerInput[] =
    record.when.kind === "at"
      ? record.when.at > now
        ? [{ kind: "once", at: new Date(record.when.at).toISOString() }]
        : []
      : cron === undefined
        ? []
        : [{ kind: "schedule", cron, tz: record.tz }]
  const mapped = record.when.kind === "at" || cron !== undefined
  await engine.create(
    {
      title: record.title,
      prompt:
        record.when.kind === "at" || cron !== undefined
          ? record.prompt
          : `${record.prompt}\n\nImported from a schedule whose rule has no cron equivalent, so it stays off until it gets a trigger. Original rule: RRULE:${record.when.rrule} in ${record.tz}, starting ${new Date(record.anchor).toISOString()}.`,
      ...(await placementOf(harness, record)),
      triggers,
      enabled: record.active && mapped,
    },
    {},
    now,
    id,
  )
}

function dueSlot(record: LegacyRecord, cron: string | undefined, now: number): number | undefined {
  if (record.when.kind === "at") {
    const at = record.when.at
    return record.cursor.last < at && at <= now ? at : undefined
  }
  if (cron === undefined) return undefined
  const next = nextCron(parseCron(cron), record.tz, Math.max(record.cursor.last, record.anchor - 1))
  return next !== undefined && next <= now ? next : undefined
}

async function placementOf(harness: Harness, record: LegacyRecord): Promise<Pick<CreateInput, "target" | "project">> {
  const scope = await scopeOf(harness, record.origin as ConversationId)
  const project = scope === undefined || scope.kind === "puck" ? undefined : scope.projectId
  const reserved = record.target.kind === "new" ? undefined : record.target.conversationId
  if (reserved !== undefined && (await exists(harness, reserved)))
    return { target: { kind: "same", threadId: reserved }, project }
  if (project !== undefined)
    return { target: record.target.kind === "new" ? { kind: "fresh" } : { kind: "same" }, project }
  const threadId = (await exists(harness, record.origin)) ? record.origin : (await harness.root(context)).id
  return { target: { kind: "same", threadId }, project }
}

async function exists(harness: Harness, conversationId: number): Promise<boolean> {
  return (await harness.conversation(conversationId as ConversationId, context)) !== undefined
}

function cronOf(rrule: string, tz: string, anchor: number, now: number): string | undefined {
  if (anchor > now) return undefined
  const parts = new Map<string, string>()
  for (const entry of rrule.replace(/^RRULE:/i, "").split(";")) {
    if (entry === "") continue
    const equals = entry.indexOf("=")
    parts.set(entry.slice(0, equals).toUpperCase(), entry.slice(equals + 1))
  }
  if ([...parts.keys()].some((key) => !MAPPED_PARTS.has(key))) return undefined
  if ((parts.get("INTERVAL") ?? "1") !== "1") return undefined
  const freq = parts.get("FREQ")
  if (freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY") return undefined
  const start = localOf(anchor, tz)
  const minute = parts.get("BYMINUTE") ?? String(start.minute)
  const hour = freq === "HOURLY" ? "*" : (parts.get("BYHOUR") ?? String(start.hour))
  const byday = parts.get("BYDAY")
  const days = byday === undefined ? (freq === "WEEKLY" ? [start.weekday] : undefined) : byday.split(",")
  const numbers = days?.map((day) => WEEKDAYS.findIndex((code) => code === day.trim()))
  if (numbers?.includes(-1) === true) return undefined
  const cron = `${minute} ${hour} * * ${numbers === undefined ? "*" : numbers.join(",")}`
  try {
    parseCron(cron)
    return cron
  } catch {
    return undefined
  }
}

function localOf(ms: number, tz: string): { readonly hour: number; readonly minute: number; readonly weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? ""
  return {
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: part("weekday").slice(0, 2).toUpperCase(),
  }
}
