import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta"
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { Streams } from "../lib/api.ts"
import { listOf, numOf, recordOf, strOf, stringsOf } from "../lib/parse.ts"

/** The watch's ops are decoded already, but they still crossed a socket: validate before applying. */
function parseOps(events: readonly unknown[]): readonly Op[] {
  for (const op of events) assertValidOp(op)
  return events as readonly Op[]
}


type Record_ = Record<string, unknown>

export type ChatMessage = {
  readonly role: string
  readonly content: unknown
  readonly model?: string
  readonly toolCallId?: string
  readonly threadId?: number
}

export type ToolCallView = {
  readonly id: string | undefined
  readonly name: string
  readonly arguments: Record_
}

export type EntryView = {
  readonly id: number
  readonly kind: string
  readonly model: readonly ChatMessage[]
  readonly data: unknown
}

export type DocView = Readonly<Record<string, unknown>>

export type Snapshot = {
  readonly id: number | undefined
  readonly entries: readonly EntryView[]
  readonly before: number | undefined
  readonly docs: DocView
}

export type BatchKind = "user" | "report" | "question" | "job"

export type Attachment = {
  readonly path: string
  readonly name: string
  readonly type: string
  readonly size: number | undefined
}

export type BatchRow = {
  readonly id: number | undefined
  readonly kind: BatchKind
  readonly text: string
  readonly attachments: readonly Attachment[]
  readonly threadId: string
  readonly title: string
  readonly status: string
  readonly clientTs: number | undefined
}

export type FailureData = {
  readonly reason: string
  readonly error: string
  readonly batchId: string | undefined
}

export type ModelRefView = {
  readonly provider: string
  readonly modelId: string
}

export type RequestRow = {
  readonly id: string
  readonly conversationId: number
  readonly projectId: string
  readonly projectName: string
  readonly threadTitle: string | undefined
  readonly question: string
  readonly options: readonly string[]
  readonly askedAt: number
}

/** An answer this client sent; `request.list` lists only open requests, so the stamped card is local. */
export type AnsweredView = {
  readonly conversationId: number
  readonly question: string
  readonly answer: string
  readonly answeredAt: number
}

export type LiveToolView = {
  readonly callId: string
  readonly name: string
  readonly status: string
  readonly output: string | undefined
}

export type LiveView = {
  readonly busy: boolean
  readonly partial: string
  readonly tools: readonly LiveToolView[]
}

function parseMessage(value: unknown): ChatMessage | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const role = strOf(record.role)
  if (role === undefined) return undefined
  const model = strOf(record.model)
  const toolCallId = role === "toolResult" ? strOf(record.toolCallId) : undefined
  const details = recordOf(record.details)
  const threadId = details === undefined ? undefined : numOf(details.threadId)
  return {
    role,
    content: record.content,
    ...(model === undefined ? {} : { model }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

/** Committed entries never change, so a raw entry keeps its parsed view across snapshots and `For` keeps its DOM. */
const ENTRY_CACHE = new WeakMap<object, EntryView>()

function parseEntry(value: unknown): EntryView | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const id = numOf(record.id)
  const kind = strOf(record.kind)
  if (id === undefined || kind === undefined) return undefined
  const cached = ENTRY_CACHE.get(value as object)
  if (cached !== undefined) return cached
  const model = Array.isArray(record.model)
    ? record.model.map(parseMessage).filter((message): message is ChatMessage => message !== undefined)
    : []
  const entry: EntryView = { id, kind, model, data: record.data }
  ENTRY_CACHE.set(value as object, entry)
  return entry
}

function parseSnapshot(value: unknown): Snapshot | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const conversation = recordOf(record.conversation)
  const entries = Array.isArray(record.entries)
    ? record.entries.map(parseEntry).filter((entry): entry is EntryView => entry !== undefined)
    : []
  const docs = recordOf(record.docs) ?? {}
  return {
    id: conversation === undefined ? undefined : numOf(conversation.id),
    entries,
    before: numOf(record.before),
    docs,
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const part of content) {
    const record = recordOf(part)
    if (record === undefined) continue
    if (record.type === "text" && typeof record.text === "string") text += record.text
  }
  return text
}

export function messageText(message: ChatMessage): string {
  return contentText(message.content)
}

export function entryText(entry: EntryView): string {
  return entry.model
    .map((message) => (message.role === "assistant" || message.role === "user" ? messageText(message) : ""))
    .join("\n")
    .trim()
}

export function entryToolCalls(entry: EntryView): readonly ToolCallView[] {
  const calls: ToolCallView[] = []
  for (const message of entry.model) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const record = recordOf(part)
      if (record === undefined || record.type !== "toolCall") continue
      const name = strOf(record.name)
      const args = recordOf(record.arguments)
      if (name === undefined) continue
      calls.push({ id: strOf(record.id), name, arguments: args ?? {} })
    }
  }
  return calls
}

/** Which thread each `delegate_task` call created, keyed by its call id, so a title is never the link. */
export function delegatedThreads(entries: readonly EntryView[]): ReadonlyMap<string, number> {
  const links = new Map<string, number>()
  for (const entry of entries) {
    for (const message of entry.model) {
      if (message.toolCallId !== undefined && message.threadId !== undefined) links.set(message.toolCallId, message.threadId)
    }
  }
  return links
}

export function parseAttachments(value: unknown): readonly Attachment[] {
  return listOf(value).flatMap((entry) => {
    const raw = recordOf(entry)
    const path = strOf(raw?.path)
    const name = strOf(raw?.name)
    const type = strOf(raw?.type)
    if (path === undefined || name === undefined || type === undefined) return []
    return [{ path, name, type, size: numOf(raw?.size) }]
  })
}

export function entryBatchRows(entry: EntryView): readonly BatchRow[] {
  if (entry.kind !== "xin.batch" || !Array.isArray(entry.data)) return []
  const rows: BatchRow[] = []
  for (const value of entry.data) {
    const raw = recordOf(value)
    if (raw === undefined) continue
    const body = recordOf(raw.body)
    const kind = strOf(body?.kind) ?? strOf(raw.kind)
    if (kind !== "user" && kind !== "report" && kind !== "question" && kind !== "job") continue
    rows.push({
      id: numOf(raw.id),
      kind,
      text: strOf(body?.text) ?? "",
      attachments: parseAttachments(body?.attachments),
      threadId: strOf(body?.threadId) ?? "",
      title: strOf(body?.title) ?? "",
      status: strOf(body?.status) ?? "",
      clientTs: numOf(raw.clientTs),
    })
  }
  return rows
}

export function entryFailure(entry: EntryView): FailureData | undefined {
  if (entry.kind !== "xin.error") return undefined
  const data = recordOf(entry.data)
  if (data === undefined) return undefined
  return {
    reason: strOf(data.reason) ?? "failed",
    error: strOf(data.error) ?? "The turn failed.",
    batchId: strOf(data.batchId),
  }
}

export function liveOf(snapshot: Snapshot | undefined): LiveView {
  const live = recordOf(snapshot?.docs["pi.live"])
  const run = recordOf(live?.run)
  const generation = recordOf(live?.generation)
  const message = recordOf(generation?.message)
  const partial = message === undefined ? "" : contentText(message.content).trim()
  const tools: LiveToolView[] = []
  const slots = live?.tools
  for (const value of Array.isArray(slots) ? slots : []) {
    const tool = recordOf(value)
    if (tool === undefined) continue
    const callId = strOf(tool.callId)
    const name = strOf(tool.name)
    if (callId === undefined || name === undefined) continue
    tools.push({ callId, name, status: strOf(tool.status) ?? "running", output: strOf(tool.output) })
  }
  return { busy: run !== undefined, partial, tools }
}

export function agentModelOf(snapshot: Snapshot | undefined): ModelRefView | undefined {
  const agent = recordOf(snapshot?.docs["pi.agent"])
  const model = recordOf(agent?.model)
  const provider = strOf(model?.provider)
  const modelId = strOf(model?.modelId)
  return provider === undefined || modelId === undefined ? undefined : { provider, modelId }
}

export type ThinkingLevel = "off" | "low" | "medium" | "high"

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"]

const isThinkingLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value)

/** The thinking level the conversation's agent runs at, or undefined when it uses the model's own default. */
export function agentThinkingOf(snapshot: Snapshot | undefined): ThinkingLevel | undefined {
  const agent = recordOf(snapshot?.docs["pi.agent"])
  const value = strOf(agent?.thinkingLevel)
  return value !== undefined && isThinkingLevel(value) ? value : undefined
}

export type HistoryPage = { readonly entries: readonly EntryView[]; readonly nextBefore: number | undefined }

export function parseHistoryPage(value: unknown): HistoryPage {
  const record = recordOf(value)
  const list = record?.entries
  const entries = Array.isArray(list)
    ? list.map(parseEntry).filter((entry): entry is EntryView => entry !== undefined)
    : []
  return { entries, nextBefore: record === undefined ? undefined : numOf(record.nextBefore) }
}

export function parseRequestList(value: unknown): readonly RequestRow[] {
  const record = recordOf(value)
  const list = record?.requests
  if (!Array.isArray(list)) return []
  const rows: RequestRow[] = []
  for (const entry of list) {
    const raw = recordOf(entry)
    if (raw === undefined) continue
    const id = strOf(raw.id)
    const conversationId = numOf(raw.conversationId)
    const question = strOf(raw.question)
    const askedAt = numOf(raw.askedAt)
    if (id === undefined || conversationId === undefined || question === undefined || askedAt === undefined) continue
    rows.push({
      id,
      conversationId,
      projectId: strOf(raw.projectId) ?? "",
      projectName: strOf(raw.projectName) ?? "",
      threadTitle: strOf(raw.threadTitle),
      question,
      options: stringsOf(raw.options),
      askedAt,
    })
  }
  return rows
}

/**
 * Subscribe to one conversation's stream and expose the parsed snapshot. Passing a new id resubscribes; passing
 * `undefined` releases it. Solid owns the effect, so the screen's scope cleans it up.
 */
export function createConversationView(
  streams: Streams,
  id: Accessor<number | undefined>,
): Accessor<Snapshot | undefined> {
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>()
  let current: unknown = undefined
  let subscribed: number | undefined
  let unsubscribe: (() => void) | undefined

  createEffect(() => {
    const next = id()
    if (next === subscribed) return
    subscribed = next
    unsubscribe?.()
    unsubscribe = undefined
    current = undefined
    setSnapshot(undefined)
    if (next === undefined) return
    unsubscribe = streams.subscribe(`conv:${next}`, {
      value: (value) => {
        current = value
        setSnapshot(parseSnapshot(current))
      },
      delta: (events) => {
        current = applyImmutable(current, parseOps(events))
        setSnapshot(parseSnapshot(current))
      },
    })
  })

  onCleanup(() => unsubscribe?.())
  return snapshot
}
