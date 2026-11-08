export type LogEntry = {
  readonly at: number
  readonly level: "warn" | "error"
  readonly text: string
}

export type LogRing = {
  entries(): readonly LogEntry[]
  stop(): void
}

const TEXT_LIMIT = 4_000

const render = (args: readonly unknown[]): string =>
  args
    .map((arg) => String(arg))
    .join(" ")
    .slice(0, TEXT_LIMIT)

let shared: LogRing | undefined

/** console is module-global, so every home in the isolate shares one ring; a second patch would nest wrappers. */
export function ring(limit = 200): LogRing {
  shared ??= captureLogs(limit)
  return shared
}

export function captureLogs(limit = 200): LogRing {
  const target = console
  const originalWarn = target.warn
  const originalError = target.error
  const entries: LogEntry[] = []
  const record = (level: LogEntry["level"], args: readonly unknown[]): void => {
    entries.push({ at: Date.now(), level, text: render(args) })
    if (entries.length > limit) entries.splice(0, entries.length - limit)
  }
  const warn = function (this: unknown, ...args: unknown[]): void {
    record("warn", args)
    originalWarn.apply(this, args)
  }
  const error = function (this: unknown, ...args: unknown[]): void {
    record("error", args)
    originalError.apply(this, args)
  }
  target.warn = warn
  target.error = error
  let stopped = false
  return {
    entries: () => [...entries],
    stop: () => {
      if (stopped) return
      stopped = true
      target.warn = originalWarn
      target.error = originalError
    },
  }
}
