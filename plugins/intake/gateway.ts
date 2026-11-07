import { copyJson, type JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
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

type InboundStatus = "pending" | "claimed" | "done"

type InboundRow = {
  readonly id: number
  readonly target: number
  readonly kind: InboundKind
  readonly command_id: string
  readonly body: string
  readonly client_ts: number
  readonly first_at: number
  readonly fire_at: number
  readonly status: InboundStatus
  readonly batch_id: string | null
}

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
  readonly db: SqliteDatabase
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
      enqueue: (draft) => enqueue(host.db, draft),
      withdraw: (commandId) => withdraw(host, commandId),
      batch: (batchId) => batchRows(host.db, batchId),
    },
    start: () => start(host, replay),
    due: () => due(host, replay),
    fire: (now) => fire(host, replay, now),
    typing: (conversation, on) => typing(host, conversation, on),
  }
}

export async function enqueue(db: SqliteDatabase, draft: InboundDraft, now = Date.now()): Promise<boolean> {
  const pending = await db.get<{ first: number | null }>(
    "SELECT MIN(first_at) AS first FROM inbound WHERE target = ? AND status = 'pending'",
    draft.target,
  )
  const first = pending?.first ?? now
  const fireAt = Math.min(now + DEBOUNCE_MS, first + WINDOW_MS)
  const inserted = await db.all<{ id: number }>(
    "INSERT OR IGNORE INTO inbound (target, kind, command_id, body, client_ts, first_at, fire_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id",
    draft.target,
    draft.kind,
    draft.commandId,
    JSON.stringify(contentOf(draft)),
    draft.clientTs ?? now,
    first,
    fireAt,
  )
  if (inserted.length === 0) return false
  await db.run("UPDATE inbound SET fire_at = ? WHERE target = ? AND status = 'pending'", fireAt, draft.target)
  return true
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
  const withdrawn = await host.db.runCounted(
    "DELETE FROM inbound WHERE command_id = ? AND status = 'pending'",
    commandId,
  )
  if (withdrawn > 0) await host.arm()
  return withdrawn > 0
}

async function batchRows(db: SqliteDatabase, batchId: string): Promise<readonly InboundRecord[]> {
  const rows = await db.all<InboundRow>("SELECT * FROM inbound WHERE batch_id = ? ORDER BY client_ts, id", batchId)
  return rows.map(recordOf)
}

async function start(host: IntakeHost, replay: BatchId[]): Promise<void> {
  await host.db.run("DELETE FROM inbound WHERE status = 'done' AND fire_at < ?", Date.now() - RETENTION_MS)
  const claimed = await host.db.all<{ batch_id: string }>(
    "SELECT DISTINCT batch_id FROM inbound WHERE status = 'claimed' AND batch_id IS NOT NULL ORDER BY batch_id",
  )
  replay.push(...claimed.map((row) => row.batch_id as BatchId))
  await prune(host)
}

async function prune(host: IntakeHost): Promise<void> {
  for (const batchId of host.ledger.ids()) {
    const live = await host.db.get<{ id: number }>("SELECT id FROM inbound WHERE batch_id = ? LIMIT 1", batchId)
    if (live === undefined) host.ledger.forget(batchId)
  }
}

async function due(host: IntakeHost, replay: readonly BatchId[]): Promise<number | undefined> {
  if (replay.length > 0) return Date.now()
  const row = await host.db.get<{ at: number | null }>(
    "SELECT MIN(fire_at) AS at FROM inbound WHERE status = 'pending'",
  )
  return row?.at ?? undefined
}

async function fire(host: IntakeHost, replay: BatchId[], now: number): Promise<void> {
  for (const batchId of replay.splice(0)) await resume(host, batchId)
  await fireDue(host, now)
}

async function resume(host: IntakeHost, batchId: BatchId): Promise<void> {
  const rows = await host.db.all<InboundRow>(
    "SELECT * FROM inbound WHERE batch_id = ? AND status = 'claimed' ORDER BY client_ts, id",
    batchId,
  )
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
  const pending = await host.db.get<{ first: number | null }>(
    "SELECT MIN(first_at) AS first FROM inbound WHERE target = ? AND status = 'pending'",
    conversation,
  )
  if (pending?.first === null || pending?.first === undefined) return
  const fireAt = Math.min(now + DEBOUNCE_MS, pending.first + WINDOW_MS)
  const held = await host.db.runCounted(
    "UPDATE inbound SET fire_at = ? WHERE target = ? AND status = 'pending'",
    fireAt,
    conversation,
  )
  if (held > 0) await host.arm()
}

async function fireDue(host: IntakeHost, now: number): Promise<void> {
  const targets = await host.db.all<{ target: number }>(
    "SELECT DISTINCT target FROM inbound WHERE status = 'pending' AND fire_at <= ?",
    now,
  )
  for (const { target } of targets) await dispatch(host, target, now)
}

async function dispatch(host: IntakeHost, target: number, now: number): Promise<void> {
  const batchId = crypto.randomUUID() as BatchId
  const rows = await host.db.all<InboundRow>(
    "UPDATE inbound SET status = 'claimed', batch_id = ? WHERE target = ? AND status = 'pending' AND fire_at <= ? RETURNING *",
    batchId,
    target,
    now,
  )
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
  for (const row of batch.rows) {
    await host.db.run("UPDATE inbound SET body = ? WHERE id = ?", JSON.stringify(contentOfRow(row)), row.id)
  }
  const kept = new Set(batch.rows.map((row) => row.id))
  const stored = await host.db.all<{ id: number }>(
    "SELECT id FROM inbound WHERE batch_id = ? AND status = 'claimed'",
    batch.batchId,
  )
  for (const row of stored) {
    if (!kept.has(row.id)) await host.db.run("UPDATE inbound SET status = 'done' WHERE id = ?", row.id)
  }
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
      const prior = await host.db.all<InboundRow>(
        "SELECT * FROM inbound WHERE target = ? AND status = 'claimed' AND batch_id <> ? ORDER BY client_ts, id",
        batch.target,
        batch.batchId,
      )
      const merged = new Set(prior.flatMap((row) => (row.batch_id === null ? [] : [row.batch_id])))
      await host.db.run(
        "UPDATE inbound SET batch_id = ? WHERE target = ? AND status = 'claimed' AND batch_id <> ?",
        batch.batchId,
        batch.target,
        batch.batchId,
      )
      for (const batchId of merged) host.ledger.forget(batchId)
      await conversation.abort(context)
      const restarted = [...prior.map((row) => postOf(batchRowOf(row), row.batch_id)), ...posts]
      await submit(host, conversation, batch.batchId, ordered(restarted))
      await announce(host, batch)
      return
    }
    case "stop": {
      const claimed = await host.db.all<{ batch_id: string | null }>(
        "SELECT DISTINCT batch_id FROM inbound WHERE target = ? AND status = 'claimed'",
        batch.target,
      )
      await host.db.run("UPDATE inbound SET status = 'done' WHERE target = ? AND status = 'claimed'", batch.target)
      for (const row of claimed) {
        if (row.batch_id !== null) host.ledger.forget(row.batch_id)
      }
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
      return prefs.waiting ? notification(row) : undefined
    case "report": {
      const kind: NotifyKind = row.status === "failed" ? "failed" : "finished"
      return prefs[kind] ? notification(row) : undefined
    }
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

function notification(row: { readonly title: string; readonly text: string; readonly commandId: string }): Notification {
  return { threadTitle: row.title, title: row.title, body: row.text, tag: row.commandId }
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
  await markDone(host.db, batchId)
  host.ledger.forget(batchId)
}

function markDone(db: SqliteDatabase, batchId: BatchId): Promise<void> {
  return db.run("UPDATE inbound SET status = 'done' WHERE batch_id = ? AND status = 'claimed'", batchId)
}

async function conversationOf(host: IntakeHost, conv: number | undefined): Promise<Conversation> {
  if (conv === undefined) return host.harness.root(context)
  const conversation = await host.harness.conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation
}

function claimedBatch(batchId: BatchId, target: ConversationId, rows: readonly InboundRow[]): IntakeBatch {
  return { batchId, target, rows: orderedRows(rows).map(batchRowOf) }
}

function orderedRows(rows: readonly InboundRow[]): InboundRow[] {
  return rows.toSorted((left, right) => left.client_ts - right.client_ts || left.id - right.id)
}

function batchRowOf(row: InboundRow): IntakeBatchRow {
  const body = bodyOf(row)
  return row.kind === "user"
    ? {
        id: row.id,
        kind: "user",
        clientTs: row.client_ts,
        commandId: row.command_id,
        text: body.text,
        attachments: body.attachments,
      }
    : {
        id: row.id,
        kind: row.kind,
        clientTs: row.client_ts,
        commandId: row.command_id,
        threadId: body.threadId,
        title: body.title,
        status: body.status,
        text: body.text,
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

function recordOf(row: InboundRow): InboundRecord {
  const body = bodyOf(row)
  return {
    id: row.id,
    target: row.target as ConversationId,
    kind: row.kind,
    commandId: row.command_id,
    clientTs: row.client_ts,
    content:
      row.kind === "user"
        ? { kind: "user", text: body.text, attachments: body.attachments }
        : { kind: row.kind, threadId: body.threadId, title: body.title, status: body.status, text: body.text },
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

function bodyOf(row: InboundRow): InboundBody {
  return parseInboundBody(row.body)
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
