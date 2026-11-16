import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  AgentDoc,
  type CommitObserver,
  type ConversationId,
  GenerationTask,
  type Harness,
  hook,
  type HookRegistration,
  type ModelRef,
} from "@earendil-works/pi-durable"
import { compile, num, obj, opt, str } from "@earendil-works/pi-schema"

const context = BACKGROUND_CONTEXT
export const FALLBACK_KIND = "xin.fallback"

const LiveSchema = obj(
  { runFailure: opt(obj({ taskId: num(), reason: str(), detail: opt(str()) }, { open: true })) },
  { open: true },
)
const liveCheck = compile(LiveSchema)

export type FallbackPorts = {
  readonly harness: Harness
  /** The owner's fallback order, held in memory. */
  order(): readonly ModelRef[]
  /** Whether a stored key unlocks `ref` and the owner has not switched it off. */
  usable(ref: ModelRef): Promise<boolean>
  /** Whether the conversation's feature is under its caps. */
  admitted(conversation: ConversationId): Promise<boolean>
  /** Switch the conversation's model the way `conv.configure` does; true when it was switched. */
  configure(conversation: ConversationId, model: ModelRef, commandId: string): Promise<boolean>
}

export type Fallbacks = {
  readonly hook: HookRegistration
  start(): () => void
}

const keyOf = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`

/**
 * When a run fails on a model error, after pi's own retries, move the conversation to the next model in the owner's
 * fallback order and continue the run there, with a `xin.fallback` entry naming both models. Each failure streak
 * tries every fallback at most once; a successful response on the conversation ends the streak. The switch sticks.
 */
export function createFallbacks(ports: FallbackPorts): Fallbacks {
  const tried = new Map<ConversationId, Set<string>>()
  const handled = new Set<string>()
  const pending = new Map<ConversationId, { readonly taskId: number; readonly detail: string }>()
  let scheduled = false

  const fallBack = async (conversationId: ConversationId, taskId: number, detail: string): Promise<void> => {
    const from = (await ports.harness.snapshot(AgentDoc, conversationId, context))?.model
    if (from === undefined) return
    const streak = tried.get(conversationId) ?? new Set<string>()
    tried.set(conversationId, streak)
    streak.add(keyOf(from))
    let to: ModelRef | undefined
    for (const candidate of ports.order()) {
      if (streak.has(keyOf(candidate)) || !(await ports.usable(candidate))) continue
      to = candidate
      break
    }
    if (to === undefined || !(await ports.admitted(conversationId))) return
    streak.add(keyOf(to))
    const id = `fallback:${conversationId}:${taskId}`
    if (!(await ports.configure(conversationId, to, id))) return
    const conversation = await ports.harness.conversation(conversationId, context)
    if (conversation === undefined) return
    await conversation.submit(
      { type: "write", requestId: id, entry: { kind: FALLBACK_KIND, data: { from, to, error: detail.slice(0, 300) } } },
      context,
    )
    await conversation.submit({ type: "continue" }, context)
  }

  const drain = async (): Promise<void> => {
    const work = [...pending]
    pending.clear()
    for (const [conversationId, failure] of work) await fallBack(conversationId, failure.taskId, failure.detail)
  }

  const observer: CommitObserver = {
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.kind !== "change") continue
        if (change.record.kind !== "pi.live" || change.conversationId === undefined) continue
        if (!liveCheck.check(change.value)) continue
        const failure = change.value.runFailure
        if (failure?.reason !== "model_error") continue
        const key = `${change.conversationId}:${failure.taskId}`
        if (handled.has(key)) continue
        handled.add(key)
        pending.set(change.conversationId, { taskId: failure.taskId, detail: failure.detail ?? "" })
      }
      if (pending.size === 0 || scheduled || ports.order().length === 0) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        void drain().catch((error: unknown) => console.warn("models: fallback failed", error))
      })
    },
    end: () => undefined,
  }

  return {
    hook: hook(GenerationTask, {
      afterResponse: (message, api) => {
        if (message.stopReason !== "error" && message.stopReason !== "aborted") tried.delete(api.conversationId)
      },
    }),
    start: () => {
      const observation = ports.harness.observeCommits(observer)
      return () => observation.detach()
    },
  }
}
