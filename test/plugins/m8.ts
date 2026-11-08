import type { Context } from "@deepseek-ai/cordis"
import Schema from "@deepseek-ai/schemastery"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj } from "@earendil-works/pi-schema"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"
import type { Provider } from "../../src/module.ts"
import { defineOp } from "../../src/ops.ts"

const faux: FauxProviderHandle = fauxProvider({ provider: "faux-m8", models: [{ id: "m8-1" }] })

export const M8_MODEL = { provider: "faux-m8", modelId: "m8-1" } as const

export const respond = (steps: readonly FauxResponseStep[]): void => faux.setResponses([...steps])

export const tool = (name: string) => fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" })

export const answer = (text: string) => fauxAssistantMessage(text)

export const providers: readonly Provider[] = [faux.provider]

const entry = (plugin: CatalogPlugin, title: string) => ({
  plugin,
  title,
  description: title,
  source: "test",
})

type CatalogPlugin = Catalog[string]["plugin"]

const greeting = {
  name: "k-config",
  inject: ["pi", "ops"],
  Config: Schema.object({ greeting: Schema.string().default("hi") }),
  apply(ctx: Context, config: { greeting: string }) {
    ctx.pi.install(
      defineExtension({
        name: "tool-k-config",
        tools: [
          defineTool({
            name: "k_greeting",
            description: "Return the configured greeting.",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text", text: config.greeting }] }),
          }),
        ],
      }),
    )
    ctx.ops.define(defineOp({ name: "k.greeting", args: obj({}), actors: ["owner"], run: async () => config.greeting }))
  },
}

const broken = {
  name: "k-broken",
  inject: ["pi"],
  apply() {
    throw new Error("k setup exploded")
  },
}

const harnessBroken = {
  name: "k-harness-broken",
  inject: ["harness"],
  apply() {
    throw new Error("k harness exploded")
  },
}

const clash = {
  name: "k-clash",
  inject: ["ops"],
  apply(ctx: Context) {
    ctx.ops.define(defineOp({ name: "file.list", args: obj({}), actors: ["owner"], run: async () => null }))
  },
}

const policy = {
  name: "k-policy",
  inject: ["ops"],
  apply(ctx: Context) {
    ctx.on("ops/before", async (call, next) => {
      const args: unknown = call.command.args
      const by = typeof args === "object" && args !== null ? Reflect.get(args, "by") : undefined
      return call.command.op === "test.bump" && by === 13
        ? { kind: "rejected", code: "forbidden", message: "13 is unlucky" }
        : next()
    })
  },
}

const ready = {
  name: "k-ready",
  inject: ["host", "harness"],
  apply(ctx: Context) {
    const kv = ctx.host.state.storage.kv
    kv.put("k-ready", (kv.get<number>("k-ready") ?? 0) + 1)
  },
}

const deployer = {
  name: "k-deployer",
  inject: ["host"],
  apply(ctx: Context) {
    ctx.provide("deployer", {
      deploy: async () => {
        const kv = ctx.host.state.storage.kv
        kv.put("k-deploys", (kv.get<number>("k-deploys") ?? 0) + 1)
        return { application: "deploying" as const, detail: "fake deployer" }
      },
    })
  },
}

export const catalog: Catalog = {
  "k-config": entry(greeting, "Config test"),
  "k-broken": entry(broken, "Broken test"),
  "k-harness-broken": entry(harnessBroken, "Harness broken test"),
  "k-clash": entry(clash, "Clash test"),
  "k-policy": entry(policy, "Policy test"),
  "k-ready": entry(ready, "Ready test"),
  "k-deployer": entry(deployer, "Fake deployer"),
}

export const rows: readonly Row[] = ["k-config", "k-broken", "k-harness-broken", "k-policy"].map((id) => ({
  id,
  name: `cordis:${id}`,
}))
