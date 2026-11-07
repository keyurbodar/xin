import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, field, fresh, rowOf, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import type { RuntimeBundle } from "./bundles.ts"

const PACKAGE = "xin-plugin-demo"

type BundleRowArg = {
  readonly id: string
  readonly plugin: string
  readonly config?: unknown
  readonly disabled?: boolean
}

type BundlePatchArg = {
  readonly id: string
  readonly config?: unknown
  readonly disabled?: boolean
}

const put = (
  stub: Stub,
  name: string,
  rows: readonly BundleRowArg[],
  requires?: readonly string[],
  patch?: readonly BundlePatchArg[],
) =>
  cmd(stub, `put-${crypto.randomUUID()}`, "bundle.put", {
    package: name,
    rows,
    ...(requires === undefined ? {} : { requires }),
    ...(patch === undefined ? {} : { patch }),
  })

const list = async (stub: Stub): Promise<unknown> =>
  field(await cmd(stub, `list-${crypto.randomUUID()}`, "bundle.list"), "result")

const stored = (stub: Stub, id: string): Promise<unknown> =>
  runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get(`k-echo:${id}`))

const greeting = (id: string, text: string): BundleRowArg => ({ id, plugin: "k-echo", config: { text } })

const bundleOf = (name: string, id: string, text: string): RuntimeBundle => ({
  package: name,
  source: { kind: "local" },
  rows: [{ id, plugin: "k-echo", config: { text } }],
  patch: [],
  requires: [],
})

describe("runtime bundles", () => {
  it("mounts a local bundle live and lists its rows with the runtime layer", async () => {
    const stub = fresh()
    const ack = await put(stub, PACKAGE, [greeting("greet", "hello")])
    expect(ack).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "greet")).toMatchObject({
      plugin: "k-echo",
      layer: "runtime",
      state: { kind: "active" },
      config: { text: "hello" },
    })
    expect(await stored(stub, "greet")).toBe("hello")
    expect(await list(stub)).toMatchObject([
      {
        package: PACKAGE,
        source: { kind: "local" },
        requires: [],
        rows: [{ id: "greet", state: { kind: "active" } }],
      },
    ])
    expect(field((await cmd(stub, "packages", "plugin.packages")).result, "bundles")).toMatchObject([
      { package: PACKAGE, rows: [{ id: "greet" }] },
    ])
    const tree = await cmd(stub, "tree", "plugin.tree")
    expect(field(field(tree.result, "layers"), "greet")).toEqual({ addedBy: "runtime", patchedBy: [] })
    expect(field(tree.result, "runtime")).toMatchObject([{ package: PACKAGE, rows: ["greet"] }])
  })

  it("replaces a bundle's rows and config on update", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    const updated = await put(stub, PACKAGE, [greeting("greet", "bye")])
    expect(updated).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "greet")).toMatchObject({ state: { kind: "active" }, config: { text: "bye" } })
    expect(await stored(stub, "greet")).toBe("bye")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, rows: [{ id: "greet", state: { kind: "active" } }] }])
  })

  it("restores the replaced bundle when an update has a failing row and reports the error", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    const failed = await put(stub, PACKAGE, [{ id: "greet", plugin: "k-bundle-broken" }])
    expect(failed).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: "greet", error: "bundle row exploded" }] },
    })
    expect(await rowOf(stub, "greet")).toMatchObject({
      plugin: "k-echo",
      state: { kind: "active" },
      config: { text: "hello" },
    })
    expect(await stored(stub, "greet")).toBe("hello")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, rows: [{ state: { kind: "active" } }] }])
  })

  it("keeps a fresh install with a failing row installed and reports the row", async () => {
    const stub = fresh()
    const name = "xin-plugin-broken"
    const failed = await put(stub, name, [{ id: "boom", plugin: "k-bundle-broken" }])
    expect(failed).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: "boom", error: "bundle row exploded" }] },
    })
    expect(await rowOf(stub, "boom")).toMatchObject({ state: { kind: "failed", error: "bundle row exploded" } })
    expect(await list(stub)).toMatchObject([{ package: name, rows: [{ id: "boom", state: { kind: "failed" } }] }])

    expect(await put(stub, name, [greeting("fixed", "ok")])).toMatchObject({ result: { application: "applied" } })
    expect(await rowOf(stub, "boom")).toBeUndefined()
    expect(await rowOf(stub, "fixed")).toMatchObject({ state: { kind: "active" }, config: { text: "ok" } })
  })

  it("unmounts a removed bundle and treats a second remove as applied", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    expect(await cmd(stub, "rm", "bundle.remove", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "applied", package: PACKAGE },
    })
    expect(await rowOf(stub, "greet")).toBeUndefined()
    expect(await stored(stub, "greet")).toBeUndefined()
    expect(await list(stub)).toEqual([])
    expect(await cmd(stub, "rm2", "bundle.remove", { package: PACKAGE })).toMatchObject({
      ok: true,
      result: { application: "applied", package: PACKAGE },
    })
  })

  it("keeps an owner override across a bundle update and drops it when the inherited value comes back", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    expect(await cmd(stub, "c1", "plugin.configure", { id: "greet", config: { text: "mine" } })).toMatchObject({
      result: { application: "applied", row: { layer: "owner", state: { kind: "active" }, config: { text: "mine" } } },
    })
    await put(stub, PACKAGE, [greeting("greet", "theirs")])
    expect(await rowOf(stub, "greet")).toMatchObject({ layer: "owner", config: { text: "mine" } })
    expect(await stored(stub, "greet")).toBe("mine")

    await cmd(stub, "c2", "plugin.configure", { id: "greet", config: { text: "theirs" } })
    expect(await rowOf(stub, "greet")).toMatchObject({ layer: "runtime", config: { text: "theirs" } })
    expect(await stored(stub, "greet")).toBe("theirs")
    expect(field((await cmd(stub, "t1", "plugin.tree")).result, "owner")).toEqual([])
    expect(field(field((await cmd(stub, "t2", "plugin.tree")).result, "layers"), "greet")).toEqual({
      addedBy: "runtime",
      patchedBy: [],
    })
  })

  it("keeps the stored bundles and their rows across an eviction", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    await evictDurableObject(stub)
    expect(await rowOf(stub, "greet")).toMatchObject({ layer: "runtime", state: { kind: "active" } })
    expect(await stored(stub, "greet")).toBe("hello")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, source: { kind: "local" } }])
    await evictDurableObject(stub)
    expect(await rowOf(stub, "greet")).toMatchObject({ state: { kind: "active" } })
  })

  it("rejects an invalid bundle whole and stores nothing", async () => {
    const stub = fresh()
    const cases: readonly [string, readonly BundleRowArg[], (readonly string[])?][] = [
      ["pi", [{ id: "a", plugin: "pi" }]],
      ["row id already in the tree", [{ id: "k-config", plugin: "k-echo" }]],
      ["bad id", [{ id: "bad id", plugin: "k-echo" }]],
      ["bad config", [{ id: "a", plugin: "k-echo", config: { text: 7 } }]],
      ["missing required config", [{ id: "a", plugin: "k-required" }]],
      ["unknown plugin", [{ id: "a", plugin: "not-a-plugin" }]],
      ["bad requires", [{ id: "a", plugin: "not-a-plugin" }], ["file:../x"]],
      ["too many rows", Array.from({ length: 65 }, (_, index) => ({ id: `r${index}`, plugin: "k-echo" }))],
    ]
    for (const [label, rows, requires] of cases)
      expect(await put(stub, "xin-plugin-bad", rows, requires), label).toMatchObject({
        ok: false,
        error: { code: "bad_args" },
      })
    expect(await put(stub, "not a name", [greeting("greet", "hello")])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await put(stub, "xin-plugin-time", [greeting("greet", "hello")])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await list(stub)).toEqual([])
    expect(await rowOf(stub, "a")).toBeUndefined()
  })

  it("mounts a requires bundle with unknown plugins as missing and records the requirement", async () => {
    const stub = fresh()
    const ack = await put(stub, "xin-plugin-remote", [{ id: "a", plugin: "not-a-plugin" }], ["left-pad@1.3.0"])
    expect(ack).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "a")).toMatchObject({ state: { kind: "missing" } })
    expect(await list(stub)).toMatchObject([
      { package: "xin-plugin-remote", requires: ["left-pad@1.3.0"], rows: [{ state: { kind: "missing" } }] },
    ])
    expect(field((await cmd(stub, "pp", "plugin.packages")).result, "pending")).toMatchObject({
      add: ["left-pad@1.3.0"],
    })
  })

  it("treats an identical put as applied", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    await put(stub, PACKAGE, [greeting("greet", "bye")])
    expect(await put(stub, PACKAGE, [greeting("greet", "bye")])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await stored(stub, "greet")).toBe("bye")
  })

  it("restores the exact stored version when an update fails", async () => {
    const stub = fresh()
    await put(stub, PACKAGE, [greeting("greet", "hello")])
    await put(stub, PACKAGE, [greeting("greet", "bye")])
    expect(await put(stub, PACKAGE, [{ id: "greet", plugin: "k-bundle-broken" }])).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: "greet", error: "bundle row exploded" }] },
    })
    expect(await stored(stub, "greet")).toBe("bye")
    expect(await list(stub)).toMatchObject([{ package: PACKAGE, rows: [{ state: { kind: "active" } }] }])
  })

  it("serializes concurrent bundle writes so both land", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      await Promise.all([
        home.loader.ctx.packages.put(bundleOf("xin-plugin-one", "one-greet", "one")),
        home.loader.ctx.packages.put(bundleOf("xin-plugin-two", "two-greet", "two")),
      ])
    })
    expect(await list(stub)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ package: "xin-plugin-one" }),
        expect.objectContaining({ package: "xin-plugin-two" }),
      ]),
    )
    expect(await stored(stub, "one-greet")).toBe("one")
    expect(await stored(stub, "two-greet")).toBe("two")
  })

  it("rejects a row id that an owner patch insert already uses", async () => {
    const stub = fresh()
    const patch = [{ insert: [{ id: "greet", name: "cordis:k-echo", config: { text: "outer" } }] }]
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.patch", patch)
    })
    await evictDurableObject(stub)
    expect(await cmd(stub, "pc", "plugin.configure", { id: "greet", config: { text: "mine" } })).toMatchObject({
      ok: true,
    })
    expect(await put(stub, PACKAGE, [greeting("greet", "hello")])).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await list(stub)).toEqual([])
  })

  it("lets a bundle row read a named credential", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [{ id: "secret", plugin: "k-secret" }])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await cmd(stub, "sec", "secret.set", { ref: "TOKEN", value: "bundle-token" })).toMatchObject({
      ok: true,
      result: { application: "applied", ref: "TOKEN" },
    })
    expect((await cmd(stub, "read", "k.secret")).result).toEqual({ value: "bundle-token" })
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

  it("cancels a pending code add of the bundle's name", async () => {
    const stub = fresh()
    expect(await cmd(stub, "c1", "plugin.install", { spec: "xin-plugin-demo@1.0.0" })).toMatchObject({ ok: true })
    expect(field((await cmd(stub, "pp1", "plugin.packages")).result, "pending")).toEqual({
      add: ["xin-plugin-demo@1.0.0"],
      remove: [],
    })

    await put(stub, PACKAGE, [greeting("greet", "hello")])

    expect(field((await cmd(stub, "pp2", "plugin.packages")).result, "pending")).toEqual({ add: [], remove: [] })
    expect(await rowOf(stub, "greet")).toMatchObject({ state: { kind: "active" } })
  })

  it("does not mount a stored bundle whose package is compiled into the build", async () => {
    const stub = fresh()
    const name = "xin-plugin-time"
    const bundle: RuntimeBundle = {
      package: name,
      source: { kind: "registry", version: "1.0.0", integrity: "sha512-AAAA" },
      rows: [{ id: "greet", plugin: "k-echo", config: { text: "hello" } }],
      patch: [],
      requires: [],
    }
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.bundles", [bundle])
    })
    await evictDurableObject(stub)

    expect(await rowOf(stub, "greet")).toBeUndefined()
    expect(await stored(stub, "greet")).toBeUndefined()
    expect(await list(stub)).toMatchObject([{ package: name, rows: [{ id: "greet", state: { kind: "missing" } }] }])
  })

  it("fails a second row of a plugin that registers a fixed extension name", async () => {
    const stub = fresh()
    const name = "xin-plugin-duplicate"
    expect(await put(stub, name, [{ id: "second", plugin: "m2" }])).toMatchObject({
      ok: true,
      result: { application: "failed", rows: [{ id: "second", error: expect.stringContaining("m2") }] },
    })
    expect(await rowOf(stub, "second")).toMatchObject({ state: { kind: "failed" } })
    expect(await rowOf(stub, "m2")).toMatchObject({ state: { kind: "active" } })
  })

  it("patches a compiled row in the runtime layer, with the owner override on top", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [], undefined, [{ id: "k-config", config: { greeting: "bundle" } }])).toMatchObject(
      { ok: true, result: { application: "applied" } },
    )
    expect(await rowOf(stub, "k-config")).toMatchObject({
      layer: "runtime",
      config: { greeting: "bundle" },
      state: { kind: "active" },
    })
    expect(await list(stub)).toMatchObject([{ patch: [{ id: "k-config", state: "applied" }] }])
    expect((await cmd(stub, "patch-g1", "k.greeting")).result).toBe("bundle")

    await cmd(stub, "patch-c1", "plugin.configure", { id: "k-config", config: { greeting: "mine" } })
    expect((await cmd(stub, "patch-g2", "k.greeting")).result).toBe("mine")
    expect(await rowOf(stub, "k-config")).toMatchObject({ layer: "owner", config: { greeting: "mine" } })

    await cmd(stub, "patch-c2", "plugin.configure", { id: "k-config", config: { greeting: "bundle" } })
    expect((await cmd(stub, "patch-g3", "k.greeting")).result).toBe("bundle")
    expect(await rowOf(stub, "k-config")).toMatchObject({ layer: "runtime" })

    await put(stub, PACKAGE, [], undefined, [])
    expect((await cmd(stub, "patch-g4", "k.greeting")).result).toBe("hi")
    expect(await rowOf(stub, "k-config")).toMatchObject({ layer: "bundle" })
  })

  it("lets a later bundle's patch win and restores the earlier one when it is removed", async () => {
    const stub = fresh()
    const first = "xin-plugin-first"
    const second = "xin-plugin-second"
    await put(stub, first, [], undefined, [{ id: "k-config", config: { greeting: "first" } }])
    await put(stub, second, [], undefined, [{ id: "k-config", config: { greeting: "second" } }])
    expect((await cmd(stub, "order-g1", "k.greeting")).result).toBe("second")
    expect(field(field((await cmd(stub, "order-tree", "plugin.tree")).result, "layers"), "k-config")).toEqual({
      addedBy: "bundle",
      patchedBy: ["runtime"],
    })
    await cmd(stub, "order-rm", "bundle.remove", { package: second })
    expect((await cmd(stub, "order-g2", "k.greeting")).result).toBe("first")
  })

  it("keeps an unknown patch target and reports it in bundle.list", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [], undefined, [{ id: "ghost-row", disabled: true }])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await list(stub)).toMatchObject([{ patch: [{ id: "ghost-row", state: "unknown" }] }])
    expect(await rowOf(stub, "ghost-row")).toBeUndefined()
  })

  it("rejects a patch on a required row or a bad config", async () => {
    const stub = fresh()
    const cases: readonly (readonly BundlePatchArg[])[] = [
      [{ id: "pi", disabled: true }],
      [{ id: "k-config", config: { greeting: 7 } }],
    ]
    for (const patch of cases)
      expect(await put(stub, PACKAGE, [], undefined, patch), JSON.stringify(patch)).toMatchObject({
        ok: false,
        error: { code: "bad_args" },
      })
    expect(await list(stub)).toEqual([])
    expect((await cmd(stub, "negative-g", "k.greeting")).result).toBe("hi")
  })

  it("applies a bundle patch when its target appears in a later bundle", async () => {
    const stub = fresh()
    expect(await put(stub, PACKAGE, [], undefined, [{ id: "later", config: { text: "patched" } }])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(await list(stub)).toMatchObject([{ patch: [{ id: "later", state: "unknown" }] }])

    expect(await put(stub, "xin-plugin-later", [greeting("later", "mine")])).toMatchObject({ ok: true })
    expect(await rowOf(stub, "later")).toMatchObject({ state: { kind: "active" }, config: { text: "patched" } })
    expect(await stored(stub, "later")).toBe("patched")
    expect(await list(stub)).toMatchObject([
      { package: PACKAGE, patch: [{ id: "later", state: "applied" }] },
      { package: "xin-plugin-later" },
    ])
  })
})
