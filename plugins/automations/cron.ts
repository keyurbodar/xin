export class CronError extends Error {}

export type Cron = {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  readonly anyDay: boolean
  readonly anyWeekday: boolean
}

type Field = { readonly min: number; readonly max: number; readonly names?: readonly string[] }

const MINUTE: Field = { min: 0, max: 59 }
const HOUR: Field = { min: 0, max: 23 }
const DAY: Field = { min: 1, max: 31 }
const MONTH: Field = {
  min: 1,
  max: 12,
  names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
}
const WEEKDAY: Field = { min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] }

const MINUTE_MS = 60_000
const SEARCH_DAYS = 366 * 5

/** Five fields, minute hour day-of-month month day-of-week, with `*`, lists, ranges, steps and month or day names. */
export function parseCron(text: string): Cron {
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronError("a cron expression has five fields: minute hour day month weekday")
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields
  const weekdays = new Set([...parseField(weekday, WEEKDAY)].map((value) => value % 7))
  return {
    minutes: parseField(minute, MINUTE),
    hours: parseField(hour, HOUR),
    days: parseField(day, DAY),
    months: parseField(month, MONTH),
    weekdays,
    anyDay: day === "*" || day === "?",
    anyWeekday: weekday === "*" || weekday === "?",
  }
}

function parseField(text: string, field: Field): ReadonlySet<number> {
  const values = new Set<number>()
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/")
    const step = stepText === undefined ? 1 : numberOf(stepText, { min: 1, max: field.max })
    let low: number
    let high: number
    if (range === "*" || range === "?") {
      low = field.min
      high = field.max
    } else if (range.includes("-")) {
      const [from = "", to = ""] = range.split("-")
      low = valueOf(from, field)
      high = valueOf(to, field)
    } else {
      low = valueOf(range, field)
      high = stepText === undefined ? low : field.max
    }
    if (low > high) throw new CronError(`"${part}" runs backwards`)
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

function valueOf(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toUpperCase()) ?? -1
  if (named >= 0) return named + field.min
  return numberOf(text, field)
}

function numberOf(text: string, field: Pick<Field, "min" | "max">): number {
  if (!/^\d+$/.test(text)) throw new CronError(`"${text}" is not a number`)
  const value = Number(text)
  if (value < field.min || value > field.max) throw new CronError(`${value} is outside ${field.min}-${field.max}`)
  return value
}

export function validZone(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })
  formatters.set(tz, created)
  return created
}

type Civil = { readonly year: number; readonly month: number; readonly day: number; hour: number; minute: number }

function civilOf(ms: number, tz: string): Civil {
  const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 }
  for (const part of formatter(tz).formatToParts(ms))
    if (part.type in parts) parts[part.type as keyof typeof parts] = Number(part.value)
  return parts
}

const civilMs = (civil: Civil): number => Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute)

function sameMinute(left: Civil, right: Civil): boolean {
  return civilMs(left) === civilMs(right)
}

/** The instant a wall-clock minute names in `tz`, or undefined when daylight saving skips it. */
function instantOf(civil: Civil, tz: string): number | undefined {
  const guess = civilMs(civil)
  const first = guess - (civilMs(civilOf(guess, tz)) - guess)
  const second = guess - (civilMs(civilOf(first, tz)) - first)
  for (const candidate of [Math.min(first, second), Math.max(first, second)])
    if (sameMinute(civilOf(candidate, tz), civil)) return candidate
  return undefined
}

/** The first minute after `after` that the expression names in `tz`. */
export function nextCron(cron: Cron, tz: string, after: number): number | undefined {
  const start = civilOf(Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS, tz)
  const hours = [...cron.hours].toSorted((a, b) => a - b)
  const minutes = [...cron.minutes].toSorted((a, b) => a - b)
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset))
    const day: Civil = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: 0,
      minute: 0,
    }
    if (!cron.months.has(day.month) || !dayMatches(cron, day.day, date.getUTCDay())) continue
    for (const hour of hours) {
      if (offset === 0 && hour < start.hour) continue
      for (const minute of minutes) {
        if (offset === 0 && hour === start.hour && minute < start.minute) continue
        const at = instantOf({ ...day, hour, minute }, tz)
        if (at !== undefined && at > after) return at
      }
    }
  }
  return undefined
}

function dayMatches(cron: Cron, day: number, weekday: number): boolean {
  if (cron.anyDay && cron.anyWeekday) return true
  if (cron.anyDay) return cron.weekdays.has(weekday)
  if (cron.anyWeekday) return cron.days.has(day)
  return cron.days.has(day) || cron.weekdays.has(weekday)
}
