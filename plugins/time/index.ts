import type { Message, UserMessage } from "@earendil-works/pi-ai"
import { type ConversationId, defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable"
import { CLOCK_READING_PREFIX, newestVisible } from "../../src/contracts/message.ts"
import { loaderRow } from "../../src/contributions.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "time"
export const inject = ["pi"]

const DEFAULT_REFRESH_INTERVAL_MS = 600_000

export const Config = Schema.object({
  timezone: Schema.string()
    .default("UTC")
    .description("IANA time zone used for the reading, for example Europe/Berlin."),
  refreshIntervalMs: Schema.number()
    .default(DEFAULT_REFRESH_INTERVAL_MS)
    .description("Minimum milliseconds between readings in one conversation. 0 writes one before every request."),
})

type Config = {
  readonly timezone: string
  readonly refreshIntervalMs: number
}

export function createTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  })
}

const part = (parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string => {
  const value = parts.find((candidate) => candidate.type === type)?.value
  if (value === undefined) throw new Error(`timestamp has no ${type}`)
  return value
}

export function formatTimestamp(now: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = formatter.formatToParts(now)
  const offset = part(parts, "timeZoneName").replace(/^GMT$/, "GMT+00:00").slice(3)
  return (
    `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}` +
    `T${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}` +
    `${offset}[${timeZone}]`
  )
}

export function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1_000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3_600)
  seconds %= 3_600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const units: string[] = []
  if (days > 0) units.push(`${days}d`)
  if (hours > 0) units.push(`${hours}h`)
  if (minutes > 0) units.push(`${minutes}m`)
  units.push(`${seconds}s`)
  return units.join(" ")
}

export type ClockReading = {
  readonly now: number
  readonly turn: number
  readonly step: number
  readonly previous: number | undefined
  readonly timeZone: string
  readonly formatter: Intl.DateTimeFormat
}

export function renderReading(reading: ClockReading): string {
  const elapsed = reading.previous === undefined ? "unavailable" : formatDuration(reading.now - reading.previous)
  const baseline = reading.step === 1 ? "model-visible message" : "step context"
  return (
    `${CLOCK_READING_PREFIX}${reading.turn}, step ${reading.step}: ` +
    `${formatTimestamp(reading.now, reading.formatter, reading.timeZone)}\n` +
    `Owner time zone: ${reading.timeZone}. Interpret otherwise-unqualified dates and times in this zone.\n` +
    `Elapsed since the preceding ${baseline}: ${elapsed}.`
  )
}

type ConversationClock = {
  signature: string | undefined
  turn: number
  step: number
  lastReadingAt: number | undefined
  turnReadingAt: number | undefined
}

const emptyClock = (): ConversationClock => ({
  signature: undefined,
  turn: 0,
  step: 0,
  lastReadingAt: undefined,
  turnReadingAt: undefined,
})

const signatureOf = (messages: readonly Message[], visible: Message | undefined): string =>
  visible === undefined ? "empty" : `${messages.length}:${visible.role}:${visible.timestamp}`

const timestampFormatter = (timeZone: string): Intl.DateTimeFormat => {
  try {
    return createTimestampFormatter(timeZone)
  } catch (error: unknown) {
    throw new Error(`time: invalid IANA time zone ${JSON.stringify(timeZone)}`, { cause: error })
  }
}

const refreshInterval = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`time: refreshIntervalMs must be a non-negative safe integer, got ${String(value)}`)
  return value
}

export function apply(ctx: Context, config: Config): void {
  const formatter = timestampFormatter(config.timezone)
  const timeZone = formatter.resolvedOptions().timeZone
  const intervalMs = refreshInterval(config.refreshIntervalMs)
  const row = loaderRow(ctx) ?? name
  const clocks = new Map<ConversationId, ConversationClock>()

  ctx.pi.install(
    defineExtension({
      name: `clock-${row}`,
      hooks: [
        hook(GenerationTask, {
          beforeRequest: (request, api) => {
            const visible = newestVisible(request.messages)
            const signature = signatureOf(request.messages, visible)
            const clock = clocks.get(api.conversationId) ?? emptyClock()
            clocks.set(api.conversationId, clock)
            if (clock.signature !== signature) {
              clock.signature = signature
              if (visible?.role === "user" || clock.step === 0) {
                clock.turn += 1
                clock.step = 1
                clock.turnReadingAt = undefined
              } else {
                clock.step += 1
              }
            }

            const now = Date.now()
            const last = clock.lastReadingAt
            if (intervalMs > 0 && last !== undefined && now >= last && now - last < intervalMs) return undefined

            const previous = clock.step === 1 ? visible?.timestamp : clock.turnReadingAt
            const text = renderReading({ now, turn: clock.turn, step: clock.step, previous, timeZone, formatter })
            const reading: UserMessage = { role: "user", content: text, timestamp: now }
            clock.lastReadingAt = now
            clock.turnReadingAt = now
            return { messages: [...request.messages, reading] }
          },
        }),
      ],
    }),
  )
}
