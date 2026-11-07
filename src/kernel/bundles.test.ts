import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { requests, script, SKILL_MODEL } from "../../test/plugins/skills.ts"
import { cmd, field, fresh, rowOf, turn, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { RuntimeBundle } from "./bundles.ts"

const PACKAGE = "xin-plugin-demo"

type BundleRowArg = {
  readonly id: string
  readonly plugin: string
  readonly config?: unknown
  readonly disabled?: boolean
}

const put = (stub: Stub, name: string, rows: readonly BundleRowArg[], requires?: readonly string[]) =>
  cmd(stub, `put-${crypto.randomUUID()}`, "bundle.put", {
    package: name,
    rows,
    ...(requires === undefined ? {} : { requires }),
  })

const list = async (stub: Stub): Promise<unknown> =>
  field(await cmd(stub, `list-${crypto.randomUUID()}`, "bundle.list"), "result")

const stored = (stub: Stub, id: string): Promise<unknown> =>
  runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get(`k-echo:${id}`))

const rowId = (id: string): string => `${PACKAGE}#${id}`

const greeting = (text: string): BundleRowArg => ({ id: "greet", plugin: "k-echo", config: { text } })

const bundleOf = (name: string, text: string): RuntimeBundle => ({
  package: name,
  source: { kind: "local" },
  rows: [{ id: "greet", plugin: "k-echo", config: { text } }],
  requires: [],
})

function promptAt(index: number): string {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return getCurrentSystemPrompt(request.messages)
}

async function lastToolResult(stub: Stub): Promise<{ isError: boolean; text: string } | undefined> {
  return runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
    let found: { isError: boolean; text: string } | undefined
    for (const entry of page.items)
      for (const message of entry.model ?? [])
        if (message.role === "toolResult")
          found = {
            isError: message.isError,
            text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          }
    return found
  })
}

describe("runtime bundles", () => {
  it("mounts a local bundle live and lists its rows with the runtime layer", async () => {
    const stub = fresh()
    const ack = await put(stub, PACKAGE, [greeting("hello")])
    expect(ack).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({
      plugin: "k-echo",
      layer: "runtime",
      state: { kind: "active" },
      config: { text: "hello" },
    })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
    expect(await list(stub)).toMatchObject([
      {
        package: PACKAGE,
        source: { kind: "local" },
        requires: [],
        previous: null,
        rows: [{ id: rowId("greet"), state: { kind: "active" } }],
      },
    ])
    expect(field((await cmd(stub, "packages", "plugin.packages")).result, "bundles")).toMatchObject([
      { package: PACKAGE, rows: [{ id: rowId("greet") }] },
    ])
    const tree = await cmd(stub, "tree", "plugin.tree")
    expect(field(field(tree.result, "layers"), rowId("greet"))).toBe("runtime")
    expect(field(tree.result, "runtime")).toMatchObject([{ package: PACKAGE, rows: [rowId("greet")] }])
  })

  it("replaces a bundle's config on update and keeps the replaced version", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    const updated = await put(stub, PACKAGE, [greeting("bye")])
    expect(updated).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ state: { kind: "active" }, config: { text: "bye" } })
    expect(await stored(stub, rowId("greet"))).toBe("bye")
    expect(await list(stub)).toMatchObject([
      { package: PACKAGE, previous: "local", rows: [{ state: { kind: "active" } }] },
    ])
  })

  it("rolls a failed update back to the previous version and reports the row error", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    const failed = await put(stub, PACKAGE, [{ id: "greet", plugin: "k-bundle-broken" }])
    expect(failed).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: rowId("greet"), error: "bundle row exploded" }] },
    })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({
      plugin: "k-echo",
      state: { kind: "active" },
      config: { text: "hello" },
    })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
    expect(await list(stub)).toMatchObject([
      { package: PACKAGE, previous: null, rows: [{ state: { kind: "active" } }] },
    ])
  })

  it("removes a failed first bundle and stores nothing", async () => {
    const stub = fresh()
    const name = "xin-plugin-broken"
    const failed = await put(stub, name, [{ id: "boom", plugin: "k-bundle-broken" }])
    expect(failed).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: `${name}#boom`, error: "bundle row exploded" }] },
    })
    expect(await rowOf(stub, `${name}#boom`)).toBeUndefined()
    expect(await list(stub)).toEqual([])
  })

  it("swaps a bundle with its previous version on rollback", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    expect(await cmd(stub, "r0", "bundle.rollback", { package: PACKAGE })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    await put(stub, PACKAGE, [greeting("bye")])
    expect(await cmd(stub, "r1", "bundle.rollback", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ state: { kind: "active" }, config: { text: "hello" } })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, previous: "local" }])
    await cmd(stub, "r2", "bundle.rollback", { package: PACKAGE })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ config: { text: "bye" } })
    expect(await cmd(stub, "r3", "bundle.rollback", { package: "not-installed" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })

  it("unmounts a removed bundle and treats a second remove as applied", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    expect(await cmd(stub, "rm", "bundle.remove", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "applied", package: PACKAGE },
    })
    expect(await rowOf(stub, rowId("greet"))).toBeUndefined()
    expect(await stored(stub, rowId("greet"))).toBeUndefined()
    expect(await list(stub)).toEqual([])
    expect(await cmd(stub, "rm2", "bundle.remove", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "applied", package: PACKAGE },
    })
  })

  it("keeps an owner override on a bundle row across a bundle update", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    expect(await cmd(stub, "c1", "plugin.configure", { id: rowId("greet"), config: { text: "mine" } })).toMatchObject({
      result: { application: "applied", row: { layer: "owner", state: { kind: "active" }, config: { text: "mine" } } },
    })
    await put(stub, PACKAGE, [greeting("theirs")])
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ layer: "owner", config: { text: "mine" } })
    expect(await stored(stub, rowId("greet"))).toBe("mine")
    await cmd(stub, "r1", "plugin.reset", { id: rowId("greet") })
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ layer: "runtime", config: { text: "theirs" } })
    expect(await stored(stub, rowId("greet"))).toBe("theirs")
  })

  it("keeps the stored bundles and their rows across an eviction", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    await evictDurableObject(stub)
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ layer: "runtime", state: { kind: "active" } })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, source: { kind: "local" } }])
    await evictDurableObject(stub)
    expect(await rowOf(stub, rowId("greet"))).toMatchObject({ state: { kind: "active" } })
  })

  it("rejects an invalid bundle whole and stores nothing", async () => {
    const stub = fresh()
    const cases: readonly [string, readonly BundleRowArg[], (readonly string[])?][] = [
      ["pi", [{ id: "a", plugin: "pi" }]],
      [
        "duplicate non-multiple",
        [
          { id: "a", plugin: "k-package-deployer" },
          { id: "b", plugin: "k-package-deployer" },
        ],
      ],
      ["existing non-multiple", [{ id: "a", plugin: "m2" }]],
      ["bad id", [{ id: "bad id", plugin: "k-echo" }]],
      ["bad config", [{ id: "a", plugin: "k-echo", config: { text: 7 } }]],
      ["unknown plugin", [{ id: "a", plugin: "not-a-plugin" }]],
      ["bad requires", [{ id: "a", plugin: "not-a-plugin" }], ["file:../x"]],
      ["too many rows", Array.from({ length: 65 }, (_, index) => ({ id: `r${index}`, plugin: "k-echo" }))],
    ]
    for (const [label, rows, requires] of cases)
      expect(await put(stub, "xin-plugin-bad", rows, requires), label).toMatchObject({
        ok: false,
        error: { code: "bad_args" },
      })
    expect(await put(stub, "not a name", [greeting("hello")])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await list(stub)).toEqual([])
    expect(await rowOf(stub, "xin-plugin-bad#a")).toBeUndefined()
  })

  it("mounts a requires bundle with unknown plugins as missing and records the requirement", async () => {
    const stub = fresh()
    const ack = await put(stub, "xin-plugin-remote", [{ id: "a", plugin: "not-a-plugin" }], ["left-pad@1.3.0"])
    expect(ack).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "xin-plugin-remote#a")).toMatchObject({ state: { kind: "missing" } })
    expect(await list(stub)).toMatchObject([
      { package: "xin-plugin-remote", requires: ["left-pad@1.3.0"], rows: [{ state: { kind: "missing" } }] },
    ])
    expect(field((await cmd(stub, "pp", "plugin.packages")).result, "pending")).toMatchObject({
      add: ["left-pad@1.3.0"],
    })
  })

  it("treats an identical put as applied without touching the previous version", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    await put(stub, PACKAGE, [greeting("bye")])
    expect(await put(stub, PACKAGE, [greeting("bye")])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await stored(stub, rowId("greet"))).toBe("bye")
    await cmd(stub, "rb", "bundle.rollback", { package: PACKAGE })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
  })

  it("restores the exact stored version when an update fails", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    await put(stub, PACKAGE, [greeting("bye")])
    expect(await put(stub, PACKAGE, [{ id: "greet", plugin: "k-bundle-broken" }])).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: rowId("greet"), error: "bundle row exploded" }] },
    })
    expect(await stored(stub, rowId("greet"))).toBe("bye")
    expect(await list(stub)).toMatchObject([
      { package: PACKAGE, previous: "local", rows: [{ state: { kind: "active" } }] },
    ])
    await cmd(stub, "rb", "bundle.rollback", { package: PACKAGE })
    expect(await stored(stub, rowId("greet"))).toBe("hello")
  })

  it("serializes concurrent bundle writes so both land", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      await Promise.all([
        home.loader.ctx.packages.put(bundleOf("xin-plugin-one", "one")),
        home.loader.ctx.packages.put(bundleOf("xin-plugin-two", "two")),
      ])
    })
    expect(await list(stub)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package: "xin-plugin-one" }),
        expect.objectContaining({ package: "xin-plugin-two" }),
      ]),
    )
    expect(await stored(stub, "xin-plugin-one#greet")).toBe("one")
    expect(await stored(stub, "xin-plugin-two#greet")).toBe("two")
  })

  it("rejects a row that omits required config", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [{ id: "style", plugin: "prompt" }])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await list(stub)).toEqual([])
  })

  it("refuses a bundle-qualified id at plugin.insert", async () => {
    const stub = fresh()
    expect(
      await cmd(stub, "i1", "plugin.insert", { id: rowId("x"), plugin: "k-echo", config: { text: "x" } }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })

  it("rejects a row whose qualified id already exists outside the bundle", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.patch", [
        { insert: [{ id: rowId("greet"), name: "cordis:k-echo", config: { text: "outer" } }] },
      ])
    })
    await evictDurableObject(stub)
    expect(await put(stub, PACKAGE, [greeting("hello")])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await list(stub)).toEqual([])
  })

  it("accepts a bundle row id for a secret and the row reads it", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [{ id: "secret", plugin: "k-secret" }])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(
      await cmd(stub, "sec", "plugin.secret.set", { id: rowId("secret"), key: "TOKEN", value: "bundle-token" }),
    ).toMatchObject({ ok: true, result: { application: "applied", id: rowId("secret"), key: "TOKEN" } })
    expect((await cmd(stub, "read", "k.secret")).result).toEqual({ value: "bundle-token" })
  })

  it("mounts a bundle's prompt and skill rows so the model sees both", async () => {
    const stub = fresh()
    const text = "Answer in plain English. BUNDLE-PROMPT."
    const body = "1. Read the primary source.\n2. Quote it."
    const markdown = `---\nname: research\ndescription: Research a topic.\n---\n${body}`
    expect(
      await put(stub, PACKAGE, [
        { id: "style", plugin: "prompt", config: { text } },
        { id: "research-notes", plugin: "skill", config: { markdown } },
      ]),
    ).toMatchObject({ ok: true, result: { application: "applied" } })
    expect((await cmd(stub, "sl", "skill.list")).result).toEqual([
      { name: "research", description: "Research a topic." },
    ])

    script([fauxAssistantMessage("ok")])
    await turn(stub, `bundle-turn-${crypto.randomUUID()}`, { text: "hello", model: SKILL_MODEL })
    expect(promptAt(0)).toContain(text)
    expect(promptAt(0)).toContain("- research: Research a topic.")

    script([
      (request) =>
        request.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage([fauxToolCall("skill", { name: "research" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, `bundle-skill-turn-${crypto.randomUUID()}`, { text: "please research", model: SKILL_MODEL })
    expect(await lastToolResult(stub)).toEqual({ isError: false, text: body })
  })

  it("rejects a bundle larger than 512 KiB", async () => {
    const stub = fresh()
    expect(
      await put(stub, PACKAGE, [{ id: "greet", plugin: "k-echo", config: { text: "x".repeat(513 * 1024) } }]),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(await list(stub)).toEqual([])
  })

  it("keeps a removed bundle's requires pending", async () => {
    const stub = fresh()
    const name = "xin-plugin-remote"
    await put(stub, name, [{ id: "a", plugin: "not-a-plugin" }], ["left-pad@1.3.0"])
    expect(await cmd(stub, "rm", "bundle.remove", { package: name })).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(field((await cmd(stub, "pp", "plugin.packages")).result, "pending")).toMatchObject({
      add: ["left-pad@1.3.0"],
    })
  })

  it("reports failed when rollback restores a broken previous version", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("hello")])
    const current: RuntimeBundle = bundleOf(PACKAGE, "current")
    const broken: RuntimeBundle = {
      package: PACKAGE,
      source: { kind: "local" },
      rows: [{ id: "greet", plugin: "k-bundle-broken" }],
      requires: [],
    }
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.bundles", [{ bundle: current, previous: broken }])
    })
    expect(await cmd(stub, "rb", "bundle.rollback", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: rowId("greet"), error: "bundle row exploded" }] },
    })
  })

  it("cancels a pending code add and remove of a bundle's name", async () => {
    const stub = fresh()
    expect(await cmd(stub, "c1", "plugin.install", { spec: "xin-plugin-demo@1.0.0" })).toMatchObject({ ok: true })
    expect(await cmd(stub, "c2", "plugin.uninstall", { package: "xin-plugin-weather" })).toMatchObject({ ok: true })
    expect(field((await cmd(stub, "pp1", "plugin.packages")).result, "pending")).toEqual({
      add: ["xin-plugin-demo@1.0.0"],
      remove: ["xin-plugin-weather"],
    })

    await put(stub, "xin-plugin-demo", [greeting("hello")])
    await put(stub, "xin-plugin-weather", [greeting("hello")])

    expect(field((await cmd(stub, "pp2", "plugin.packages")).result, "pending")).toEqual({ add: [], remove: [] })
    expect(await rowOf(stub, "xin-plugin-demo#greet")).toMatchObject({ state: { kind: "active" } })
  })

  it("does not mount a runtime bundle whose package is compiled into the build", async () => {
    const stub = fresh()
    const name = "xin-plugin-weather"
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.bundles", [
        {
          bundle: {
            package: name,
            source: { kind: "registry", version: "1.0.0", integrity: "sha512-AAAA" },
            rows: [{ id: "greet", plugin: "k-echo", config: { text: "hello" } }],
            requires: [],
          },
        },
      ])
    })
    await evictDurableObject(stub)

    expect(await rowOf(stub, `${name}#greet`)).toBeUndefined()
    expect(await stored(stub, `${name}#greet`)).toBeUndefined()
    expect(await list(stub)).toMatchObject([
      { package: name, rows: [{ id: `${name}#greet`, state: { kind: "superseded" } }] },
    ])
  })

  it("reports a duplicate non-multiple runtime row failed at boot", async () => {
    const stub = fresh()
    const name = "xin-plugin-duplicate"
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.bundles", [
        {
          bundle: {
            package: name,
            source: { kind: "local" },
            rows: [{ id: "second", plugin: "m2" }],
            requires: [],
          },
        },
      ])
    })
    await evictDurableObject(stub)

    expect(await list(stub)).toMatchObject([
      {
        package: name,
        rows: [{ id: `${name}#second`, state: { kind: "failed", error: expect.stringContaining("m2") } }],
      },
    ])
    expect(await rowOf(stub, `${name}#second`)).toMatchObject({ state: { kind: "failed" } })
  })
})
