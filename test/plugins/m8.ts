import type { Provider } from "../../src/module.ts"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import type { PluginId } from "../../src/ids.ts"
import { defineOp } from "../../src/ops.ts"
import { definePlugin, type Plugin } from "../../src/plugins/host.ts"

const NONE = { net: [], memory: "none", files: "none" } as const

const faux: FauxProviderHandle = fauxProvider({ provider: "faux-m8", models: [{ id: "m8-1" }] })

export const M8_MODEL = { provider: "faux-m8", modelId: "m8-1" } as const

export const respond = (steps: readonly FauxResponseStep[]): void => faux.setResponses([...steps])

export const tool = (name: string) => fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" })

export const answer = (text: string) => fauxAssistantMessage(text)

const noNet = definePlugin(
  { id: "m8-nonet" as PluginId, version: "0.0.0", requires: [], provides: [], permissions: NONE },
  (host) => {
    const blocked = defineTool({
      name: "m8_fetch",
      description: "Try to reach the network without a net permission.",
      parameters: obj({}),
      execute: async () => {
        try {
          await host.fetch("https://blocked.invalid/")
          return { output: [{ type: "text", text: "reached" }] }
        } catch (error) {
          return {
            output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          }
        }
      },
    })
    return { extensions: [defineExtension({ name: "m8-nonet", tools: [blocked] })] }
  },
)

const broken = definePlugin(
  { id: "m8-broken" as PluginId, version: "0.0.0", requires: [], provides: [], permissions: NONE },
  () => {
    throw new Error("m8 setup exploded")
  },
)

const withSecret = definePlugin(
  {
    id: "m8-secret" as PluginId,
    version: "0.0.0",
    requires: [],
    provides: [],
    permissions: NONE,
    secrets: [
      { key: "TOKEN", label: "Test token" },
      { key: "SECOND", label: "Second token" },
    ],
  },
  (host) => {
    const token = host.secret("TOKEN")
    const echo = defineTool({
      name: "m8_echo_secret",
      description: "Return the plugin's own secret for redaction.",
      parameters: obj({}),
      execute: async () => ({ output: [{ type: "text", text: `token=${token}` }] }),
    })
    return { extensions: [defineExtension({ name: "m8-secret", tools: [echo] })] }
  },
)

const withConfig = definePlugin(
  {
    id: "m8-config" as PluginId,
    version: "0.0.0",
    requires: [],
    provides: [],
    permissions: NONE,
    config: obj({ greeting: opt(str()) }),
  },
  (host) => {
    const greeting = host.config.greeting ?? "hi"
    const greet = defineTool({
      name: "m8_greeting",
      description: "Return the configured greeting.",
      parameters: obj({}),
      execute: async () => ({ output: [{ type: "text", text: greeting }] }),
    })
    const echoConfig = defineOp({
      name: "m8.config_op",
      args: obj({}),
      actors: ["owner"],
      run: async () => host.config.greeting ?? null,
    })
    return { extensions: [defineExtension({ name: "m8-config", tools: [greet] })], ops: [echoConfig] }
  },
)

const coreClash = definePlugin(
  { id: "m8-clash" as PluginId, version: "0.0.0", requires: [], provides: [], permissions: NONE },
  () => ({ ops: [defineOp({ name: "file.list", args: obj({}), actors: ["owner"], run: async () => null })] }),
)

const withReplay = definePlugin(
  { id: "m8-replay" as PluginId, version: "0.0.0", requires: [], provides: [], permissions: NONE },
  (host) => {
    let count = 0
    const counter = defineOp({
      name: "m8.counter",
      args: obj({}),
      actors: ["plugin"],
      run: async () => (count += 1),
    })
    const twice = defineOp({
      name: "m8.replay",
      args: obj({}),
      actors: ["owner"],
      run: async () => {
        const first = await host.ops.run("fixed", "m8.counter")
        const second = await host.ops.run("fixed", "m8.counter")
        return [first.kind === "ok" ? first.result : null, second.kind === "ok" ? second.result : null]
      },
    })
    return { ops: [counter, twice] }
  },
)

export const plugins: readonly Plugin[] = [noNet, broken, withSecret, withConfig, coreClash, withReplay]
export const providers: readonly Provider[] = [faux.provider]
