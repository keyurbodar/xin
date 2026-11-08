import {
  type ConversationId,
  defineExtension,
  GenerationTask,
  type HookApi,
  hook,
  ToolTask,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable"
import { newestInstruction } from "../../src/contracts/message.ts"
import { type Context, Schema } from "../../src/kernel/index.ts"

export const name = "guard"
export const inject = ["pi"]

export const Config = Schema.object({
  thresholds: Schema.array(Schema.number()).default([3, 5, 8]).description("Repeat counts that draw a reminder."),
  include: Schema.array(Schema.string()).default([]).description("Tool names to track; every tool by default."),
  exclude: Schema.array(Schema.string()).default([]).description("Tool names left out of the count."),
  argumentsPreviewChars: Schema.number().default(500).description("Argument characters the detailed reminder shows."),
})

type Config = {
  readonly thresholds: readonly number[]
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly argumentsPreviewChars: number
}

const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call."

const detailedReminder = (tool: string, count: number, argumentsText: string): string =>
  `Repeated tool call detected:\n` +
  `- tool: ${tool}\n` +
  `- consecutive_calls: ${count}\n` +
  `- arguments: ${argumentsText}\n` +
  "The repeated calls are not making progress. Do not call this tool with " +
  "these exact arguments again. Inspect the latest result and choose a " +
  "different action, different arguments, or finish the task if enough " +
  "evidence has been gathered."

const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value === null || typeof value !== "object") return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).toSorted()) sorted[key] = sortedKeys(Reflect.get(value, key))
  return sorted
}

const canonical = (argumentsValue: unknown): string => JSON.stringify(sortedKeys(argumentsValue))

const wildcardToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`).replaceAll("*", ".*")}$`)

const preview = (text: string, cap: number): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}… (+${text.length - cap} more chars)`

const validateThresholds = (values: readonly number[]): readonly number[] => {
  if (values.length === 0) throw new Error("guard: `thresholds` must not be empty")
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2)
      throw new Error(`guard: invalid threshold ${value} — every threshold must be an integer >= 2`)
  }
  if (new Set(values).size !== values.length) throw new Error("guard: `thresholds` must not contain duplicates")
  return values.toSorted((left, right) => left - right)
}

const validatePreview = (value: number): number => {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`guard: invalid argumentsPreviewChars ${value} — must be an integer >= 1`)
  return value
}

type Track = {
  key: string | undefined
  count: number
  owner: string | undefined
  readonly pending: Map<string, number>
}

export function apply(ctx: Context, config: Config): void {
  const thresholds = validateThresholds(config.thresholds)
  const gentleAt = thresholds[0]
  const thresholdSet = new Set(thresholds)
  const include = config.include.map(wildcardToRegExp)
  const exclude = config.exclude.map(wildcardToRegExp)
  const previewChars = validatePreview(config.argumentsPreviewChars)

  const tracks = new Map<ConversationId, Track>()

  const trackOf = (conversation: ConversationId): Track => {
    const existing = tracks.get(conversation)
    if (existing !== undefined) return existing
    const created: Track = { key: undefined, count: 0, owner: undefined, pending: new Map() }
    tracks.set(conversation, created)
    return created
  }

  const tracked = (tool: string): boolean =>
    (include.length === 0 || include.some((pattern) => pattern.test(tool))) &&
    !exclude.some((pattern) => pattern.test(tool))

  const beforeTool = (call: ToolHookCall, api: HookApi): undefined => {
    if (call.parent !== undefined || !tracked(call.name)) return undefined
    const identity = JSON.stringify([call.name, canonical(call.arguments)])
    const track = trackOf(api.conversationId)
    track.count = track.key === identity ? track.count + 1 : 1
    track.key = identity
    if (thresholdSet.has(track.count)) track.pending.set(call.id, track.count)
    return undefined
  }

  const afterTool = (call: ToolHookCall, result: ToolExecutionResult, api: HookApi): ToolExecutionResult => {
    const track = tracks.get(api.conversationId)
    const count = track?.pending.get(call.id)
    if (track === undefined || count === undefined) return result
    track.pending.delete(call.id)
    const reminder =
      count === gentleAt
        ? GENTLE_REMINDER
        : detailedReminder(call.name, count, preview(canonical(call.arguments), previewChars))
    return { ...result, output: [...(result.output ?? []), { type: "text", text: reminder }] }
  }

  ctx.pi.install(
    defineExtension({
      name: "xin.guard",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: (request, api) => {
            const instruction = newestInstruction(request.messages)
            if (instruction === undefined) return undefined
            const owner = `${request.messages.length}:${instruction.role}:${instruction.timestamp}`
            const track = trackOf(api.conversationId)
            if (track.owner === owner) return undefined
            track.owner = owner
            track.key = undefined
            track.count = 0
            track.pending.clear()
            return undefined
          },
        }),
        hook(ToolTask, { beforeTool, afterTool }),
      ],
    }),
  )
}
