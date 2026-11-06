export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

export type Frequency = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY"

export type Rule = {
  readonly freq: Frequency
  readonly interval: number
  readonly byday: readonly Weekday[]
  readonly byhour: readonly number[]
  readonly byminute: readonly number[]
  readonly count?: number
  readonly until?: number
}

export type When = { readonly kind: "at"; readonly at: number } | { readonly kind: "rrule"; readonly rrule: string }

export type Occurrence = {
  readonly slot: number
  readonly index: number
}

export type DueWindow = {
  readonly count: number
  readonly latest: number
  readonly index: number
}

export type Slots = {
  next(after: number, index: number): Occurrence | undefined
  due(after: number, index: number, now: number): DueWindow | undefined
}

export class RuleError extends Error {}

const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
const MONDAY_FIRST: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const KNOWN_PARTS: ReadonlySet<string> = new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL"])
const MAX_PERIODS = 500_000
const DAY = 86_400_000
const HOUR = 3_600_000

type CivilDate = {
  readonly year: number
  readonly month: number
  readonly day: number
}

type CivilTime = CivilDate & {
  readonly hour: number
  readonly minute: number
}

type Plan = {
  readonly freq: Frequency
  readonly interval: number
  readonly hours: readonly number[]
  readonly minutes: readonly number[]
  readonly days?: readonly Weekday[]
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached !== undefined) return cached
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  formatters.set(tz, made)
  return made
}

export function validateZone(tz: string): void {
  try {
    formatter(tz)
  } catch {
    throw new RuleError(`unknown time zone "${tz}"`)
  }
}

function localParts(ms: number, tz: string): CivilTime & { readonly second: number } {
  const parts: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
  } = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  for (const part of formatter(tz).formatToParts(ms)) {
    switch (part.type) {
      case "year":
        parts.year = Number(part.value)
        break
      case "month":
        parts.month = Number(part.value)
        break
      case "day":
        parts.day = Number(part.value)
        break
      case "hour":
        parts.hour = Number(part.value)
        break
      case "minute":
        parts.minute = Number(part.value)
        break
      case "second":
        parts.second = Number(part.value)
        break
      default:
        break
    }
  }
  return parts
}

function tzOffset(ms: number, tz: string): number {
  const parts = localParts(ms, tz)
  const base = Math.floor(ms / 1000) * 1000
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - base
}

function zonedTime(time: CivilTime, tz: string): number {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, 0)
  const first = guess - tzOffset(guess, tz)
  const second = guess - tzOffset(first, tz)
  const check = localParts(second, tz)
  if (
    check.year === time.year &&
    check.month === time.month &&
    check.day === time.day &&
    check.hour === time.hour &&
    check.minute === time.minute
  )
    return second
  return guess - Math.min(tzOffset(guess - DAY, tz), tzOffset(guess + DAY, tz))
}

function civilDate(ms: number, tz: string): CivilDate {
  const parts = localParts(ms, tz)
  return { year: parts.year, month: parts.month, day: parts.day }
}

function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

function dayNumber(date: CivilDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY)
}

function daysBetween(from: CivilDate, to: CivilDate): number {
  return dayNumber(to) - dayNumber(from)
}

function weekdayOf(date: CivilDate): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? "MO"
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function mondayOffset(day: Weekday): number {
  return MONDAY_FIRST.indexOf(day)
}

function weekStart(date: CivilDate): CivilDate {
  return addDays(date, -mondayOffset(weekdayOf(date)))
}

function zonedHour(anchor: number, tz: string): number {
  const parts = localParts(anchor, tz)
  return zonedTime({ year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: 0 }, tz)
}

function frequencyOf(value: string): Frequency {
  switch (value) {
    case "HOURLY":
    case "DAILY":
    case "WEEKLY":
    case "MONTHLY":
      return value
    default:
      throw new RuleError(`unsupported FREQ "${value}" (use HOURLY, DAILY, WEEKLY or MONTHLY)`)
  }
}

function weekdayFrom(value: string): Weekday {
  switch (value) {
    case "MO":
    case "TU":
    case "WE":
    case "TH":
    case "FR":
    case "SA":
    case "SU":
      return value
    default:
      throw new RuleError(`unsupported BYDAY value "${value}" (use MO, TU, WE, TH, FR, SA or SU)`)
  }
}

function integerFrom(value: string, key: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new RuleError(`${key} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new RuleError(`${key} must be between ${minimum} and ${maximum}`)
  return parsed
}

function list(value: string): string[] {
  const items = value.split(",").map((item) => item.trim())
  if (items.some((item) => item === "")) throw new RuleError("empty list item")
  return items
}

function unique(values: readonly number[]): readonly number[] {
  return [...new Set(values)].toSorted((left, right) => left - right)
}

function untilFrom(value: string): number {
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (basic !== null) {
    const year = Number(basic[1])
    const month = Number(basic[2])
    const day = Number(basic[3])
    const hour = Number(basic[4])
    const minute = Number(basic[5])
    const second = Number(basic[6])
    const parsed = Date.UTC(year, month - 1, day, hour, minute, second)
    if (Number.isFinite(parsed)) return parsed
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new RuleError(`UNTIL "${value}" is not a date`)
  return parsed
}

export function parseRule(input: string): Rule {
  const body = input.trim().replace(/^RRULE:/i, "")
  if (body === "") throw new RuleError("empty rule")
  const fields = new Map<string, string>()
  for (const entry of body.split(";")) {
    if (entry === "") continue
    const equals = entry.indexOf("=")
    if (equals <= 0) throw new RuleError(`rule part "${entry}" is not KEY=VALUE`)
    const key = entry.slice(0, equals).toUpperCase()
    if (!KNOWN_PARTS.has(key)) throw new RuleError(`unsupported rule part ${key}`)
    if (fields.has(key)) throw new RuleError(`${key} is given twice`)
    fields.set(key, entry.slice(equals + 1))
  }
  const rawFreq = fields.get("FREQ")
  if (rawFreq === undefined) throw new RuleError("FREQ is required")
  const freq = frequencyOf(rawFreq)
  const interval = fields.has("INTERVAL") ? integerFrom(fields.get("INTERVAL") ?? "", "INTERVAL", 1, 1000) : 1
  const rawDays = fields.get("BYDAY")
  const byday = rawDays === undefined ? [] : list(rawDays).map(weekdayFrom)
  if (new Set(byday).size !== byday.length) throw new RuleError("BYDAY repeats a day")
  const rawHours = fields.get("BYHOUR")
  const byhour = rawHours === undefined ? [] : unique(list(rawHours).map((item) => integerFrom(item, "BYHOUR", 0, 23)))
  const rawMinutes = fields.get("BYMINUTE")
  const byminute =
    rawMinutes === undefined ? [] : unique(list(rawMinutes).map((item) => integerFrom(item, "BYMINUTE", 0, 59)))
  if (freq === "HOURLY" && byhour.length > 0) throw new RuleError("BYHOUR is not supported with FREQ=HOURLY")
  if (fields.has("COUNT") && fields.has("UNTIL")) throw new RuleError("COUNT and UNTIL are mutually exclusive")
  const count = fields.has("COUNT") ? integerFrom(fields.get("COUNT") ?? "", "COUNT", 1, 100_000) : undefined
  const until = fields.has("UNTIL") ? untilFrom(fields.get("UNTIL") ?? "") : undefined
  return {
    freq,
    interval,
    byday,
    byhour,
    byminute,
    ...(count === undefined ? {} : { count }),
    ...(until === undefined ? {} : { until }),
  }
}

function planOf(rule: Rule, tz: string, anchor: number): Plan {
  const start = localParts(anchor, tz)
  const days = rule.freq === "WEEKLY" ? (rule.byday.length > 0 ? rule.byday : [weekdayOf(start)]) : rule.byday
  return {
    freq: rule.freq,
    interval: rule.interval,
    hours: rule.byhour.length > 0 ? rule.byhour : [start.hour],
    minutes: rule.byminute.length > 0 ? rule.byminute : [start.minute],
    ...(days.length === 0
      ? {}
      : { days: [...days].toSorted((left, right) => mondayOffset(left) - mondayOffset(right)) }),
  }
}

function datedSlots(plan: Plan, tz: string, date: CivilDate): readonly number[] {
  if (plan.days !== undefined && !plan.days.includes(weekdayOf(date))) return []
  const slots: number[] = []
  for (const hour of plan.hours) {
    for (const minute of plan.minutes) slots.push(zonedTime({ ...date, hour, minute }, tz))
  }
  return slots.toSorted((left, right) => left - right)
}

function hourlySlots(plan: Plan, tz: string, hour: number): readonly number[] {
  const parts = localParts(hour, tz)
  if (plan.days !== undefined && !plan.days.includes(weekdayOf(parts))) return []
  return plan.minutes.map((minute) => hour + minute * 60_000)
}

function periodIndex(plan: Plan, tz: string, anchor: number, at: number): number {
  switch (plan.freq) {
    case "HOURLY":
      return Math.max(0, Math.floor((at - zonedHour(anchor, tz)) / (plan.interval * HOUR)))
    case "DAILY":
      return Math.max(0, Math.floor(daysBetween(civilDate(anchor, tz), civilDate(at, tz)) / plan.interval))
    case "WEEKLY":
      return Math.max(
        0,
        Math.floor(daysBetween(weekStart(civilDate(anchor, tz)), weekStart(civilDate(at, tz))) / (7 * plan.interval)),
      )
    case "MONTHLY": {
      const start = civilDate(anchor, tz)
      const here = civilDate(at, tz)
      return Math.max(0, Math.floor(((here.year - start.year) * 12 + here.month - start.month) / plan.interval))
    }
    default: {
      const _exhaustive: never = plan.freq
      throw new Error(`unhandled frequency ${JSON.stringify(_exhaustive)}`)
    }
  }
}

function* slotStream(plan: Plan, tz: string, anchor: number, from: number): Generator<number> {
  const start = civilDate(anchor, tz)
  switch (plan.freq) {
    case "HOURLY": {
      const base = zonedHour(anchor, tz)
      for (let step = from; step < from + MAX_PERIODS; step++) {
        for (const slot of hourlySlots(plan, tz, base + step * plan.interval * HOUR)) yield slot
      }
      return
    }
    case "DAILY": {
      for (let step = from; step < from + MAX_PERIODS; step++) {
        for (const slot of datedSlots(plan, tz, addDays(start, step * plan.interval))) yield slot
      }
      return
    }
    case "WEEKLY": {
      const first = weekStart(start)
      for (let step = from; step < from + MAX_PERIODS; step++) {
        const week = addDays(first, step * 7 * plan.interval)
        for (const day of plan.days ?? []) {
          for (const slot of datedSlots(plan, tz, addDays(week, mondayOffset(day)))) yield slot
        }
      }
      return
    }
    case "MONTHLY": {
      for (let step = from; step < from + MAX_PERIODS; step++) {
        const months = start.month - 1 + step * plan.interval
        const year = start.year + Math.floor(months / 12)
        const month = (((months % 12) + 12) % 12) + 1
        if (start.day > daysInMonth(year, month)) continue
        for (const slot of datedSlots(plan, tz, { year, month, day: start.day })) yield slot
      }
      return
    }
    default: {
      const _exhaustive: never = plan.freq
      throw new Error(`unhandled frequency ${JSON.stringify(_exhaustive)}`)
    }
  }
}

function ruleSlots(rule: Rule, tz: string, anchor: number): Slots {
  const plan = planOf(rule, tz, anchor)
  return {
    next(after, index) {
      for (const slot of slotStream(plan, tz, anchor, periodIndex(plan, tz, anchor, after))) {
        if (rule.until !== undefined && slot > rule.until) return undefined
        if (slot < anchor || slot <= after) continue
        if (rule.count !== undefined && index >= rule.count) return undefined
        return { slot, index }
      }
      return undefined
    },
    due(after, index, now) {
      let used = index
      let window: DueWindow | undefined
      for (const slot of slotStream(plan, tz, anchor, periodIndex(plan, tz, anchor, after))) {
        if (rule.until !== undefined && slot > rule.until) break
        if (slot > now) break
        if (slot < anchor || slot <= after) continue
        if (rule.count !== undefined && used >= rule.count) break
        window = { count: (window?.count ?? 0) + 1, latest: slot, index: used }
        used += 1
      }
      return window
    },
  }
}

function oneShot(at: number): Slots {
  return {
    next: (after) => (at > after ? { slot: at, index: 0 } : undefined),
    due: (after, _index, now) => (now >= at && at > after ? { count: 1, latest: at, index: 0 } : undefined),
  }
}

export function slotsOf(when: When, tz: string, anchor: number): Slots {
  switch (when.kind) {
    case "at":
      return oneShot(when.at)
    case "rrule":
      return ruleSlots(parseRule(when.rrule), tz, anchor)
    default: {
      const _exhaustive: never = when
      return _exhaustive
    }
  }
}
