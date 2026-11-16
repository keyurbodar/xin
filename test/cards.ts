import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { expect } from "vitest"
import { RequestsDoc } from "../src/contracts/questions.ts"
import { ThreadDoc } from "../src/contracts/threaddoc.ts"
import { threadIdsOfProject, WorkspaceDoc } from "../src/contracts/workspace.ts"
import { M8_MODEL, respond } from "./plugins/m8.ts"
import { cmd, eventually, type Stub, lastOwnerIndex, lastOwnerText, setRow } from "./support.ts"
import type { Home } from "./worker.ts"

const context = BACKGROUND_CONTEXT

/** What one model request carried: the tools it offered and every message, serialised. */
export type Seen = {
  readonly thread: boolean
  readonly brief: string
  readonly tools: readonly string[]
  readonly text: string
}

/** A card tool, the query that finds it, and its row, which ships disabled and each test turns on. */
export type Card = { readonly row: string; readonly search: string; readonly tool: string; readonly args: JsonObject }

export type CardThread = {
  readonly projectId: string
  readonly coordinatorId: number
  readonly threadId: number
  readonly requestId: string
  readonly seen: Seen[]
}

/**
 * One scripted model for a coordinator and its thread. The coordinator delegates "card"; the thread searches for the
 * card tool, calls it, and once the card's result is in its history replies "thread got: <answer>".
 */
function script(card: Card, seen: Seen[]): FauxResponseStep {
  return (request) => {
    const messages = request.messages
    const thread = getCurrentSystemPrompt(messages).includes("You are a thread")
    const brief = lastOwnerText(messages)
    seen.push({
      thread,
      brief,
      tools: getCurrentTools(messages).map((tool) => tool.name),
      text: JSON.stringify(messages),
    })
    const results = messages.slice(lastOwnerIndex(messages) + 1).filter((message) => message.role === "toolResult")
    if (!thread) {
      if (brief.includes("delegate card") && results.length === 0)
        return fauxAssistantMessage(
          [fauxToolCall("delegate_task", { task: "card", title: "Card", mode: "async", clientRequestId: brief })],
          { stopReason: "toolUse" },
        )
      return fauxAssistantMessage("noted")
    }
    const asked = messages.some((message) => message.role === "toolResult" && message.toolName === card.tool)
    if (asked) return fauxAssistantMessage(`thread got: ${brief}`)
    if (results.length === 0)
      return fauxAssistantMessage([fauxToolCall("tool_search", { query: card.search })], { stopReason: "toolUse" })
    return fauxAssistantMessage([fauxToolCall(card.tool, card.args)], { stopReason: "toolUse" })
  }
}

async function onlyThread(home: Home, projectId: string): Promise<number | undefined> {
  const workspace = await home.harness.snapshot(WorkspaceDoc, context)
  return threadIdsOfProject(workspace, projectId)[0]
}

export const threadStatus = async (home: Home, threadId: number): Promise<string | undefined> =>
  (await home.harness.snapshot(ThreadDoc, threadId as ConversationId, context))?.status

/** A thread that has shown `card` and waits on the owner's answer. */
export async function cardThread(stub: Stub, slug: string, card: Card): Promise<CardThread> {
  await setRow(stub, card.row, true)
  const seen: Seen[] = []
  respond(Array.from({ length: 40 }, () => script(card, seen)))
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { id: string; coordinatorId: number }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M8_MODEL }, context)
  })
  const sent = await cmd(stub, `${slug}-send`, "message.send", { conv: project.coordinatorId, text: "delegate card" })
  expect(sent.ok, JSON.stringify(sent)).toBe(true)
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
  await eventually(stub, async (home: Home) => {
    const threadId = await onlyThread(home, project.id)
    return threadId !== undefined && (await threadStatus(home, threadId)) === "waiting"
  })
  const found = await runInDurableObject(stub, async (home: Home) => {
    const threadId = await onlyThread(home, project.id)
    if (threadId === undefined) throw new Error("no thread")
    const requests = await home.harness.snapshot(RequestsDoc, threadId as ConversationId, context)
    return { threadId, requestId: Object.keys(requests?.open ?? {})[0] }
  })
  if (found.requestId === undefined) throw new Error("the thread opened no request")
  return { projectId: project.id, coordinatorId: project.coordinatorId, ...found, requestId: found.requestId, seen }
}

/** Waits for the request of the thread's run that the answer started, and returns it. */
export async function threadReply(stub: Stub, thread: CardThread, answer: string): Promise<Seen> {
  const started = (): Seen | undefined => thread.seen.find((seen) => seen.thread && seen.brief === answer)
  await eventually(stub, async () => started() !== undefined)
  await runInDurableObject(stub, (home: Home) => home.harness.waitForIdle(context))
  const reply = started()
  if (reply === undefined) throw new Error("the answer started no run")
  return reply
}
