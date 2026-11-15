import { CronError, nextCron, parseCron } from "../../../plugins/automations/cron.ts"
import { isRecord, listOf, numOf, recordOf, stringsOf, strOf } from "./parse.ts"
import type { SignalState } from "./status.ts"

export type AutomationTrigger =
  | { readonly id: string; readonly kind: "schedule"; readonly cron: string; readonly tz: string; readonly nextAt: string | null }
  | { readonly id: string; readonly kind: "once"; readonly at: string; readonly nextAt: string | null }
  | {
      readonly id: string
      readonly kind: "webhook"
      readonly path: string
      readonly contains: readonly string[]
      readonly regex: string | null
      readonly rules: readonly WebhookRule[]
    }

/** A batching rule, kept as the server sent it: the editor carries rules through untouched. */
export type WebhookRule = Readonly<Record<string, unknown>>

export type RunStatus = "queued" | "running" | "delivered" | "completed" | "failed" | "cancelled"

export type RunSource = "schedule" | "webhook" | "manual"

export type AutomationRun = {
  readonly id: string
  readonly status: RunStatus
  readonly source: RunSource
  readonly threadId: number | null
  readonly inputs: number
  readonly input: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly cost: number | null
}

export type Batch = {
  readonly triggerId: string
  readonly group: string
  readonly count: number
  readonly firstAt: string
  readonly closeAt: string
}

export type AutomationDetail = {
  readonly automation: Automation
  readonly runs: readonly AutomationRun[]
  readonly batches: readonly Batch[]
}

export type Automation = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly project: string | null
  readonly target: "fresh" | "same"
  readonly threadId: number | null
  readonly enabled: boolean
  readonly updatedAt: string
  readonly nextAt: string | null
  readonly triggers: readonly AutomationTrigger[]
  readonly lastRun: AutomationRun | null
}

const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "delivered", "completed", "failed", "cancelled"]

const isRunStatus = (value: unknown): value is RunStatus => RUN_STATUSES.some((status) => status === value)

const nullableStr = (value: unknown): string | null => strOf(value) ?? null

function triggerOf(value: unknown): AutomationTrigger | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  if (record === undefined || id === undefined) return undefined
  const nextAt = nullableStr(record.nextAt)
  switch (record.kind) {
    case "schedule": {
      const cron = strOf(record.cron)
      return cron === undefined ? undefined : { id, kind: "schedule", cron, tz: strOf(record.tz) ?? "UTC", nextAt }
    }
    case "once": {
      const at = strOf(record.at)
      return at === undefined ? undefined : { id, kind: "once", at, nextAt }
    }
    case "webhook": {
      const path = strOf(record.path)
      if (path === undefined) return undefined
      const rules = listOf(record.rules).flatMap((rule) => {
        const read = recordOf(rule)
        return read === undefined ? [] : [read]
      })
      return { id, kind: "webhook", path, contains: stringsOf(record.contains), regex: nullableStr(record.regex), rules }
    }
    default:
      return undefined
  }
}

const sourceOf = (value: unknown): RunSource => (value === "schedule" || value === "webhook" ? value : "manual")

export function parseRun(value: unknown): AutomationRun | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  const createdAt = strOf(record?.createdAt)
  if (record === undefined || id === undefined || createdAt === undefined || !isRunStatus(record.status)) return undefined
  return {
    id,
    status: record.status,
    source: sourceOf(record.source),
    threadId: numOf(record.threadId) ?? null,
    inputs: numOf(record.inputs) ?? 0,
    input: nullableStr(record.input),
    error: nullableStr(record.error),
    createdAt,
    startedAt: nullableStr(record.startedAt),
    finishedAt: nullableStr(record.finishedAt),
    cost: numOf(record.cost) ?? null,
  }
}

export function parseRuns(value: unknown): readonly AutomationRun[] {
  return listOf(recordOf(value)?.runs).flatMap((entry) => {
    const run = parseRun(entry)
    return run === undefined ? [] : [run]
  })
}

function batchOf(value: unknown): Batch | undefined {
  const record = recordOf(value)
  const triggerId = strOf(record?.triggerId)
  const count = numOf(record?.count)
  const firstAt = strOf(record?.firstAt)
  const closeAt = strOf(record?.closeAt)
  if (triggerId === undefined || count === undefined || firstAt === undefined || closeAt === undefined) return undefined
  return { triggerId, group: strOf(record?.group) ?? "", count, firstAt, closeAt }
}

/** `automation.get`: the automation with its newest runs and its open webhook batches. */
export function parseAutomationDetail(value: unknown): AutomationDetail | undefined {
  const automation = parseAutomation(value)
  if (automation === undefined) return undefined
  const batches = listOf(recordOf(value)?.batches).flatMap((entry) => {
    const batch = batchOf(entry)
    return batch === undefined ? [] : [batch]
  })
  return { automation, runs: parseRuns(value), batches }
}

/** The newest page after a reload, then every older page already loaded, once each, newest first. */
export function mergeRuns(head: readonly AutomationRun[], older: readonly AutomationRun[]): readonly AutomationRun[] {
  const seen = new Set(head.map((run) => run.id))
  return [...head, ...older.filter((run) => !seen.has(run.id))]
}

export function parseAutomation(value: unknown): Automation | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  const title = strOf(record?.title)
  if (record === undefined || id === undefined || title === undefined) return undefined
  return {
    id,
    title,
    prompt: strOf(record.prompt) ?? "",
    project: nullableStr(record.project),
    target: record.target === "same" ? "same" : "fresh",
    threadId: numOf(record.threadId) ?? null,
    enabled: record.enabled !== false,
    updatedAt: strOf(record.updatedAt) ?? "",
    nextAt: nullableStr(record.nextAt),
    triggers: listOf(record.triggers).flatMap((entry) => {
      const trigger = triggerOf(entry)
      return trigger === undefined ? [] : [trigger]
    }),
    lastRun: parseRun(record.lastRun) ?? null,
  }
}

export function parseAutomationList(value: unknown): readonly Automation[] {
  return listOf(isRecord(value) ? value.automations : undefined).flatMap((entry) => {
    const automation = parseAutomation(entry)
    return automation === undefined ? [] : [automation]
  })
}

/** The home snapshot's `automations.revision`; it bumps on every create, update, delete, run start and run finish. */
export function automationsRevisionOf(home: unknown): number | undefined {
  return numOf(recordOf(recordOf(home)?.automations)?.revision)
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

const pad = (value: number): string => String(value).padStart(2, "0")

const whole = (field: string): number | undefined => (/^\d+$/u.test(field) ? Number(field) : undefined)

function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`
}

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`
}

function daysWords(field: string): string | undefined {
  if (field === "*") return "Every day"
  if (field === "1-5" || field === "mon-fri" || field === "MON-FRI") return "Weekdays"
  const days = field.split(",").map(whole)
  if (days.some((day) => day === undefined || day > 7)) return undefined
  const names = [...new Set(days.map((day) => (day ?? 0) % 7))].sort((a, b) => a - b)
  if (names.length === 2 && names[0] === 0 && names[1] === 6) return "Weekends"
  return listWords(names.map((day) => `${DAY_NAMES[day] ?? ""}s`))
}

/** A 5-field cron in plain words, or the cron itself when it is too unusual to say briefly. */
export function cronInWords(cron: string): string {
  const fields = cron.trim().split(/\s+/u)
  const [minute, hour, dom, month, dow] = fields
  if (fields.length !== 5 || minute === undefined || hour === undefined || dom === undefined || month === undefined || dow === undefined) {
    return cron
  }
  const step = (field: string, span: number): number | undefined => {
    const value = field.startsWith("*/") ? whole(field.slice(2)) : undefined
    return value !== undefined && value > 0 && span % value === 0 ? value : undefined
  }
  const everyDay = dom === "*" && month === "*"
  if (everyDay && dow === "*" && hour === "*") {
    if (minute === "*") return "Every minute"
    const minutes = step(minute, 60)
    if (minutes !== undefined) return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`
  }
  const atMinute = whole(minute)
  if (atMinute === undefined || atMinute > 59) return cron
  if (everyDay && dow === "*") {
    if (hour === "*") return `Every hour at :${pad(atMinute)}`
    const hours = step(hour, 24)
    if (hours !== undefined) return `Every ${hours} hours at :${pad(atMinute)}`
  }
  const hours = hour.split(",").map(whole)
  if (hours.some((value) => value === undefined || value > 23)) return cron
  const times = listWords(hours.map((value) => `${pad(value ?? 0)}:${pad(atMinute)}`))
  if (everyDay) {
    const days = daysWords(dow)
    return days === undefined ? cron : `${days} at ${times}`
  }
  const day = whole(dom)
  if (day !== undefined && day >= 1 && day <= 31 && month === "*" && dow === "*") return `Monthly on the ${ordinal(day)} at ${times}`
  return cron
}

/**
 * Why the server would refuse this cron, in its own words: the dialog runs the backend's parser, so it blocks
 * exactly what `automation.create` would answer `bad_args` for. Undefined when the cron is fine.
 */
export function cronProblem(cron: string, tz: string, now = Date.now()): string | undefined {
  try {
    return nextCron(parseCron(cron), tz, now) === undefined ? `"${cron.trim()}" never fires` : undefined
  } catch (problem) {
    if (problem instanceof CronError) return problem.message
    throw problem
  }
}

export function triggerSummary(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return `${cronInWords(trigger.cron)} · ${trigger.tz}`
    case "once": {
      const at = Date.parse(trigger.at)
      return Number.isNaN(at) ? `Once at ${trigger.at}` : `Once on ${new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    }
    case "webhook":
      return "On webhook"
    default: {
      const _exhaustive: never = trigger
      return _exhaustive
    }
  }
}

export function describeTriggers(automation: Pick<Automation, "triggers">): string {
  return automation.triggers.length === 0 ? "Run now only" : automation.triggers.map(triggerSummary).join(", ")
}

export const TARGET_WORD: Readonly<Record<Automation["target"], string>> = {
  fresh: "New thread each run",
  same: "One standing thread",
}

/** Run status on the Signal: delivered is terminal like completed, and cancelled has no shape of its own so it reads as idle. */
export function runSignal(status: RunStatus): SignalState {
  switch (status) {
    case "queued":
      return "queued"
    case "running":
      return "working"
    case "delivered":
    case "completed":
      return "done"
    case "failed":
      return "failed"
    case "cancelled":
      return "idle"
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** When the automation fires next, in words: paused, on a webhook, minutes away, a weekday and time this week, or a date. */
export function nextLabel(
  automation: Pick<Automation, "enabled" | "nextAt" | "triggers">,
  now = Date.now(),
  timeZone?: string,
): string {
  if (!automation.enabled) return "Paused"
  const at = automation.nextAt === null ? Number.NaN : Date.parse(automation.nextAt)
  if (Number.isNaN(at)) return automation.triggers.some((trigger) => trigger.kind === "webhook") ? "On webhook" : "Not scheduled"
  const away = at - now
  if (away < MINUTE) return "Now"
  if (away < HOUR) return `In ${Math.round(away / MINUTE)}m`
  const zone = timeZone === undefined ? {} : { timeZone }
  if (away < 6 * DAY) {
    return new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...zone })
  }
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone })
}

export const RUN_SOURCE_WORD: Readonly<Record<RunSource, string>> = {
  schedule: "Schedule",
  webhook: "Webhook",
  manual: "Run now",
}

/** How long a run took, once it has both ends. */
export function runDuration(run: Pick<AutomationRun, "startedAt" | "finishedAt">): string | undefined {
  if (run.startedAt === null || run.finishedAt === null) return undefined
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  if (Number.isNaN(ms) || ms < 0) return undefined
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function webhookUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/u, "")}${path}`
}

export type TriggerDraft =
  | { readonly key: string; readonly kind: "schedule"; readonly cron: string; readonly tz: string }
  | { readonly key: string; readonly kind: "once"; readonly at: string }
  | {
      readonly key: string
      readonly kind: "webhook"
      readonly id: string | undefined
      readonly path: string | undefined
      readonly contains: string
      readonly regex: string
      readonly rules: readonly WebhookRule[]
    }

export type AutomationDraft = {
  readonly title: string
  readonly prompt: string
  readonly project: string
  readonly target: Automation["target"]
  readonly triggers: readonly TriggerDraft[]
}

/** An ISO instant as a datetime-local value in the browser's zone. */
export function localInput(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function triggerDraft(trigger: AutomationTrigger): TriggerDraft {
  switch (trigger.kind) {
    case "schedule":
      return { key: trigger.id, kind: "schedule", cron: trigger.cron, tz: trigger.tz }
    case "once":
      return { key: trigger.id, kind: "once", at: localInput(trigger.at) }
    case "webhook":
      return {
        key: trigger.id,
        kind: "webhook",
        id: trigger.id,
        path: trigger.path,
        contains: trigger.contains.join(", "),
        regex: trigger.regex ?? "",
        rules: trigger.rules,
      }
    default: {
      const _exhaustive: never = trigger
      return _exhaustive
    }
  }
}

export function draftOf(automation: Automation): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    project: automation.project ?? "",
    target: automation.target,
    triggers: automation.triggers.map(triggerDraft),
  }
}

export function newTrigger(kind: TriggerDraft["kind"], key: string, tz: string): TriggerDraft {
  switch (kind) {
    case "schedule":
      return { key, kind, cron: "", tz }
    case "once":
      return { key, kind, at: "" }
    case "webhook":
      return { key, kind, id: undefined, path: undefined, contains: "", regex: "", rules: [] }
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** Rotating a secret is replacing the trigger without its id: the server mints a new URL, and the old one answers 404. */
export function rotated(trigger: TriggerDraft): TriggerDraft {
  return trigger.kind === "webhook" ? { ...trigger, id: undefined, path: undefined } : trigger
}

function triggerReady(trigger: TriggerDraft): boolean {
  switch (trigger.kind) {
    case "schedule":
      return cronProblem(trigger.cron, trigger.tz) === undefined
    case "once":
      return !Number.isNaN(Date.parse(trigger.at))
    case "webhook":
      return true
    default: {
      const _exhaustive: never = trigger
      return _exhaustive
    }
  }
}

export function draftReady(draft: AutomationDraft): boolean {
  return draft.title.trim() !== "" && draft.prompt.trim() !== "" && draft.project !== "" && draft.triggers.every(triggerReady)
}

function triggerArg(trigger: TriggerDraft): Record<string, unknown> {
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", cron: trigger.cron.trim().replace(/\s+/gu, " "), tz: trigger.tz }
    case "once":
      return { kind: "once", at: new Date(trigger.at).toISOString() }
    case "webhook": {
      const contains = trigger.contains
        .split(",")
        .map((word) => word.trim())
        .filter((word) => word !== "")
      const regex = trigger.regex.trim()
      return {
        kind: "webhook",
        ...(trigger.id === undefined ? {} : { id: trigger.id }),
        ...(contains.length === 0 ? {} : { contains }),
        ...(regex === "" ? {} : { regex }),
        ...(trigger.rules.length === 0 ? {} : { rules: trigger.rules }),
      }
    }
    default: {
      const _exhaustive: never = trigger
      return _exhaustive
    }
  }
}

/** `automation.create` args from the dialog. */
export function createArgs(draft: AutomationDraft): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    project: draft.project,
    target: { kind: draft.target },
    triggers: draft.triggers.map(triggerArg),
  }
}

/**
 * `automation.update` args holding only what changed. Triggers go as a whole set and only when the set changed,
 * so saving a title never re-mints schedules or touches a webhook's URL. A standing thread keeps its thread.
 */
export function updateArgs(automation: Automation, draft: AutomationDraft): Record<string, unknown> {
  const before = createArgs(draftOf(automation))
  const after = createArgs(draft)
  const changed = (key: string): boolean => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  const target =
    draft.target === "same" && automation.target === "same" && automation.threadId !== null
      ? { kind: "same", threadId: automation.threadId }
      : after.target
  return {
    id: automation.id,
    ...(changed("title") ? { title: after.title } : {}),
    ...(changed("prompt") ? { prompt: after.prompt } : {}),
    ...(changed("project") ? { project: after.project } : {}),
    ...(changed("target") ? { target } : {}),
    ...(changed("triggers") ? { triggers: after.triggers } : {}),
  }
}

/** `automation.trigger` args: the optional input is appended to the prompt for this one run. */
export function runNowArgs(id: string, input: string): Record<string, unknown> {
  const text = input.trim()
  return text === "" ? { id } : { id, input: text }
}

/** Time left until a batch closes: "in 40s", "in 12m", "in 3h", or "closing" once it is due. */
export function untilLabel(iso: string, now = Date.now()): string {
  const away = Date.parse(iso) - now
  if (Number.isNaN(away) || away <= 0) return "closing"
  if (away < MINUTE) return `in ${Math.ceil(away / 1000)}s`
  if (away < HOUR) return `in ${Math.round(away / MINUTE)}m`
  return `in ${Math.round(away / HOUR)}h`
}

/** A batch's group is the JSON tuple of its groupBy values; it reads as those values joined. */
export function batchGroupLabel(group: string): string {
  if (group === "") return ""
  try {
    const values: unknown = JSON.parse(group)
    if (Array.isArray(values)) return values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" · ")
  } catch {
    return group
  }
  return group
}
