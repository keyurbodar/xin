const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact elapsed time, the way the frames write it: 0m 48s, 2m, 4h, 3d, Thu. */
export function ago(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "—"
  const elapsed = now - at
  if (elapsed < 0) return "now"
  if (elapsed < MINUTE) return `${Math.max(1, Math.floor(elapsed / 1000))}s`
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`
  return new Date(at).toLocaleDateString(undefined, { weekday: "short" })
}

/** Elapsed work time with minutes and seconds, for a finished thread row. */
export function elapsed(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "—"
  const total = Math.max(0, Math.floor((now - at) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

export function money(usd: number): string {
  if (usd === 0) return "$0.00"
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

export function bytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${(count / (1024 * 1024)).toFixed(1)} MB`
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The greeting the home frame uses, from the owner's local clock. */
export function greeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 5) return "Still up"
  if (hour < 12) return "Morning"
  if (hour < 17) return "Afternoon"
  return "Evening"
}

export function longDate(now = new Date()): string {
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" })
  const day = now.toLocaleDateString(undefined, { day: "numeric" })
  const month = now.toLocaleDateString(undefined, { month: "long" })
  return `${weekday} · ${day} ${month}`
}

const DAYS: Readonly<Record<string, string>> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
}

/** A recurrence the owner can read; anything it does not recognise stays as the rule it was given. */
export function describeRule(rrule: string): string {
  const parts = new Map(
    rrule
      .split(";")
      .map((part) => part.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key.toUpperCase(), value]),
  )
  const freq = parts.get("FREQ")?.toUpperCase()
  if (freq === undefined) return rrule
  const every = Number(parts.get("INTERVAL") ?? "1")
  const each = (unit: string, plural: string): string =>
    Number.isFinite(every) && every > 1 ? `Every ${every} ${plural}` : `Every ${unit}`
  const at = (): string => {
    const hour = Number(parts.get("BYHOUR") ?? "9")
    const minute = Number(parts.get("BYMINUTE") ?? "0")
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return ""
    return ` at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  }
  switch (freq) {
    case "DAILY":
      return `${each("day", "days")}${at()}`
    case "WEEKLY": {
      const days = (parts.get("BYDAY") ?? "")
        .split(",")
        .map((day) => DAYS[day.trim().toUpperCase()] ?? day.trim())
        .filter((day) => day !== "")
      if (days.length === 0) return `${each("week", "weeks")}${at()}`
      const label = days.join(", ")
      return Number.isFinite(every) && every > 1 ? `Every ${every} weeks on ${label}${at()}` : `Every ${label}${at()}`
    }
    case "MONTHLY":
      return `${each("month", "months")}${at()}`
    case "YEARLY":
      return `${each("year", "years")}${at()}`
    default:
      return rrule
  }
}
