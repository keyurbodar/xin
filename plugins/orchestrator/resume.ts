import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { CommitObserver, ConversationId, Harness } from "@earendil-works/pi-durable"
import { compile, int, num, obj, opt, str } from "@earendil-works/pi-schema"
import { capReason } from "../../src/contracts/models.ts"
import { ThreadDoc } from "../../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import { openRun, submitOpened, type ReportFn, type ThreadDeps } from "./threads.ts"

const context = BACKGROUND_CONTEXT

const pendingCheck = compile(
  obj({ resume: opt(obj({ run: int({ minimum: 1 }), at: num(), reason: str() }, { open: true })) }, { open: true }),
)

export type ResumeDeps = Pick<ThreadDeps, "harness" | "watchdog" | "disabled" | "admitConversation">

export type Resumer = {
  due(): Promise<number | undefined>
  fire(now: number): Promise<void>
  start(): Promise<() => void>
}

/**
 * Fires the one automatic resume a transient failure scheduled on `xin.thread.resume`. The due times live in memory,
 * fed by the commit stream and seeded from the space lists at boot, so an arm reads no documents. The resume reopens
 * the thread through the same path as `thread.send`, and the commit that opens run N+1 also clears `resume` and sets
 * `resumedRun`, so a replay or a second alarm finds nothing to do.
 */
export function resumer(deps: ResumeDeps, report: ReportFn): Resumer {
  const pending = new Map<number, number>()

  const track = (threadId: number, value: unknown): void => {
    if (!pendingCheck.check(value)) return
    if (value.resume === undefined) pending.delete(threadId)
    else pending.set(threadId, value.resume.at)
  }

  const observe: CommitObserver = {
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change") continue
        if (change.record.kind !== "xin.thread" || change.conversationId === undefined) continue
        track(change.conversationId, change.value)
      }
    },
    end: () => undefined,
  }

  const blockedReason = async (harness: Harness, threadId: ConversationId): Promise<string | undefined> => {
    const conversation = await harness.conversation(threadId, context)
    if (conversation === undefined) return "its conversation is gone"
    const model = (await conversation.agent(context)).model
    if (model !== undefined && (await deps.disabled(model))) return "its model is disabled"
    const admission = await deps.admitConversation(threadId)
    return admission.kind === "capped" ? capReason(admission) : undefined
  }

  const resume = async (threadId: number): Promise<void> => {
    const harness = deps.harness
    const id = threadId as ConversationId
    const scheduled = (await harness.snapshot(ThreadDoc, id, context))?.resume
    if (scheduled === undefined) {
      pending.delete(threadId)
      return
    }
    const blocked = await blockedReason(harness, id)
    const args = {
      threadId,
      text: `Resume: the last run failed with ${scheduled.reason}. Continue where you stopped.`,
      sendKey: `resume:${threadId}:${scheduled.run}`,
    }
    const opened = await harness.commit(async (tx) => {
      const thread = await tx.doc(ThreadDoc, id)
      if (thread.resume?.run !== scheduled.run) return false
      if (blocked !== undefined || thread.status !== "failed" || (thread.run ?? 1) !== scheduled.run) {
        delete thread.resume
        return false
      }
      const outcome = await openRun(deps, tx, args, report)
      if (outcome.kind !== "opened") {
        delete thread.resume
        return false
      }
      thread.resumedRun = outcome.run
      return true
    }, context)
    if (blocked !== undefined) console.warn(`threads: resume of ${threadId} skipped: ${blocked}`)
    if (opened) await submitOpened(harness, args)
  }

  return {
    due: async () => (pending.size === 0 ? undefined : Math.min(...pending.values())),
    async fire(now) {
      for (const [threadId, at] of pending) if (at <= now) await resume(threadId)
    },
    async start() {
      const harness = deps.harness
      const observation = harness.observeCommits(observe)
      const workspace = await harness.snapshot(WorkspaceDoc, context)
      for (const space of Object.values(workspace?.spaces ?? {})) {
        for (const threadId of space.threadIds)
          track(threadId, await harness.snapshot(ThreadDoc, threadId as ConversationId, context))
      }
      return () => observation.detach()
    },
  }
}
