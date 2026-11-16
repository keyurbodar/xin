import { count } from "../../../lib/format.ts"
import { listOf, numOf, recordOf, strOf } from "../../../lib/parse.ts"
import {
  entryBatchRows,
  entryFailure,
  type Attachment,
  type BatchRow,
  type ChatMessage,
  type EntryView,
  type FailureData,
  type Snapshot,
} from "../../../state/conversation.ts"

export type ToolStatus = "streaming" | "running" | "done" | "error"

export type ToolCall = {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly output: string | undefined
  readonly details: unknown
  readonly status: ToolStatus
}

export type TimelineLink = { readonly threadId: number; readonly label: string }

export type Phrase = readonly (string | TimelineLink)[]

export type PassItem =
  | { readonly kind: "report" | "question" | "job"; readonly row: BatchRow }
  | { readonly kind: "failure"; readonly entryId: number; readonly failure: FailureData }
  | { readonly kind: "notice"; readonly text: string }

export type TimelineItem =
  | { readonly kind: "date"; readonly key: string; readonly label: string }
  | { readonly kind: "owner"; readonly key: string; readonly text: string; readonly attachments: readonly Attachment[] }
  | { readonly kind: "pass"; readonly key: string; readonly item: PassItem }
  | { readonly kind: "text"; readonly key: string; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "tools"; readonly key: string; readonly calls: readonly ToolCall[]; readonly live: boolean }
  | { readonly kind: "block"; readonly key: string; readonly call: ToolCall }
  | { readonly kind: "summary"; readonly key: string; readonly phrase: Phrase }

export type LivePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "call"; readonly callId: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }

export type LiveSlot = {
  readonly name: string
  readonly status: "pending" | "running" | "done"
  readonly output: string | undefined
  readonly details: unknown
}

export type LiveTimeline = {
  readonly busy: boolean
  readonly parts: readonly LivePart[]
  readonly slots: ReadonlyMap<string, LiveSlot>
}

export type BuildOptions = {
  readonly hasBlock: (name: string) => boolean
  readonly titles: ReadonlyMap<number, string>
  readonly now: number
}

export type WaitTarget =
  | { readonly kind: "person" }
  | { readonly kind: "threads"; readonly threads: readonly TimelineLink[] }
  | { readonly kind: "tool"; readonly name: string }

type ToolKind = "search" | "read" | "check" | "command" | "edit" | "fetch" | "thread" | "message" | "other"

const KIND_OF: readonly (readonly [ToolKind, RegExp])[] = [
  ["thread", /^(delegate_task|thread_create)$/u],
  ["message", /^thread_send$/u],
  ["check", /^(thread_read|thread_list|task_status|get_goal)$/u],
  ["command", /bash|exec|shell|command|terminal/u],
  ["search", /search|grep|glob|recall/u],
  ["fetch", /fetch|browse/u],
  ["read", /^read|_read$|^git_|^view/u],
  ["edit", /edit|write|save|remember|update|create|comment|^set_/u],
]

const PHRASES: readonly (readonly [ToolKind, (n: number) => string])[] = [
  ["search", (n) => `searched ${count(n, "time")}`],
  ["read", (n) => `read ${count(n, "file")}`],
  ["check", (n) => `checked ${count(n, "thread")}`],
  ["command", (n) => `ran ${count(n, "command")}`],
  ["edit", (n) => `made ${count(n, "edit")}`],
  ["fetch", (n) => `fetched ${count(n, "page")}`],
  ["thread", (n) => `started ${count(n, "thread")}`],
  ["message", (n) => `sent ${count(n, "message")}`],
  ["other", (n) => `used ${count(n, "tool")}`],
]

export function toolKind(name: string): ToolKind {
  return KIND_OF.find(([, pattern]) => pattern.test(name))?.[0] ?? "other"
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export function groupSummary(calls: readonly ToolCall[]): string {
  const counts = new Map<ToolKind, number>()
  for (const call of calls) counts.set(toolKind(call.name), (counts.get(toolKind(call.name)) ?? 0) + 1)
  const parts = PHRASES.flatMap(([kind, phrase]) => {
    const n = counts.get(kind)
    return n === undefined ? [] : [phrase(n)]
  })
  const failed = calls.filter((call) => call.status === "error").length
  if (failed > 0) parts.push(`${failed} failed`)
  return capital(parts.join(", "))
}

export function groupStatus(calls: readonly ToolCall[]): ToolStatus {
  if (calls.some((call) => call.status === "streaming" || call.status === "running")) return "running"
  return calls.some((call) => call.status === "error") ? "error" : "done"
}

const ARG_KEYS = ["command", "path", "query", "url", "title", "question", "text"] as const

export function stepTarget(call: ToolCall): string {
  const named = ARG_KEYS.map((key) => strOf(call.args[key])).find((value) => value !== undefined)
  const first = named ?? Object.values(call.args).find((value): value is string => typeof value === "string") ?? ""
  return first.replace(/\s+/gu, " ").trim()
}

export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

export function dayLabel(at: number, now: number): string {
  const day = new Date(at).setHours(0, 0, 0, 0)
  const today = new Date(now).setHours(0, 0, 0, 0)
  if (day === today) return "Today"
  if (day === new Date(today).setDate(new Date(today).getDate() - 1)) return "Yesterday"
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
}

function names(links: readonly TimelineLink[], noun: string): Phrase {
  if (links.length > 2) return [count(links.length, noun)]
  if (links.length === 2) return [links[0]!, " and ", links[1]!]
  return links
}

export function turnPhrase(turn: {
  readonly finished: readonly TimelineLink[]
  readonly started: readonly TimelineLink[]
  readonly messaged: readonly TimelineLink[]
  readonly workedMs: number | undefined
}): Phrase {
  const clauses: Phrase[] = []
  if (turn.finished.length > 0) clauses.push([...names(turn.finished, "thread"), " finished"])
  if (turn.started.length > 0) clauses.push(["started ", ...names(turn.started, "thread")])
  if (turn.messaged.length > 0) clauses.push(["messaged ", ...names(turn.messaged, "thread")])
  if (turn.workedMs !== undefined) clauses.push([`worked for ${duration(turn.workedMs)}`])
  const phrase = clauses.flatMap((clause, index) => (index === 0 ? clause : [", ", ...clause]))
  const head = phrase[0]
  return typeof head === "string" ? [capital(head), ...phrase.slice(1)] : phrase
}

export function waitPhrase(target: WaitTarget): Phrase {
  switch (target.kind) {
    case "person":
      return ["Waiting on you"]
    case "tool":
      return [`Waiting on ${target.name}`]
    case "threads": {
      const shown = target.threads.slice(0, 2)
      const rest = target.threads.length - shown.length
      if (rest === 0) return ["Waiting on ", ...names(shown, "thread")]
      return ["Waiting on ", shown[0]!, ...(shown[1] === undefined ? [] : [", ", shown[1]]), `, and ${count(rest, "other thread")}`]
    }
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

export function waitTarget(input: {
  readonly live: LiveTimeline
  readonly asking: boolean
  readonly threads: readonly TimelineLink[]
}): WaitTarget | undefined {
  if (input.asking) return { kind: "person" }
  if (input.live.busy) {
    if (input.live.parts.length > 0) return undefined
    const running = [...input.live.slots.values()].find((slot) => slot.status !== "done")
    return running === undefined ? undefined : { kind: "tool", name: running.name }
  }
  return input.threads.length > 0 ? { kind: "threads", threads: input.threads } : undefined
}

function contentParts(content: unknown): readonly LivePart[] {
  const parts: LivePart[] = []
  for (const value of listOf(content)) {
    const part = recordOf(value)
    if (part?.type === "text") {
      const text = strOf(part.text) ?? ""
      const last = parts.at(-1)
      if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + text }
      else parts.push({ kind: "text", text })
      continue
    }
    if (part?.type !== "toolCall") continue
    const callId = strOf(part.id)
    const name = strOf(part.name)
    if (callId === undefined || name === undefined) continue
    parts.push({ kind: "call", callId, name, args: recordOf(part.arguments) ?? {} })
  }
  return parts.flatMap((part): LivePart[] => {
    if (part.kind !== "text") return [part]
    const text = part.text.trim()
    return text === "" ? [] : [{ kind: "text", text }]
  })
}

function slotStatus(value: unknown): LiveSlot["status"] {
  return value === "pending" || value === "done" ? value : "running"
}

export function liveTimelineOf(snapshot: Snapshot | undefined): LiveTimeline {
  const live = recordOf(snapshot?.docs["pi.live"])
  const message = recordOf(recordOf(live?.generation)?.message)
  const slots = new Map<string, LiveSlot>()
  for (const value of listOf(live?.tools)) {
    const slot = recordOf(value)
    const callId = strOf(slot?.callId)
    const name = strOf(slot?.name)
    if (callId === undefined || name === undefined) continue
    slots.set(callId, { name, status: slotStatus(slot?.status), output: strOf(slot?.output), details: slot?.details })
  }
  return { busy: live?.run !== undefined, parts: contentParts(message?.content), slots }
}

const INPUT_KINDS = new Set(["pi.user", "xin.batch"])

type Turn = { readonly key: string; readonly entries: EntryView[] }

function turnsOf(entries: readonly EntryView[]): readonly Turn[] {
  const turns: Turn[] = []
  let answered = true
  for (const entry of entries) {
    const input = INPUT_KINDS.has(entry.kind)
    const current = turns.at(-1)
    if (current === undefined || (input && answered)) {
      turns.push({ key: `t${entry.id}`, entries: [entry] })
      answered = !input
      continue
    }
    current.entries.push(entry)
    if (!input) answered = true
  }
  return turns
}

function messageText(message: ChatMessage): string {
  return contentParts(message.content)
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
}

type Segment = { readonly kind: "text"; readonly text: string; readonly streaming: boolean } | { readonly kind: "call"; readonly call: ToolCall }

type TurnFacts = {
  readonly items: TimelineItem[]
  readonly finished: TimelineLink[]
  readonly started: TimelineLink[]
  readonly messaged: TimelineLink[]
  readonly times: number[]
  readonly answered: boolean
}

const linkTo = (threadId: number, titles: ReadonlyMap<number, string>, fallback?: string): TimelineLink => ({
  threadId,
  label: titles.get(threadId) ?? fallback ?? `#${threadId}`,
})

function inputItems(entry: EntryView, facts: TurnFacts, titles: ReadonlyMap<number, string>): void {
  if (entry.kind === "pi.user") {
    for (const message of entry.model) if (message.timestamp !== undefined) facts.times.push(message.timestamp)
    const text = entry.model.map(messageText).join("\n").trim()
    if (text !== "") facts.items.push({ kind: "owner", key: `e${entry.id}`, text, attachments: [] })
    return
  }
  for (const [index, row] of entryBatchRows(entry).entries()) {
    const key = `e${entry.id}:${index}`
    if (row.clientTs !== undefined) facts.times.push(row.clientTs)
    if (row.kind === "user") {
      if (row.text.trim() !== "" || row.attachments.length > 0)
        facts.items.push({ kind: "owner", key, text: row.text, attachments: row.attachments })
      continue
    }
    facts.items.push({ kind: "pass", key, item: { kind: row.kind, row } })
    const threadId = Number(row.threadId)
    if (row.kind === "report" && row.threadId !== "" && Number.isInteger(threadId))
      facts.finished.push(linkTo(threadId, titles, row.title === "" ? undefined : row.title))
  }
}

function callStatus(callId: string, results: ReadonlyMap<string, ChatMessage>, slots: ReadonlyMap<string, LiveSlot>, live: boolean): ToolStatus {
  const result = results.get(callId)
  if (result !== undefined) return result.isError === true ? "error" : "done"
  const slot = slots.get(callId)
  if (slot !== undefined) return slot.status === "done" ? "done" : "running"
  return live ? "running" : "error"
}

function segmentItems(turnKey: string, segments: readonly Segment[], live: boolean, hasBlock: (name: string) => boolean): TimelineItem[] {
  const items: TimelineItem[] = []
  let group: ToolCall[] | undefined
  const close = (): void => {
    if (group === undefined) return
    items.push({ kind: "tools", key: `${turnKey}:${items.length}`, calls: group, live })
    group = undefined
  }
  for (const segment of segments) {
    if (segment.kind === "text") {
      close()
      items.push({ kind: "text", key: `${turnKey}:${items.length}`, text: segment.text, streaming: segment.streaming })
      continue
    }
    if (hasBlock(segment.call.name)) {
      close()
      items.push({ kind: "block", key: `${turnKey}:${items.length}`, call: segment.call })
      continue
    }
    group ??= []
    group.push(segment.call)
  }
  close()
  return items
}

function turnItems(turn: Turn, live: LiveTimeline | undefined, options: BuildOptions): TurnFacts {
  const facts: TurnFacts = { items: [], finished: [], started: [], messaged: [], times: [], answered: false }
  const results = new Map<string, ChatMessage>()
  const created = new Map<string, number>()
  const calls: { readonly callId: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }[] = []
  const order: ({ readonly kind: "text"; readonly text: string } | { readonly kind: "call"; readonly callId: string })[] = []
  let agent = false
  for (const entry of turn.entries) {
    if (INPUT_KINDS.has(entry.kind) && !agent) {
      inputItems(entry, facts, options.titles)
      continue
    }
    agent = true
    if (entry.kind === "xin.error") {
      const failure = entryFailure(entry)
      if (failure !== undefined) facts.items.push({ kind: "pass", key: `e${entry.id}`, item: { kind: "failure", entryId: entry.id, failure } })
      continue
    }
    if (entry.kind === "pi.reset") {
      facts.items.push({ kind: "pass", key: `e${entry.id}`, item: { kind: "notice", text: "Context reset" } })
      continue
    }
    for (const message of entry.model) {
      if (message.timestamp !== undefined && message.role !== "user") facts.times.push(message.timestamp)
      if (message.role === "toolResult" && message.toolCallId !== undefined) {
        results.set(message.toolCallId, message)
        if (message.threadId !== undefined) created.set(message.toolCallId, message.threadId)
        continue
      }
      if (message.role !== "assistant") continue
      for (const part of contentParts(message.content)) {
        if (part.kind === "text") order.push(part)
        else {
          calls.push(part)
          order.push({ kind: "call", callId: part.callId })
        }
      }
    }
  }
  const slots = live?.slots ?? new Map<string, LiveSlot>()
  const byId = new Map(calls.map((call) => [call.callId, call]))
  const segments: Segment[] = order.flatMap((part): Segment[] => {
    if (part.kind === "text") return [{ kind: "text", text: part.text, streaming: false }]
    const call = byId.get(part.callId)
    if (call === undefined) return []
    const result = results.get(call.callId)
    return [
      {
        kind: "call",
        call: {
          ...call,
          output: result === undefined ? slots.get(call.callId)?.output : messageText(result) || undefined,
          details: result === undefined ? slots.get(call.callId)?.details : result.details,
          status: callStatus(call.callId, results, slots, live !== undefined),
        },
      },
    ]
  })
  for (const part of live?.parts ?? []) {
    if (part.kind === "text") segments.push({ kind: "text", text: part.text, streaming: true })
    else segments.push({ kind: "call", call: { ...part, output: undefined, details: undefined, status: "streaming" } })
  }
  for (const call of calls) {
    if (call.name === "thread_send") {
      const threadId = numOf(call.args.threadId)
      if (threadId !== undefined && !facts.messaged.some((link) => link.threadId === threadId))
        facts.messaged.push(linkTo(threadId, options.titles))
    }
    const threadId = created.get(call.callId)
    if (toolKind(call.name) === "thread" && threadId !== undefined)
      facts.started.push(linkTo(threadId, options.titles, strOf(call.args.title)))
  }
  facts.items.push(...segmentItems(turn.key, segments, live !== undefined, options.hasBlock))
  return { ...facts, answered: agent }
}

export function buildTimeline(entries: readonly EntryView[], live: LiveTimeline, options: BuildOptions): readonly TimelineItem[] {
  const turns = turnsOf(entries)
  const items: TimelineItem[] = []
  let lastDay: string | undefined
  for (const [index, turn] of turns.entries()) {
    const current = live.busy && index === turns.length - 1
    const facts = turnItems(turn, current ? live : undefined, options)
    const first = facts.times.length === 0 ? undefined : Math.min(...facts.times)
    if (first !== undefined) {
      const label = dayLabel(first, options.now)
      if (label !== lastDay) items.push({ kind: "date", key: `${turn.key}:day`, label })
      lastDay = label
    }
    items.push(...facts.items)
    if (current || !facts.answered) continue
    const workedMs = first === undefined ? undefined : Math.max(...facts.times) - first
    const phrase = turnPhrase({ ...facts, workedMs: workedMs === undefined || workedMs <= 0 ? undefined : workedMs })
    if (phrase.length > 0) items.push({ kind: "summary", key: `${turn.key}:end`, phrase })
  }
  return items
}

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

const sameCall = (a: ToolCall, b: ToolCall): boolean =>
  a.callId === b.callId &&
  a.name === b.name &&
  a.status === b.status &&
  a.output === b.output &&
  sameJson(a.details, b.details) &&
  sameJson(a.args, b.args)

function reuseItem(before: TimelineItem | undefined, item: TimelineItem): TimelineItem {
  if (before === undefined || before.kind !== item.kind) return item
  switch (item.kind) {
    case "text":
      return before.kind === "text" && before.text === item.text && before.streaming === item.streaming ? before : item
    case "tools": {
      if (before.kind !== "tools") return item
      const earlier = new Map(before.calls.map((call) => [call.callId, call]))
      const calls = item.calls.map((call) => {
        const kept = earlier.get(call.callId)
        return kept !== undefined && sameCall(kept, call) ? kept : call
      })
      const unchanged = before.live === item.live && calls.length === before.calls.length && calls.every((call, index) => call === before.calls[index])
      return unchanged ? before : { ...item, calls }
    }
    case "block":
      return before.kind === "block" && sameCall(before.call, item.call) ? before : item
    case "date":
    case "owner":
    case "pass":
    case "summary":
      return sameJson(before, item) ? before : item
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

export function reuseItems(previous: readonly TimelineItem[], next: readonly TimelineItem[]): readonly TimelineItem[] {
  const earlier = new Map(previous.map((item) => [item.key, item]))
  return next.map((item) => reuseItem(earlier.get(item.key), item))
}
