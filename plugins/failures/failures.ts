import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import {
  type CommitObserver,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable"
import { arr, compile, int, num, obj, opt, str } from "@earendil-works/pi-schema"
import type { InboundKind } from "../intake/dispatch.ts"
import { type InboundDraft, enqueue, parseInboundBody } from "../intake/gateway.ts"
import type { HostModule, ModuleDeps } from "../../src/module.ts"
import { defineOp, OpRejected } from "../../src/ops.ts"
import { WorkspaceDoc } from "../workspace/workspace.ts"

const context = BACKGROUND_CONTEXT
const ERROR_KIND = "xin.error"

const FailureSchema = obj({ taskId: num(), reason: str(), detail: opt(str()), inputs: opt(arr(num())) }, { open: true })
const LiveSchema = obj({ runFailure: opt(FailureSchema) }, { open: true })
const liveCheck = compile(LiveSchema)

const REPORTABLE: ReadonlySet<string> = new Set([
  "model_error",
  "no_model",
  "faulted",
  "interrupted",
  "restart_limit",
  "orphaned",
])

type Failure = {
  readonly taskId: number
  readonly reason: string
  readonly detail?: string
  readonly inputs?: readonly number[]
}

type RetryRow = {
  readonly id: number
  readonly target: number
  readonly kind: InboundKind
  readonly body: string
  readonly client_ts: number
}

function errorText(failure: Failure): string {
  switch (failure.reason) {
    case "no_model":
      return "No model is set. Pick a model in the model picker, then retry."
    case "model_error":
      return `The model call failed: ${failure.detail ?? "the provider returned an error"}`
    case "interrupted":
      return `The run stopped before it answered: ${failure.detail ?? "the process stopped"}`
    case "restart_limit":
      return `The run kept stopping: ${failure.detail ?? "restart limit reached"}`
    case "faulted":
      return `The run crashed: ${failure.detail ?? "internal error"}`
    case "orphaned":
      return `The run could not continue: ${failure.detail ?? "its task is not registered"}`
    default:
      return failure.reason
  }
}

function stringData(value: JsonValue | undefined, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

function retryDraft(row: RetryRow, commandId: string): InboundDraft | undefined {
  const body = parseInboundBody(row.body)
  const base = { target: row.target as ConversationId, commandId, clientTs: row.client_ts }
  switch (row.kind) {
    case "user":
      return { ...base, kind: "user", text: body.text }
    case "report":
    case "question":
    case "job": {
      if (body.threadId === "" || body.title === "" || body.status === "") return undefined
      return {
        ...base,
        kind: row.kind,
        threadId: body.threadId,
        title: body.title,
        status: body.status,
        text: body.text,
      }
    }
    default: {
      const _exhaustive: never = row.kind
      return _exhaustive
    }
  }
}

const coordinatorIds = async (harness: Harness): Promise<ReadonlySet<ConversationId>> => {
  const ids = new Set<ConversationId>([ROOT_CONVERSATION_ID])
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  for (const project of Object.values(workspace?.projects ?? {})) ids.add(project.coordinatorId as ConversationId)
  return ids
}

export function create(deps: ModuleDeps): HostModule {
  const pending = new Map<ConversationId, Failure>()
  let scheduled = false

  const batchIdOf = async (entries: readonly EntryRecord[]): Promise<string | undefined> => {
    for (const entry of entries) {
      if (entry.kind !== "xin.batch" || !Array.isArray(entry.data)) continue
      const first: unknown = entry.data[0]
      const id = typeof first === "object" && first !== null ? Reflect.get(first, "id") : undefined
      if (typeof id !== "number") continue
      const row = await deps.db.get<{ batch_id: string | null }>("SELECT batch_id FROM inbound WHERE id = ?", id)
      if (row?.batch_id !== null && row?.batch_id !== undefined) return row.batch_id
    }
    return undefined
  }

  const commitError = async (harness: Harness, conversationId: ConversationId, failure: Failure): Promise<void> => {
    const conversation = await harness.conversation(conversationId, context)
    if (conversation === undefined) return
    const batchId = await batchIdOf((await conversation.entries({ order: "descending" }, 50, undefined, context)).items)
    await conversation.submit(
      {
        type: "write",
        requestId: `error:${conversationId}:${failure.taskId}`,
        entry: {
          kind: ERROR_KIND,
          data: {
            taskId: failure.taskId,
            reason: failure.reason,
            error: errorText(failure),
            ...(batchId === undefined ? {} : { batchId }),
          },
        },
      },
      context,
    )
  }

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    const work = [...pending]
    pending.clear()
    const harness = deps.harness()
    const coordinators = await coordinatorIds(harness)
    for (const [conversationId, failure] of work) {
      if (!coordinators.has(conversationId) || !REPORTABLE.has(failure.reason)) continue
      await commitError(harness, conversationId, failure)
    }
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void drain().catch((failure: unknown) => console.warn("failures: error entry failed", failure))
    })
  }

  const observe: CommitObserver = {
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change") continue
        if (change.record.kind !== "pi.live" || change.conversationId === undefined) continue
        if (!liveCheck.check(change.value)) continue
        const failure = change.value.runFailure
        if (failure === undefined) continue
        pending.set(change.conversationId, failure)
      }
      if (pending.size > 0) schedule()
    },
    end: () => undefined,
  }

  const retryMessage = defineOp({
    name: "message.retry",
    args: obj({ entryId: int({ minimum: 0 }) }),
    actors: ["owner"],
    run: async (api, args) => {
      const entry = await api.harness.commit((tx) => tx.entry(args.entryId as EntryId), context)
      if (entry === undefined || entry.kind !== ERROR_KIND) {
        throw new OpRejected("bad_args", `entry ${args.entryId} is not a failed turn`)
      }
      const batchId = stringData(entry.data, "batchId")
      if (batchId === undefined) return { resubmitted: 0 }
      const rows = await deps.db.all<RetryRow>(
        "SELECT id, target, kind, body, client_ts FROM inbound WHERE batch_id = ? ORDER BY client_ts, id",
        batchId,
      )
      let resubmitted = 0
      for (const row of rows) {
        const draft = retryDraft(row, `retry:${args.entryId}:${row.id}`)
        if (draft !== undefined && (await enqueue(deps.db, draft))) resubmitted += 1
      }
      if (resubmitted > 0) await deps.arm()
      return { resubmitted }
    },
  })

  return {
    ops: [retryMessage],
    async start() {
      const harness = deps.harness()
      const observation = harness.observeCommits(observe)
      for (const conversationId of await coordinatorIds(harness)) {
        const live = await harness.snapshot(LiveDoc, conversationId, context)
        if (live?.runFailure !== undefined) pending.set(conversationId, live.runFailure)
      }
      if (pending.size > 0) schedule()
      return () => observation.detach()
    },
  }
}
