import { isRecord, listOf, numOf, recordOf, strOf } from "./parse.ts"
import type { SignalState } from "./status.ts"

export type AutomationTrigger =
  | { readonly id: string; readonly kind: "schedule"; readonly cron: string; readonly tz: string; readonly nextAt: string | null }
  | { readonly id: string; readonly kind: "once"; readonly at: string; readonly nextAt: string | null }
  | { readonly id: string; readonly kind: "webhook"; readonly path: string }

export type RunStatus = "queued" | "running" | "delivered" | "completed" | "failed" | "cancelled"

export type AutomationRun = {
  readonly id: string
  readonly status: RunStatus
  readonly threadId: number | null
  readonly createdAt: string
  readonly error: string | null
}

export type Automation = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly project: string | null
  readonly target: "fresh" | "same"
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
      return path === undefined ? undefined : { id, kind: "webhook", path }
    }
    default:
      return undefined
  }
}

export function parseRun(value: unknown): AutomationRun | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  const createdAt = strOf(record?.createdAt)
  if (record === undefined || id === undefined || createdAt === undefined || !isRunStatus(record.status)) return undefined
  return { id, status: record.status, threadId: numOf(record.threadId) ?? null, createdAt, error: nullableStr(record.error) }
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
  const step = (field: string): number | undefined => (field.startsWith("*/") ? whole(field.slice(2)) : undefined)
  const everyDay = dom === "*" && month === "*"
  if (everyDay && dow === "*" && hour === "*") {
    if (minute === "*") return "Every minute"
    const minutes = step(minute)
    if (minutes !== undefined) return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`
  }
  const atMinute = whole(minute)
  if (atMinute === undefined || atMinute > 59) return cron
  if (everyDay && dow === "*") {
    if (hour === "*") return `Every hour at :${pad(atMinute)}`
    const hours = step(hour)
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

export type AutomationDraft = {
  readonly title: string
  readonly prompt: string
  readonly cron: string
  readonly project: string
  readonly target: Automation["target"]
}

export function draftReady(draft: AutomationDraft): boolean {
  return draft.title.trim() !== "" && draft.prompt.trim() !== "" && draft.cron.trim() !== "" && draft.project !== ""
}

/** `automation.create` args from the dialog; the cron reads in the browser's zone. */
export function createArgs(draft: AutomationDraft, tz: string): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    project: draft.project,
    target: { kind: draft.target },
    triggers: [{ kind: "schedule", cron: draft.cron.trim().replace(/\s+/gu, " "), tz }],
  }
}
