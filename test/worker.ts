import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc, defineExtension, defineTool, type ModelRef } from "@earendil-works/pi-durable"
import type { Provider } from "../src/module.ts"
import * as fakefiles from "./plugins/fakefiles.ts"
import * as fakedeploy from "./plugins/fakedeploy.ts"
import * as intakebatch from "./plugins/intakebatch.ts"
import * as m2 from "./plugins/m2.ts"
import * as m3 from "./plugins/m3.ts"
import * as m4 from "./plugins/m4.ts"
import * as m5 from "./plugins/m5.ts"
import * as m6 from "./plugins/m6.ts"
import * as m7 from "./plugins/m7.ts"
import * as m8 from "./plugins/m8.ts"
import * as m9 from "./plugins/m9.ts"
import * as mcp from "./plugins/mcp.ts"
import * as p6 from "./plugins/p6.ts"
import * as piext from "./plugins/piext.ts"
import * as secretsTest from "./plugins/secrets.ts"
import * as settled from "./plugins/settled.ts"
import * as skills from "./plugins/skills.ts"
import type { Composition, Catalog } from "../src/kernel/loader.ts"
import type { Extension } from "@earendil-works/pi-durable"
import { testPlugin } from "./kernel.ts"
import { lastOwnerText } from "./support.ts"
import { defineOp } from "../src/ops.ts"
import { int, obj, opt } from "@earendil-works/pi-schema"
import { env } from "cloudflare:workers"
import { BUNDLES, CATALOG } from "../src/catalog.ts"
import { XIN_VERSION } from "../src/catalog.gen.ts"
import { Home as ProductHome, PROFILE } from "../src/host.ts"
import type { Env } from "../src/env.ts"

export { default } from "../src/worker.ts"

export const Counter = defineDoc<{ count: number }>({
  kind: "test.counter",
  version: 1,
  scope: "session",
  initial: () => ({ count: 0 }),
  checkpointWhen: () => true,
})

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

const TEST_CATALOG: Catalog = {
  test: testPlugin("test", { extensions: [defineExtension({ name: "tool-test-ping", tools: [ping] })], ops: [bump] }),
  broken: {
    ...testPlugin("broken", {}),
    plugin: {
      name: "broken",
      inject: ["pi"],
      apply() {
        throw new Error("setup exploded")
      },
    },
  },
  orphan: testPlugin("orphan", {}, ["nothing-provides-this"]),
  ...m2.catalog,
  ...fakefiles.catalog,
  ...intakebatch.catalog,
  ...fakedeploy.catalog,
  ...m3.catalog,
  ...m4.catalog,
  ...m5.catalog,
  ...m6.catalog,
  ...m7.catalog,
  ...m8.catalog,
  ...m9.catalog,
  ...p6.catalog,
  ...skills.catalog,
  ...mcp.catalog,
  ...piext.catalog,
  ...secretsTest.catalog,
  ...settled.catalog,
}

const TEST_ROWS = [
  ...["test", "broken", "orphan", "m2", "m6"].map((id) => ({ id, name: `cordis:${id}` })),
  ...m8.rows,
  ...piext.rows,
  ...intakebatch.rows,
  ...secretsTest.rows,
  ...settled.rows,
]

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

  protected override composition(): Composition {
    return {
      catalog: { ...CATALOG, ...TEST_CATALOG },
      bundles: { ...BUNDLES, test: TEST_ROWS },
      profile: { bundles: [...PROFILE.bundles, "test"], patch: PROFILE.patch },
      version: XIN_VERSION,
    }
  }

  extension(name: string): Extension {
    const installed = this.loader.ctx.pi.installed.get(name)
    if (installed === undefined) throw new Error(`extension ${name} is not installed`)
    return installed.extension
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
      const prompt = lastOwnerText(context.messages)
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
