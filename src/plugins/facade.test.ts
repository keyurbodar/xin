import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import type { CommandId, PluginId } from "../ids.ts"
import type { Command } from "../ops.ts"
import { type HostExtras, type Manifest, type PluginOps, pluginHost } from "./host.ts"
import { answer, M8_MODEL, respond, tool } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type ToolResult = { readonly name: string; readonly isError: boolean; readonly text: string }
type Transcript = { readonly tools: readonly ToolResult[]; readonly answers: readonly string[] }

const command = (op: string, args: unknown): Command => ({ id: crypto.randomUUID() as CommandId, op, args })

const owner = { kind: "owner" } as const

const texts = (content: unknown): string[] =>
  Array.isArray(content)
    ? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    : typeof content === "string"
      ? [content]
      : []

const transcript = (records: readonly EntryRecord[]): Transcript => ({
  tools: records.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult"
        ? [{ name: message.toolName, isError: message.isError, text: texts(message.content).join("") }]
        : [],
    ),
  ),
  answers: records.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => (message.role === "assistant" ? texts(message.content) : [])),
  ),
})

const history = async (conversation: Conversation): Promise<Transcript> =>
  transcript((await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items)

async function turn(home: Home, text: string, steps: Parameters<typeof respond>[0]): Promise<Transcript> {
  respond(steps)
  await home.chooseModel(M8_MODEL)
  await home.submit(text, crypto.randomUUID())
  await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  return history(await home.root())
}

const manifest = (net: string[] = []): Manifest => ({
  id: "probe" as PluginId,
  version: "0.0.0",
  requires: [],
  provides: [],
  permissions: { net, memory: "none", files: "none" },
})

const noOps: PluginOps["run"] = async (_key, name) => ({
  kind: "rejected",
  code: "unknown_op",
  message: `no op ${name}`,
})
const extras: HostExtras = { config: {}, run: noOps }
const hostFor = (net: string[], fetcher: typeof fetch) => pluginHost(manifest(net), fetcher, extras)

describe("plugin facade", () => {
  it("never reaches the network for a host outside the net permission", async () => {
    let fetched = 0
    const fetcher = async () => {
      fetched++
      return new Response("ok")
    }
    const host = hostFor([], fetcher)
    await expect(host.fetch("https://blocked.invalid/")).rejects.toThrow("no net permission for blocked.invalid")
    expect(fetched).toBe(0)
    const allowed = hostFor(["blocked.invalid"], fetcher)
    expect(await (await allowed.fetch("https://blocked.invalid/")).text()).toBe("ok")
  })

  it("turns a denied fetch into a tool error without touching the network", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, (home: Home) =>
      turn(home, "fetch it", [tool("m8_fetch"), answer("gave up")]),
    )
    expect(outcome.tools).toEqual([
      { name: "m8_fetch", isError: true, text: expect.stringContaining("no net permission") },
    ])
  })

  it("keeps a broken plugin isolated while the object serves", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const states = Object.fromEntries(home.reconciled.states)
      const served = await turn(home, "hello", [answer("still serving")])
      return { states, served }
    })
    expect(outcome.states).toMatchObject({
      "m8-broken": { kind: "failed", error: "m8 setup exploded" },
      "m8-nonet": { kind: "active" },
      "m8-config": { kind: "active" },
    })
    expect(outcome.served.answers).toEqual(["still serving"])
  })

  it("seals a plugin secret and redacts it from tool output before it is stored", async () => {
    const secret = "m8-super-secret-value-123"
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const set = await home.commands.run(
        command("plugin.secret.set", { id: "m8-secret", key: "TOKEN", value: secret }),
        owner,
      )
      const row = await home.db.get<{ sealed: string | null }>("SELECT sealed FROM plugins WHERE id = ?", "m8-secret")
      const state = home.reconciled.states.get("m8-secret" as PluginId)
      const logged = await turn(home, "echo the token", [tool("m8_echo_secret"), answer("done")])
      return { set, sealed: row?.sealed ?? "", state, logged }
    })
    expect(outcome.set.kind).toBe("ok")
    expect(outcome.state).toEqual({ kind: "active" })
    expect(outcome.sealed).not.toBe("")
    expect(outcome.sealed).not.toContain(secret)
    expect(outcome.logged.tools).toEqual([{ name: "m8_echo_secret", isError: false, text: "token=[redacted]" }])
  })

  it("re-installs a plugin when its config changes", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const before = await turn(home, "greet", [tool("m8_greeting"), answer("ok")])
      const configure = await home.commands.run(
        command("plugin.configure", { id: "m8-config", config: { greeting: "hello" } }),
        owner,
      )
      const after = await turn(home, "greet again", [tool("m8_greeting"), answer("ok")])
      return { before, configure, after }
    })
    expect(outcome.before.tools.at(-1)).toEqual({ name: "m8_greeting", isError: false, text: "hi" })
    expect(outcome.configure.kind).toBe("ok")
    expect(outcome.after.tools.at(-1)).toEqual({ name: "m8_greeting", isError: false, text: "hello" })
  })

  it("removes a disabled plugin's tools and ops, and restores them on re-enable", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const before = await home.commands.run(command("m8.config_op", {}), owner)
      const disable = await home.commands.run(command("plugin.enable", { id: "m8-config", enabled: false }), owner)
      const afterDisable = {
        op: await home.commands.run(command("m8.config_op", {}), owner),
        state: home.reconciled.states.get("m8-config" as PluginId),
        extensions: home.reconciled.extensions.map((extension) => extension.name),
      }
      const enable = await home.commands.run(command("plugin.enable", { id: "m8-config", enabled: true }), owner)
      const afterEnable = {
        op: await home.commands.run(command("m8.config_op", {}), owner),
        state: home.reconciled.states.get("m8-config" as PluginId),
        extensions: home.reconciled.extensions.map((extension) => extension.name),
      }
      return { before, disable, afterDisable, enable, afterEnable }
    })
    expect(outcome.before.kind).toBe("ok")
    expect(outcome.disable.kind).toBe("ok")
    expect(outcome.afterDisable.state).toEqual({ kind: "disabled" })
    expect(outcome.afterDisable.extensions).not.toContain("m8-config")
    expect(outcome.afterDisable.op).toMatchObject({ kind: "rejected", code: "unknown_op" })
    expect(outcome.enable.kind).toBe("ok")
    expect(outcome.afterEnable.state).toEqual({ kind: "active" })
    expect(outcome.afterEnable.extensions).toContain("m8-config")
    expect(outcome.afterEnable.op.kind).toBe("ok")
  })

  it("rejects a config the manifest schema refuses", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(command("plugin.configure", { id: "m8-config", config: { greeting: 7 } }), owner),
    )
    expect(outcome).toMatchObject({
      kind: "rejected",
      code: "bad_args",
      message: expect.stringContaining("bad config"),
    })
  })

  it("refuses a secret the manifest does not declare", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(command("plugin.secret.set", { id: "m8-config", key: "NOPE", value: "x" }), owner),
    )
    expect(outcome).toMatchObject({ kind: "rejected", code: "bad_args" })
  })

  it("rejects management ops for an unknown plugin as bad_args", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(command("plugin.enable", { id: "nope", enabled: true }), owner),
    )
    expect(outcome).toMatchObject({ kind: "rejected", code: "bad_args", message: "no plugin nope" })
  })

  it("fails a plugin op that collides with a core op and leaves the core op serving", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const enable = await home.commands.run(command("plugin.enable", { id: "m8-nonet", enabled: true }), owner)
      const state = home.reconciled.states.get("m8-clash" as PluginId)
      const listed = await home.commands.run(command("file.list", {}), owner)
      return { state, enable, listed }
    })
    expect(outcome.state).toMatchObject({ kind: "failed", error: expect.stringContaining("already provided") })
    expect(outcome.enable.kind).toBe("ok")
    expect(outcome.listed.kind).toBe("ok")
  })

  it("keeps both secrets when two keys are set at once", async () => {
    const stub = fresh()
    const sealed = await runInDurableObject(stub, async (home: Home) => {
      await Promise.all([
        home.commands.run(command("plugin.secret.set", { id: "m8-secret", key: "TOKEN", value: "first" }), owner),
        home.commands.run(command("plugin.secret.set", { id: "m8-secret", key: "SECOND", value: "second" }), owner),
      ])
      const row = await home.db.get<{ sealed: string | null }>("SELECT sealed FROM plugins WHERE id = ?", "m8-secret")
      return row?.sealed ?? null
    })
    expect(sealed).not.toBeNull()
    expect(Object.keys(JSON.parse(sealed ?? "{}")).toSorted()).toEqual(["SECOND", "TOKEN"])
  })

  it("runs a plugin-issued op once for one key", async () => {
    const stub = fresh()
    const outcome = await runInDurableObject(stub, async (home: Home) => {
      const first = await home.commands.run(command("m8.replay", {}), owner)
      const second = await home.commands.run(command("m8.replay", {}), owner)
      return { first, second }
    })
    expect(outcome.first).toEqual({ kind: "ok", result: [1, 1] })
    expect(outcome.second).toEqual({ kind: "ok", result: [1, 1] })
  })

  it("fails a plugin whose stored config no longer matches the manifest", async () => {
    const stub = fresh()
    const state = await runInDurableObject(stub, async (home: Home) => {
      await home.db.run("UPDATE plugins SET config = ? WHERE id = ?", JSON.stringify({ greeting: 7 }), "m8-config")
      await home.commands.run(command("plugin.enable", { id: "m8-config", enabled: true }), owner)
      return home.reconciled.states.get("m8-config" as PluginId)
    })
    expect(state).toMatchObject({ kind: "failed", error: expect.stringContaining("bad config") })
  })
})
