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

export function originLabel(origin: string): string {
  const stripped = origin.replace(/^https?:\/\//u, "").replace(/\/$/u, "")
  return stripped === "" ? "No origin sent" : stripped
}
