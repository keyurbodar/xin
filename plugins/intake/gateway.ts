import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { isJsonValue, type JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import { type Conversation, LiveDoc } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import { type Batch, decide, type InboundKind, probe } from "./dispatch.ts"
import type { BatchId, ConversationId } from "../../src/ids.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp } from "../../src/ops.ts"
import { notifier, type Notifier, type Notification } from "../push/push.ts"

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

export type InboundContent =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "report" | "question" | "job"
      readonly threadId: string
      readonly title: string
      readonly status: string
      readonly text: string
    }

export type InboundDraft = {
  readonly target: ConversationId
  readonly commandId: string
  readonly clientTs?: number
} & InboundContent

type BatchEntryRow = {
  readonly id: number
  readonly kind: InboundKind
  readonly body: JsonValue
  readonly clientTs: number
}

export function create(deps: ModuleDeps): HostModule {
  const push = notifier(deps)
  return {
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
        run: async (_api, args) => {
          const withdrawn = await deps.db.runCounted(
            "DELETE FROM inbound WHERE command_id = ? AND status = 'pending'",
            args.commandId,
          )
          if (withdrawn > 0) await deps.arm()
          return { withdrawn: withdrawn > 0 }
        },
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
      await recover(deps, push)
      await fire(deps, now, push)
    },
    due: async () => {
      const row = await deps.db.get<{ at: number | null }>(
        "SELECT MIN(fire_at) AS at FROM inbound WHERE status = 'pending'",
      )
      return row?.at ?? undefined
    },
    fire: (now) => fire(deps, now, push),
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

async function recover(deps: ModuleDeps, push: Notifier): Promise<void> {
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
  for (const [batchId, rows] of batches) {
    const target = rows[0]?.target
    const conversation =
      target === undefined ? undefined : await deps.harness().conversation(target as ConversationId, context)
    if (conversation === undefined) {
      await markDone(deps.db, batchId as BatchId)
      continue
    }
    await submit(deps, conversation, batchId as BatchId, rows)
    await announce(push, rows)
  }
}

async function fire(deps: ModuleDeps, now: number, push: Notifier): Promise<void> {
  const targets = await deps.db.all<{ target: number }>(
    "SELECT DISTINCT target FROM inbound WHERE status = 'pending' AND fire_at <= ?",
    now,
  )
  for (const { target } of targets) await dispatch(deps, target, now, push)
}

async function dispatch(deps: ModuleDeps, target: number, now: number, push: Notifier): Promise<void> {
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
      await announce(push, pending)
      return
    case "steer":
      await submit(deps, conversation, batchId, pending, "steer")
      await announce(push, pending)
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
      await announce(push, pending)
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

async function announce(push: Notifier, rows: readonly InboundRow[]): Promise<void> {
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
  deps: ModuleDeps,
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

async function resolve(deps: ModuleDeps, conv: number | undefined): Promise<ConversationId> {
  if (conv === undefined) return (await deps.harness().root(context)).id
  const conversation = await deps.harness().conversation(conv as ConversationId, context)
  if (conversation === undefined) throw new Error(`no conversation ${conv}`)
  return conversation.id
}

async function conversationOf(deps: ModuleDeps, conv: number | undefined): Promise<Conversation> {
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
  return { id: row.id, kind: row.kind, body: isJsonValue(value) ? value : row.body, clientTs: row.client_ts }
}

function textOf(row: InboundRow): string {
  return bodyOf(row).text
}

export type InboundBody = {
  readonly text: string
  readonly threadId: string
  readonly title: string
  readonly status: string
}

export function parseInboundBody(body: string): InboundBody {
  const value: unknown = JSON.parse(body)
  return {
    text: stringField(value, "text") ?? body,
    threadId: stringField(value, "threadId") ?? "",
    title: stringField(value, "title") ?? "",
    status: stringField(value, "status") ?? "",
  }
}

function bodyOf(row: InboundRow): InboundBody {
  return parseInboundBody(row.body)
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
