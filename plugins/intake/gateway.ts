import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { isJsonValue, type JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { type Conversation, LiveDoc } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import {
  type InboundBody,
  type InboundContent,
  type InboundDraft,
  type InboundKind,
  type InboundRecord,
  type IntakeService,
  parseInboundBody,
} from "../../src/contracts/intake.ts"
import type { Notification } from "../../src/contracts/push.ts"
import { type Batch, decide, probe } from "./dispatch.ts"
import type { BatchId, ConversationId } from "../../src/ids.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp } from "../../src/ops.ts"

export type { InboundBody, InboundContent, InboundDraft, InboundKind }
export { parseInboundBody }

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

export function create(deps: ModuleDeps<never>): HostModule {
  const replay: InboundRow[] = []
  const service: IntakeService = {
    enqueue: (draft) => enqueue(deps.db, draft),
    withdraw: (commandId) => withdraw(deps, commandId),
    batch: (batchId) => batchRows(deps.db, batchId),
  }
  return {
    provides: { intake: service },
    ops: [
      defineOp({
        name: "message.send",
        args: obj({
          conv: opt(int({ minimum: 0 })),
          text: str({ minLength: 1 }),
          clientTs: opt(int({ minimum: 0 })),
        }),
        actors: ["owner"],
        run: async (api, args) => {
          const target = await resolve(deps, args.conv)
          const accepted = await enqueue(
            deps.db,
            {
              target,
              commandId: api.commandId,
              kind: "user",
              text: args.text,
              ...(args.clientTs === undefined ? {} : { clientTs: args.clientTs }),
            },
            Date.now(),
          )
          if (accepted) await deps.arm()
          return { accepted }
        },
      }),
      defineOp({
        name: "message.withdraw",
        args: obj({ commandId: str({ minLength: 1 }) }),
        actors: ["owner"],
        run: async (_api, args) => ({ withdrawn: await service.withdraw(args.commandId) }),
      }),
      defineOp({
        name: "conv.stop",
        args: obj({ conv: opt(int({ minimum: 0 })) }),
        actors: ["owner"],
        run: async (_api, args) => {
          const conversation = await conversationOf(deps, args.conv)
          await conversation.abort(context)
          return { stopped: true }
        },
      }),
    ],
    start: async () => {
      const now = Date.now()
      await deps.db.run("DELETE FROM inbound WHERE status = 'done' AND fire_at < ?", now - RETENTION_MS)
      replay.push(...(await recover(deps)))
    },
    due: async () => {
      if (replay.length > 0) return Date.now()
      const row = await deps.db.get<{ at: number | null }>(
        "SELECT MIN(fire_at) AS at FROM inbound WHERE status = 'pending'",
      )
      return row?.at ?? undefined
    },
    fire: async (now) => {
      if (replay.length > 0) await announce(deps.services, replay.splice(0))
      await fire(deps, now)
    },
    typing: async (conversation, on) => {
      if (!on) return
      const now = Date.now()
      const pending = await deps.db.get<{ first: number | null }>(
        "SELECT MIN(first_at) AS first FROM inbound WHERE target = ? AND status = 'pending'",
        conversation,
      )
      if (pending?.first === null || pending?.first === undefined) return
      const fireAt = Math.min(now + DEBOUNCE_MS, pending.first + WINDOW_MS)
      const held = await deps.db.runCounted(
        "UPDATE inbound SET fire_at = ? WHERE target = ? AND status = 'pending'",
        fireAt,
        conversation,
      )
      if (held > 0) await deps.arm()
    },
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

async function withdraw(deps: ModuleDeps<never>, commandId: string): Promise<boolean> {
  const withdrawn = await deps.db.runCounted(
    "DELETE FROM inbound WHERE command_id = ? AND status = 'pending'",
    commandId,
  )
  if (withdrawn > 0) await deps.arm()
  return withdrawn > 0
}

async function batchRows(db: SqliteDatabase, batchId: string): Promise<readonly InboundRecord[]> {
  const rows = await db.all<InboundRow>("SELECT * FROM inbound WHERE batch_id = ? ORDER BY client_ts, id", batchId)
  return rows.map(recordOf)
}

async function recover(deps: ModuleDeps<never>): Promise<readonly InboundRow[]> {
  const claimed = await deps.db.all<InboundRow>(
    "SELECT * FROM inbound WHERE status = 'claimed' AND batch_id IS NOT NULL ORDER BY target, client_ts, id",
  )
  const batches = new Map<string, InboundRow[]>()
  for (const row of claimed) {
    if (row.batch_id === null) continue
    const rows = batches.get(row.batch_id)
    if (rows === undefined) batches.set(row.batch_id, [row])
    else rows.push(row)
  }
  const recovered: InboundRow[] = []
  for (const [batchId, rows] of batches) {
    const target = rows[0]?.target
    const conversation =
      target === undefined ? undefined : await deps.harness().conversation(target as ConversationId, context)
    if (conversation === undefined) {
      await markDone(deps.db, batchId as BatchId)
      continue
    }
    await submit(deps, conversation, batchId as BatchId, rows)
    recovered.push(...rows)
  }
  return recovered
}

async function fire(deps: ModuleDeps<never>, now: number): Promise<void> {
  const targets = await deps.db.all<{ target: number }>(
    "SELECT DISTINCT target FROM inbound WHERE status = 'pending' AND fire_at <= ?",
    now,
  )
  for (const { target } of targets) await dispatch(deps, target, now)
}

async function dispatch(deps: ModuleDeps<never>, target: number, now: number): Promise<void> {
  const batchId = crypto.randomUUID() as BatchId
  const rows = await deps.db.all<InboundRow>(
    "UPDATE inbound SET status = 'claimed', batch_id = ? WHERE target = ? AND status = 'pending' AND fire_at <= ? RETURNING *",
    batchId,
    target,
    now,
  )
  if (rows.length === 0) return
  const conversation = await deps.harness().conversation(target as ConversationId, context)
  if (conversation === undefined) {
    await markDone(deps.db, batchId)
    return
  }
  const pending = ordered(rows)
  const prior = await deps.db.all<InboundRow>(
    "SELECT * FROM inbound WHERE target = ? AND status = 'claimed' AND batch_id <> ? ORDER BY client_ts, id",
    target,
    batchId,
  )
  const mode = decide(probe(await deps.harness().snapshot(LiveDoc, conversation.id, context)), batchOf(pending))
  switch (mode.kind) {
    case "start":
      await submit(deps, conversation, batchId, pending)
      await announce(deps.services, pending)
      return
    case "steer":
      await submit(deps, conversation, batchId, pending, "steer")
      await announce(deps.services, pending)
      return
    case "restart":
      await deps.db.run(
        "UPDATE inbound SET batch_id = ? WHERE target = ? AND status = 'claimed' AND batch_id <> ?",
        batchId,
        target,
        batchId,
      )
      await conversation.abort(context)
      await submit(deps, conversation, batchId, ordered([...prior, ...pending]))
      await announce(deps.services, pending)
      return
    case "stop":
      await deps.db.run("UPDATE inbound SET status = 'done' WHERE target = ? AND status = 'claimed'", target)
      await conversation.abort(context)
      await conversation.submit({ type: "write", entry: { kind: "xin.notice", data: { text: "stopped." } } }, context)
      return
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled dispatch ${JSON.stringify(_exhaustive)}`)
    }
  }
}

async function announce(services: ModuleDeps<never>["services"], rows: readonly InboundRow[]): Promise<void> {
  const push = services.get("push")
  if (push === undefined) return
  for (const row of rows) {
    const notification = notificationOf(row)
    if (notification !== undefined) await push.notify(notification)
  }
}

function notificationOf(row: InboundRow): Notification | undefined {
  if (row.kind !== "report" && row.kind !== "question") return undefined
  const body = bodyOf(row)
  return { threadTitle: body.title, title: body.title, body: body.text, tag: row.command_id }
}

async function submit(
  deps: ModuleDeps<never>,
  conversation: Conversation,
  batchId: BatchId,
  rows: readonly InboundRow[],
  whenBusy?: "steer",
): Promise<void> {
  const submission = await conversation.submit(
    {
      type: "input",
      content: render(rows),
      entry: { kind: "xin.batch", data: rows.map(entryRow) },
      requestId: `batch:${batchId}`,
      ...(whenBusy === undefined ? {} : { whenBusy }),
    },
    context,
  )
  void submission
    .wait(context)
    .then(() => markDone(deps.db, batchId))
    .catch(() => undefined)
}

function markDone(db: SqliteDatabase, batchId: BatchId): Promise<void> {
  return db.run("UPDATE inbound SET status = 'done' WHERE batch_id = ? AND status = 'claimed'", batchId)
}

async function resolve(deps: ModuleDeps<never>, conv: number | undefined): Promise<ConversationId> {
  if (conv === undefined) return (await deps.harness().root(context)).id
  const conversation = await deps.harness().conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation.id
}

async function conversationOf(deps: ModuleDeps<never>, conv: number | undefined): Promise<Conversation> {
  if (conv === undefined) return deps.harness().root(context)
  const conversation = await deps.harness().conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation
}

function contentOf(draft: InboundDraft): InboundContent {
  return draft.kind === "user"
    ? { kind: "user", text: draft.text }
    : { kind: draft.kind, threadId: draft.threadId, title: draft.title, status: draft.status, text: draft.text }
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
        ? { kind: "user", text: body.text }
        : { kind: row.kind, threadId: body.threadId, title: body.title, status: body.status, text: body.text },
  }
}

function ordered(rows: readonly InboundRow[]): InboundRow[] {
  return rows.toSorted((left, right) => left.client_ts - right.client_ts || left.id - right.id)
}

function batchOf(rows: readonly InboundRow[]): Batch {
  return { kinds: rows.map((row) => row.kind), texts: rows.map(textOf) }
}

function render(rows: readonly InboundRow[]): string {
  return rows.map(renderRow).join("\n")
}

function renderRow(row: InboundRow): string {
  const time = new Date(row.client_ts).toISOString().slice(11, 19)
  const body = bodyOf(row)
  if (row.kind === "user") return `<msg t="${time}">${escape(body.text)}</msg>`
  const id = escape(body.threadId)
  const title = escape(body.title)
  const status = escape(body.status)
  return `<thread id="${id}" title="${title}" status="${status}">${body.text}</thread>`
}

function entryRow(row: InboundRow): BatchEntryRow {
  const value: unknown = JSON.parse(row.body)
  return {
    id: row.id,
    kind: row.kind,
    body: isJsonValue(value) ? value : row.body,
    clientTs: row.client_ts,
    ...(row.batch_id === null ? {} : { batchId: row.batch_id }),
  }
}

function textOf(row: InboundRow): string {
  return bodyOf(row).text
}

function bodyOf(row: InboundRow): InboundBody {
  return parseInboundBody(row.body)
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
