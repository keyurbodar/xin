import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc, defineExtension, defineTool, type ModelRef } from "@earendil-works/pi-durable"
import type { Provider } from "../src/module.ts"
import { BUNDLED } from "../src/plugins/bundled.ts"
import * as m2 from "./plugins/m2.ts"
import * as m3 from "./plugins/m3.ts"
import * as m4 from "./plugins/m4.ts"
import * as m5 from "./plugins/m5.ts"
import * as m6 from "./plugins/m6.ts"
import * as m7 from "./plugins/m7.ts"
import * as m8 from "./plugins/m8.ts"
import * as m9 from "./plugins/m9.ts"
import * as mcp from "./plugins/mcp.ts"
import * as skills from "./plugins/skills.ts"
import { definePlugin, type Plugin } from "../src/plugins/host.ts"
import { defineOp } from "../src/ops.ts"
import { int, obj, opt } from "@earendil-works/pi-schema"
import { env } from "cloudflare:workers"
import { Home as ProductHome } from "../src/host.ts"
import type { Env } from "../src/env.ts"
import type { PluginId } from "../src/ids.ts"

export { default } from "../src/worker.ts"

export const Counter = defineDoc<{ count: number }>({
  kind: "test.counter",
  version: 1,
  scope: "session",
  initial: () => ({ count: 0 }),
  checkpointWhen: () => true,
})

const NONE = { net: [], memory: "none", files: "none" } as const

const testPlugin = definePlugin(
  { id: "test" as PluginId, version: "0.0.0", requires: [], provides: ["tool:ping"], permissions: NONE },
  () => {
    const ping = defineTool({
      name: "ping",
      description: "Fetch the echo service once.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => {
        const reply = await env.ECHO.fetch("http://echo/")
        return { output: [{ type: "text", text: await reply.text() }] }
      },
    })
    const bump = defineOp({
      name: "test.bump",
      args: obj({ by: opt(int({ minimum: 1 })) }),
      actors: ["owner"],
      run: async ({ harness }, { by }) =>
        harness.commit(async (tx) => {
          const counter = await tx.doc(Counter)
          counter.count += by ?? 1
          return counter.count
        }, BACKGROUND_CONTEXT),
    })
    return { extensions: [defineExtension({ name: "test.ping", tools: [ping] })], ops: [bump] }
  },
)

const brokenPlugin = definePlugin(
  { id: "broken" as PluginId, version: "0.0.0", requires: ["test"], provides: [], permissions: NONE },
  () => {
    throw new Error("setup exploded")
  },
)

const orphanPlugin = definePlugin(
  { id: "orphan" as PluginId, version: "0.0.0", requires: ["nothing-provides-this"], provides: [], permissions: NONE },
  () => ({}),
)

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const

type Script = { readonly responses: readonly string[]; readonly next: number }

export type TestEnv = Omit<Env, "HOME"> & { readonly HOME: DurableObjectNamespace<Home>; readonly ECHO: Fetcher }

export class Home extends ProductHome {
  readonly hanging = Promise.withResolvers<void>()

  override providers(): readonly Provider[] {
    const faux = fauxProvider()
    faux.setResponses(Array.from({ length: 2000 }, () => this.#step()))
    return [
      faux.provider,
      ...m2.providers,
      ...m3.providers,
      ...m4.providers,
      ...m5.providers,
      ...m6.providers,
      ...m7.providers,
      ...m8.providers,
      ...m9.providers,
      ...skills.providers,
      ...mcp.providers,
    ]
  }

  override plugins(): readonly Plugin[] {
    return [
      ...BUNDLED,
      testPlugin,
      brokenPlugin,
      orphanPlugin,
      ...m2.plugins,
      ...m3.plugins,
      ...m4.plugins,
      ...m5.plugins,
      ...m6.plugins,
      ...m8.plugins,
    ]
  }

  async submit(text: string, requestId: string): Promise<void> {
    await this.arm({ ...this.harness.wake(), active: true })
    await (await this.root()).submit({ type: "input", content: text, requestId }, BACKGROUND_CONTEXT)
  }

  async chooseModel(model: ModelRef): Promise<void> {
    await (await this.root()).configure({ model }, BACKGROUND_CONTEXT)
  }

  script(responses: readonly string[]): void {
    this.ctx.storage.kv.put("test.script", { responses, next: 0 } satisfies Script)
  }

  #step(): FauxResponseStep {
    return (context, options) => {
      const prompt = lastUserText(context.messages)
      const pings = /^ping (\d+)$/.exec(prompt)
      if (pings !== null) {
        const done = context.messages.filter((message) => message.role === "toolResult").length
        const want = Number(pings[1])
        return done < want
          ? fauxAssistantMessage([fauxToolCall("ping", {}, { id: `p${done}` })], { stopReason: "toolUse" })
          : fauxAssistantMessage(`pinged ${done}`)
      }
      const script = this.ctx.storage.kv.get<Script>("test.script") ?? { responses: [], next: 0 }
      const text = script.responses[script.next] ?? "unscripted"
      this.ctx.storage.kv.put("test.script", { ...script, next: script.next + 1 })
      if (text !== "hang") return fauxAssistantMessage(text)
      this.hanging.resolve()
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"))
        if (options?.signal?.aborted) abort()
        else options?.signal?.addEventListener("abort", abort, { once: true })
      })
    }
  }
}

function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
  const user = messages.findLast((message) => message.role === "user")
  if (user === undefined) return ""
  if (typeof user.content === "string") return user.content
  if (!Array.isArray(user.content)) return ""
  return user.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("")
}
