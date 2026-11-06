import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import { jobTool } from "../../src/jobs.ts"
import type { Provider } from "../../src/module.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import { testPlugin } from "../kernel.ts"

export const M6_MODEL = { provider: "m6", modelId: "m6-faux" } as const

const faux = fauxProvider({ provider: "m6", models: [{ id: "m6-faux", name: "M6 Faux" }] })

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException("interrupted", "AbortError"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

function lastUserText(messages: readonly { readonly role: string; readonly content: unknown }[]): string {
  const user = messages.findLast((message) => message.role === "user")
  return user === undefined ? "" : textOf(user)
}

function sectionsText(messages: readonly { readonly role: string }[]): string {
  return messages
    .flatMap((message) => {
      if (message.role !== "system") return []
      const sections: unknown = Reflect.get(message, "sections")
      if (typeof sections !== "object" || sections === null) return []
      return Object.values(sections).filter((value): value is string => typeof value === "string")
    })
    .join("\n")
}

const quick = jobTool(
  { name: "quick_tool", description: "Finish after one second.", parameters: obj({}) },
  async (_args, run) => {
    await sleep(1_000, run.signal)
    return { output: [{ type: "text", text: "quick done" }] }
  },
)

const slow = jobTool(
  { name: "slow_tool", description: "Finish after twenty seconds.", parameters: obj({}) },
  async (_args, run) => {
    await sleep(20_000, run.signal)
    return { output: [{ type: "text", text: "slow done" }] }
  },
)

const threadSlow = jobTool(
  { name: "thread_slow_tool", description: "Finish after nine seconds.", parameters: obj({}) },
  async (_args, run) => {
    await sleep(9_000, run.signal)
    return { output: [{ type: "text", text: "thread slow done" }] }
  },
)

const stuck = defineTool({
  name: "stuck_tool",
  description: "Never finishes.",
  parameters: obj({}),
  replay: "safe",
  execute: (_args, _api, context) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("interrupted", "AbortError"))
      if (context.abortSignal?.aborted === true) abort()
      else context.abortSignal?.addEventListener("abort", abort, { once: true })
    }),
})

const step: FauxResponseStep = async (context) => {
  const messages = context.messages
  if (sectionsText(messages).includes("You are a thread")) {
    const brief = lastUserText(messages)
    const lastUser = messages.findLastIndex((message) => message.role === "user")
    if (messages.slice(lastUser + 1).some((message) => message.role === "toolResult"))
      return fauxAssistantMessage(`thread answer: ${brief}`)
    if (brief.includes("ask"))
      return fauxAssistantMessage(
        [fauxToolCall("ask_user", { question: "Which color?", options: ["red", "blue"] }, { id: `ask-${brief}` })],
        { stopReason: "toolUse" },
      )
    if (brief.includes("stuck"))
      return fauxAssistantMessage([fauxToolCall("stuck_tool", {}, { id: `stuck-${brief}` })], { stopReason: "toolUse" })
    if (brief.includes("quick"))
      return fauxAssistantMessage([fauxToolCall("quick_tool", {}, { id: `quick-${brief}` })], {
        stopReason: "toolUse",
      })
    if (brief.includes("slow"))
      return fauxAssistantMessage([fauxToolCall("thread_slow_tool", {}, { id: `slow-${brief}` })], {
        stopReason: "toolUse",
      })
    return fauxAssistantMessage(`thread answer: ${brief}`)
  }
  const prompt = lastUserText(messages)
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  const results = messages.slice(lastUser + 1).filter((message) => message.role === "toolResult")
  if (prompt.includes("Which color") && results.length === 0)
    return fauxAssistantMessage(
      [fauxToolCall("pending_request", { action: "respond", answer: "blue" }, { id: "answer-question" })],
      { stopReason: "toolUse" },
    )
  if (results.length > 0) return fauxAssistantMessage("noted")
  if (prompt.includes("delegate")) {
    const task = prompt.replace(/^delegate\s*/, "")
    return fauxAssistantMessage(
      [
        fauxToolCall(
          "delegate_task",
          { task, title: `Thread ${task}`, mode: "async", clientRequestId: prompt },
          { id: `delegate-${prompt}` },
        ),
      ],
      { stopReason: "toolUse" },
    )
  }
  if (prompt.includes("quick tool"))
    return fauxAssistantMessage([fauxToolCall("quick_tool", {}, { id: "quick-call" })], { stopReason: "toolUse" })
  if (prompt.includes("slow tool"))
    return fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: "slow-call" })], { stopReason: "toolUse" })
  return fauxAssistantMessage("noted")
}

faux.setResponses(Array.from({ length: 4_000 }, () => step))

export const providers: readonly Provider[] = [faux.provider]
export const catalog: Catalog = {
  m6: testPlugin("m6", {
    extensions: [defineExtension({ name: "m6.tools", tools: [quick, slow, threadSlow, stuck] })],
  }),
}
