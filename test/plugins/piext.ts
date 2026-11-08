import type { Context } from "@deepseek-ai/cordis"
import { fauxAssistantMessage, type FauxResponseStep, type UserMessage } from "@earendil-works/pi-ai"
import {
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  section,
  type Extension,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"

export const HOOK_MARK = "PIEXT-HOOK-MARK"
export const SECTION_MARK = "PIEXT-SECTION-MARK"
export const WRAP_MARK = "wrapped:"
export const TASK_MARK = "PIEXT-TASK-RAN"

export type Observation = {
  readonly system: string
  readonly users: readonly string[]
}

export const observations: Observation[] = []

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}

export const record =
  (reply: string): FauxResponseStep =>
  (context) => {
    const system: string[] = []
    const users: string[] = []
    const sections = new Map<string, string>()
    for (const message of context.messages) {
      if (message.role === "system") {
        system.push(textOf(message.content))
        for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) sections.delete(key)
          else sections.set(key, value)
        }
      } else if (message.role === "user") users.push(textOf(message.content))
    }
    observations.push({ system: [...system, ...sections.values()].join("\n"), users })
    return fauxAssistantMessage(reply)
  }

export const clearObservations = (): void => {
  observations.splice(0)
}

export const latest = (): Observation => {
  const observation = observations.at(-1)
  if (observation === undefined) throw new Error("the faux model has not been called")
  return observation
}

const hookExtension = defineExtension({
  name: "x-hook",
  hooks: [
    hook(GenerationTask, {
      beforeRequest: (request) => {
        const marker: UserMessage = { role: "user", content: HOOK_MARK, timestamp: Date.now() }
        return { messages: [...request.messages, marker] }
      },
    }),
  ],
})

const sectionExtension = defineExtension({
  name: "x-section",
  sections: [section("x-section", () => SECTION_MARK)],
})

const pingTool: ToolRegistration = {
  name: "ping",
  description: "The test row's tool, wrapped by x-wrap.",
  parameters: obj({}),
  execute: async () => ({ output: [] }),
}

const wrapExtension = defineExtension({
  name: "x-wrap",
  wraps: [
    wrapTool(pingTool, (tool) => ({
      ...tool,
      execute: async (args, api, context) => {
        const result = await tool.execute(args, api, context)
        if (result.output === undefined) return result
        return {
          ...result,
          output: result.output.map((block) =>
            block.type === "text" ? { ...block, text: `${WRAP_MARK}${block.text}` } : block,
          ),
        }
      },
    })),
  ],
})

export const XTask = defineTask<null, { readonly phase: "finish" }, { readonly mark: string }, object>({
  name: "x-task",
  version: 1,
  initial: () => ({ phase: "finish" }),
  phases: {
    finish: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: { mark: TASK_MARK } } }),
        context,
      ),
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
})

const taskExtension = defineExtension({ name: "x-task", tasks: [XTask] })

const installed = (extension: Extension) => ({
  name: extension.name,
  inject: ["pi"],
  apply(ctx: Context) {
    ctx.pi.install(extension)
  },
})

const entry = (plugin: Catalog[string]["plugin"], title: string) => ({
  plugin,
  title,
  description: title,
  source: "test",
})

export const catalog: Catalog = {
  "x-hook": entry(installed(hookExtension), "Extension with a generation hook"),
  "x-wrap": entry(installed(wrapExtension), "Extension wrapping a tool"),
  "x-section": entry(installed(sectionExtension), "Extension with a prompt section"),
  "x-task": entry(installed(taskExtension), "Extension with a task"),
}

export const rows: readonly Row[] = Object.keys(catalog).map((id) => ({ id, name: `cordis:${id}`, disabled: true }))
