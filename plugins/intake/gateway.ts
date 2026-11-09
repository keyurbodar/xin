import { copyJson, type Draft, type JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type Conversation, type Harness, LiveDoc, type Wake } from "@earendil-works/pi-durable"
import {
  type InboundBody,
  type InboundContent,
  type InboundDraft,
  type InboundKind,
  type InboundRecord,
  type IntakeBatch,
  type IntakeBatchResult,
  type IntakeBatchRow,
  IntakeDoc,
  type IntakeItem,
  type IntakeService,
  parseInboundBody,
} from "../../src/contracts/intake.ts"
import type { Notification, NotifyKind, NotifyPrefs, PushService } from "../../src/contracts/push.ts"
import type { MessageAttachment } from "../../src/contracts/message.ts"
import type { BatchId, ConversationId } from "../../src/ids.ts"
import { renderTurn } from "./attachments.ts"
import { type Batch, decide, probe } from "./dispatch.ts"

const context = BACKGROUND_CONTEXT
const DEBOUNCE_MS = 2_000
const WINDOW_MS = 8_000
const RETENTION_MS = 7 * 24 * 60 * 60_000

type BatchEntryRow = {
  readonly id: number
  readonly kind: InboundKind
  readonly body: JsonValue
  readonly clientTs: number
  readonly batchId?: string
}

type Post = IntakeBatchRow & { readonly batchId: string | null }

export type BatchLedger = {
  processed(batchId: string): boolean
  mark(batchId: string): void
  forget(batchId: string): void
  ids(): readonly string[]
}

export type IntakeHost = {
  readonly harness: Harness
  readonly ledger: BatchLedger
  readBytes(path: string): Promise<Uint8Array | undefined>
  stat(path: string): Promise<{ readonly size: number } | undefined>
  vision(conversation: ConversationId): Promise<boolean>
  arm(wake?: Wake): Promise<void>
  push(): PushService | undefined
  batchEvent(batch: IntakeBatch, next: () => Promise<IntakeBatchResult>): Promise<IntakeBatchResult>
}

export type Gateway = {
  readonly intake: IntakeService
  start(): Promise<void>
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
  typing(conversation: ConversationId, on: boolean): Promise<void>
}

export function createGateway(host: IntakeHost): Gateway {
  const replay: BatchId[] = []
  return {
    intake: {
      enqueue: (draft) => enqueue(host, draft),
      withdraw: (commandId) => withdraw(host, commandId),
      batch: (batchId) => batchRows(host, batchId),
    },
    start: () => start(host, replay),
    due: () => due(host, replay),
    fire: (now) => fire(host, replay, now),
    typing: (conversation, on) => typing(host, conversation, on),
  }
}

async function snapshot(host: Pick<IntakeHost, "harness">): Promise<readonly IntakeItem[]> {
  const state = await host.harness.snapshot(IntakeDoc, context)
  return state?.items ?? []
}

export async function enqueue(
  host: Pick<IntakeHost, "harness">,
  draft: InboundDraft,
  now = Date.now(),
): Promise<boolean> {
  return host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    if (doc.items.some((item) => item.commandId === draft.commandId)) return false
    const pending = doc.items.filter((item) => item.target === draft.target && item.status === "pending")
    const first = pending.length === 0 ? now : Math.min(...pending.map((item) => item.firstAt))
    const fireAt = Math.min(now + DEBOUNCE_MS, first + WINDOW_MS)
    for (const item of pending) item.fireAt = fireAt
    doc.items.push({
      id: doc.nextId,
      target: draft.target,
      kind: draft.kind,
      commandId: draft.commandId,
      body: JSON.stringify(contentOf(draft)),
      clientTs: draft.clientTs ?? now,
      firstAt: first,
      fireAt,
      status: "pending",
      batchId: null,
    })
    doc.nextId += 1
    return true
  }, context)
}

export async function resolve(host: IntakeHost, conv: number | undefined): Promise<ConversationId> {
  if (conv === undefined) return (await host.harness.root(context)).id
  const conversation = await host.harness.conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation.id
}

export async function stop(host: IntakeHost, conv: number | undefined): Promise<void> {
  const conversation = await conversationOf(host, conv)
  await conversation.abort(context)
}

async function withdraw(host: IntakeHost, commandId: string): Promise<boolean> {
  const withdrawn = await host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    const index = doc.items.findIndex((item) => item.commandId === commandId && item.status === "pending")
    if (index === -1) return false
    doc.items.splice(index, 1)
    return true
  }, context)
  if (withdrawn) await host.arm()
  return withdrawn
}

async function batchRows(host: IntakeHost, batchId: string): Promise<readonly InboundRecord[]> {
  return (await snapshot(host))
    .filter((item) => item.batchId === batchId)
    .toSorted(compareItems)
    .map(recordOf)
}

async function start(host: IntakeHost, replay: BatchId[]): Promise<void> {
  const items = await snapshot(host)
  const cutoff = Date.now() - RETENTION_MS
  const expired = (item: IntakeItem): boolean => item.status === "done" && item.fireAt < cutoff
  if (items.some(expired)) {
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(IntakeDoc)
      for (let index = doc.items.length - 1; index >= 0; index -= 1) {
        const item = doc.items[index]
        if (item !== undefined && expired(item)) doc.items.splice(index, 1)
      }
    }, context)
  }
  const claimed = new Set<string>()
  for (const item of items) if (item.status === "claimed" && item.batchId !== null) claimed.add(item.batchId)
  for (const batchId of [...claimed].toSorted()) replay.push(batchId as BatchId)
  await prune(
    host,
    items.filter((item) => !expired(item)),
  )
}

async function prune(host: IntakeHost, items: readonly IntakeItem[]): Promise<void> {
  const live = new Set(items.flatMap((item) => (item.batchId === null ? [] : [item.batchId])))
  for (const batchId of host.ledger.ids()) if (!live.has(batchId)) host.ledger.forget(batchId)
}

async function due(host: IntakeHost, replay: readonly BatchId[]): Promise<number | undefined> {
  if (replay.length > 0) return Date.now()
  const pending = (await snapshot(host)).filter((item) => item.status === "pending")
  return pending.length === 0 ? undefined : Math.min(...pending.map((item) => item.fireAt))
}

async function fire(host: IntakeHost, replay: BatchId[], now: number): Promise<void> {
  for (const batchId of replay.splice(0)) await resume(host, batchId)
  await fireDue(host, now)
}

async function resume(host: IntakeHost, batchId: BatchId): Promise<void> {
  const rows = (await snapshot(host)).filter((item) => item.batchId === batchId && item.status === "claimed")
  const target = rows[0]?.target
  if (target === undefined) {
    host.ledger.forget(batchId)
    return
  }
  const conversation = await host.harness.conversation(target as ConversationId, context)
  if (conversation === undefined) {
    await finish(host, batchId)
    return
  }
  const batch = claimedBatch(batchId, target as ConversationId, rows)
  if (host.ledger.processed(batchId)) {
    await submit(
      host,
      conversation,
      batchId,
      batch.rows.map((row) => postOf(row, batchId)),
    )
    await announce(host, batch)
    return
  }
  const result = await host.batchEvent(batch, async () => {
    await persist(host, batch)
    await submit(
      host,
      conversation,
      batchId,
      batch.rows.map((row) => postOf(row, batchId)),
    )
    await announce(host, batch)
    return { kind: "dispatched" }
  })
  if (result.kind === "dropped") await finish(host, batchId)
}

async function typing(host: IntakeHost, conversation: ConversationId, on: boolean): Promise<void> {
  if (!on) return
  const now = Date.now()
  const pending = (await snapshot(host)).filter((item) => item.target === conversation && item.status === "pending")
  if (pending.length === 0) return
  const fireAt = Math.min(now + DEBOUNCE_MS, Math.min(...pending.map((item) => item.firstAt)) + WINDOW_MS)
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    for (const item of doc.items) {
      if (item.target === conversation && item.status === "pending") item.fireAt = fireAt
    }
  }, context)
  await host.arm()
}

async function fireDue(host: IntakeHost, now: number): Promise<void> {
  const targets = new Set<number>()
  for (const item of await snapshot(host)) if (item.status === "pending" && item.fireAt <= now) targets.add(item.target)
  for (const target of targets) await dispatch(host, target, now)
}

async function dispatch(host: IntakeHost, target: number, now: number): Promise<void> {
  const batchId = crypto.randomUUID() as BatchId
  const rows = await host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    const ready = doc.items.filter((item) => item.target === target && item.status === "pending" && item.fireAt <= now)
    for (const item of ready) {
      item.status = "claimed"
      item.batchId = batchId
    }
    return ready.map(copyItem)
  }, context)
  if (rows.length === 0) return
  const conversation = await host.harness.conversation(target as ConversationId, context)
  if (conversation === undefined) {
    await finish(host, batchId)
    return
  }
  const batch = claimedBatch(batchId, target as ConversationId, rows)
  const result = await host.batchEvent(batch, async () => {
    await persist(host, batch)
    await dispatchBatch(host, conversation, batch)
    return { kind: "dispatched" }
  })
  if (result.kind === "dropped") await finish(host, batchId)
}

async function persist(host: IntakeHost, batch: IntakeBatch): Promise<void> {
  const kept = new Map(batch.rows.map((row) => [row.id, row]))
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    for (const item of doc.items) {
      if (item.batchId !== batch.batchId || item.status !== "claimed") continue
      const row = kept.get(item.id)
      if (row === undefined) {
        item.status = "done"
        continue
      }
      const body = JSON.stringify(contentOfRow(row))
      if (body !== item.body) item.body = body
    }
  }, context)
  host.ledger.mark(batch.batchId)
}

async function dispatchBatch(host: IntakeHost, conversation: Conversation, batch: IntakeBatch): Promise<void> {
  const live = probe(await host.harness.snapshot(LiveDoc, conversation.id, context))
  const mode = decide(live, batchOf(batch.rows))
  const posts = batch.rows.map((row) => postOf(row, batch.batchId))
  switch (mode.kind) {
    case "start":
      await submit(host, conversation, batch.batchId, posts)
      await announce(host, batch)
      return
    case "steer":
      await submit(host, conversation, batch.batchId, posts, "steer")
      await announce(host, batch)
      return
    case "restart": {
      const restart = await host.harness.commit(async (tx) => {
        const doc = await tx.doc(IntakeDoc)
        const prior: IntakeItem[] = []
        const merged = new Set<string>()
        for (const item of doc.items) {
          if (item.target !== batch.target || item.status !== "claimed" || item.batchId === batch.batchId) continue
          if (item.batchId !== null) merged.add(item.batchId)
          prior.push(copyItem(item))
          item.batchId = batch.batchId
        }
        return { rows: prior.toSorted(compareItems), merged: [...merged] }
      }, context)
      for (const batchId of restart.merged) host.ledger.forget(batchId)
      await conversation.abort(context)
      const restarted = [...restart.rows.map((item) => postOf(batchRowOf(item), item.batchId)), ...posts]
      await submit(host, conversation, batch.batchId, ordered(restarted))
      await announce(host, batch)
      return
    }
    case "stop": {
      const merged = await host.harness.commit(async (tx) => {
        const doc = await tx.doc(IntakeDoc)
        const batchIds = new Set<string>()
        for (const item of doc.items) {
          if (item.target !== batch.target || item.status !== "claimed") continue
          if (item.batchId !== null) batchIds.add(item.batchId)
          item.status = "done"
        }
        return [...batchIds]
      }, context)
      for (const batchId of merged) host.ledger.forget(batchId)
      await conversation.abort(context)
      await conversation.submit({ type: "write", entry: { kind: "xin.notice", data: { text: "stopped." } } }, context)
      return
    }
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled dispatch ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function announce(host: IntakeHost, batch: IntakeBatch): Promise<void> {
  const push = host.push()
  if (push === undefined) return
  const prefs = await push.prefs()
  for (const row of batch.rows) {
    const found = notificationOf(prefs, row)
    if (found !== undefined) await push.notify(found)
  }
}

export function notificationOf(prefs: NotifyPrefs, row: IntakeBatchRow): Notification | undefined {
  switch (row.kind) {
    case "user":
    case "job":
      return undefined
    case "question":
      return prefs.waiting ? notification(row, "waiting") : undefined
    case "report": {
      const kind: NotifyKind = row.status === "failed" ? "failed" : "finished"
      return prefs[kind] ? notification(row, kind) : undefined
    }
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

function notification(
  row: { readonly title: string; readonly text: string; readonly commandId: string },
  kind: NotifyKind,
): Notification {
  return { threadTitle: row.title, title: row.title, body: row.text, tag: row.commandId, kind }
}

async function submit(
  host: IntakeHost,
  conversation: Conversation,
  batchId: BatchId,
  posts: readonly Post[],
  whenBusy?: "steer",
): Promise<void> {
  const submission = await conversation.submit(
    {
      type: "input",
      content: await renderTurn(host, conversation.id, render(posts), attachmentsOf(posts)),
      entry: { kind: "xin.batch", data: posts.map(entryRow) },
      requestId: `batch:${batchId}`,
      ...(whenBusy === undefined ? {} : { whenBusy }),
    },
    context,
  )
  void submission
    .wait(context)
    .then(() => finish(host, batchId))
    .catch(() => undefined)
}

async function finish(host: IntakeHost, batchId: BatchId): Promise<void> {
  await markDone(host, batchId)
  host.ledger.forget(batchId)
}

async function markDone(host: IntakeHost, batchId: BatchId): Promise<void> {
  await host.harness.commit(async (tx) => {
    const doc = await tx.doc(IntakeDoc)
    for (const item of doc.items) if (item.batchId === batchId && item.status === "claimed") item.status = "done"
  }, context)
}

async function conversationOf(host: IntakeHost, conv: number | undefined): Promise<Conversation> {
  if (conv === undefined) return host.harness.root(context)
  const conversation = await host.harness.conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation
}

function copyItem(item: Draft<IntakeItem>): IntakeItem {
  return {
    id: item.id,
    target: item.target,
    kind: item.kind,
    commandId: item.commandId,
    body: item.body,
    clientTs: item.clientTs,
    firstAt: item.firstAt,
    fireAt: item.fireAt,
    status: item.status,
    batchId: item.batchId,
  }
}

function compareItems(left: IntakeItem, right: IntakeItem): number {
  return left.clientTs - right.clientTs || left.id - right.id
}

function claimedBatch(batchId: BatchId, target: ConversationId, items: readonly IntakeItem[]): IntakeBatch {
  return { batchId, target, rows: [...items].toSorted(compareItems).map(batchRowOf) }
}

function batchRowOf(item: IntakeItem): IntakeBatchRow {
  const body = bodyOf(item)
  return item.kind === "user"
    ? {
        id: item.id,
        kind: "user",
        clientTs: item.clientTs,
        commandId: item.commandId,
        text: body.text,
        attachments: body.attachments,
        stored: item.body,
      }
    : {
        id: item.id,
        kind: item.kind,
        clientTs: item.clientTs,
        commandId: item.commandId,
        threadId: body.threadId,
        title: body.title,
        status: body.status,
        text: body.text,
        stored: item.body,
      }
}

function postOf(row: IntakeBatchRow, batchId: string | null): Post {
  return { ...row, batchId }
}

function contentOf(draft: InboundDraft): InboundContent {
  return draft.kind === "user"
    ? { kind: "user", text: draft.text, attachments: draft.attachments }
    : { kind: draft.kind, threadId: draft.threadId, title: draft.title, status: draft.status, text: draft.text }
}

function contentOfRow(row: IntakeBatchRow): InboundContent {
  return row.kind === "user"
    ? { kind: "user", text: row.text, attachments: row.attachments }
    : { kind: row.kind, threadId: row.threadId, title: row.title, status: row.status, text: row.text }
}

function recordOf(item: IntakeItem): InboundRecord {
  const body = bodyOf(item)
  return {
    id: item.id,
    target: item.target as ConversationId,
    kind: item.kind,
    commandId: item.commandId,
    clientTs: item.clientTs,
    content:
      item.kind === "user"
        ? { kind: "user", text: body.text, attachments: body.attachments }
        : { kind: item.kind, threadId: body.threadId, title: body.title, status: body.status, text: body.text },
  }
}

function ordered(posts: readonly Post[]): Post[] {
  return posts.toSorted((left, right) => left.clientTs - right.clientTs || left.id - right.id)
}

function batchOf(rows: readonly IntakeBatchRow[]): Batch {
  return { kinds: rows.map((row) => row.kind), texts: rows.map((row) => row.text) }
}

function render(posts: readonly Post[]): string {
  return posts.map(renderPost).join("\n")
}

function attachmentsOf(posts: readonly Post[]): readonly MessageAttachment[] {
  return posts.flatMap((post) => (post.kind === "user" ? post.attachments : []))
}

function renderPost(post: Post): string {
  const time = new Date(post.clientTs).toISOString().slice(11, 19)
  if (post.kind === "user") return `<msg t="${time}">${escape(post.text)}</msg>`
  const id = escape(post.threadId)
  const title = escape(post.title)
  const status = escape(post.status)
  return `<thread id="${id}" title="${title}" status="${status}">${post.text}</thread>`
}

function entryRow(post: Post): BatchEntryRow {
  return {
    id: post.id,
    kind: post.kind,
    body: copyJson(contentOfRow(post)),
    clientTs: post.clientTs,
    ...(post.batchId === null ? {} : { batchId: post.batchId }),
  }
}

function bodyOf(item: IntakeItem): InboundBody {
  return parseInboundBody(item.body)
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
