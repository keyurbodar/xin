import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, field, fresh, rowOf, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const PACKAGE = "xin-plugin-notes"

const first = [{ id: "k-config", config: { greeting: "first" } }]
const second = [{ id: "k-config", config: { greeting: "second" } }]

const bundleOf = (
  pkg: string,
  patch: readonly { readonly id: string; readonly config?: unknown }[] = [],
  rows: readonly { readonly id: string; readonly plugin: string; readonly config?: unknown }[] = [],
) => ({
  package: pkg,
  source: { kind: "local" as const },
  rows,
  patch,
  requires: [],
})

const save = (stub: Stub, name: string) => cmd(stub, `save-${name}-${crypto.randomUUID()}`, "profile.save", { name })

const switchTo = (stub: Stub, name: string) =>
  cmd(stub, `switch-${name}-${crypto.randomUUID()}`, "profile.switch", { name })

const remove = (stub: Stub, name: string) =>
  cmd(stub, `delete-${name}-${crypto.randomUUID()}`, "profile.delete", { name })

const listing = async (stub: Stub): Promise<unknown> =>
  (await cmd(stub, `profiles-${crypto.randomUUID()}`, "profile.list")).result

const put = (stub: Stub, pkg: string, text: string) =>
  cmd(stub, `put-${pkg}-${crypto.randomUUID()}`, "bundle.put", {
    package: pkg,
    rows: [{ id: "greet", plugin: "k-echo", config: { text } }],
  })

const configure = (stub: Stub, greeting: string) =>
  cmd(stub, `config-${crypto.randomUUID()}`, "plugin.configure", {
    id: "k-config",
    config: { greeting },
  })

const greeting = async (stub: Stub): Promise<unknown> =>
  (await cmd(stub, `g-${crypto.randomUUID()}`, "k.greeting")).result

const writeProfiles = (stub: Stub, value: unknown): Promise<void> =>
  runInDurableObject(stub, async (_home: Home, state) => {
    state.storage.kv.put("plugins.profiles", value)
  })

describe("profiles", () => {
  it("creates the default profile and switches bundles and config live", async () => {
    const stub = fresh()
    expect(await listing(stub)).toEqual({ active: "default", profiles: [{ name: "default", bundles: [] }] })

    expect(await put(stub, "xin-plugin-one", "one")).toMatchObject({ ok: true })
    await configure(stub, "one")
    expect(await save(stub, "one")).toMatchObject({ ok: true, result: { application: "applied", name: "one" } })

    await cmd(stub, "reset-one", "bundle.remove", { package: "xin-plugin-one" })
    await put(stub, "xin-plugin-two", "two")
    await configure(stub, "two")
    expect(await save(stub, "two")).toMatchObject({ ok: true })

    expect(await listing(stub)).toEqual({
      active: "default",
      profiles: [
        { name: "default", bundles: [] },
        { name: "one", bundles: ["xin-plugin-one"] },
        { name: "two", bundles: ["xin-plugin-two"] },
      ],
    })

    expect(await switchTo(stub, "one")).toMatchObject({ ok: true, result: { application: "applied", name: "one" } })
    expect(await rowOf(stub, "xin-plugin-one#greet")).toMatchObject({
      layer: "runtime",
      state: { kind: "active" },
      config: { text: "one" },
    })
    expect(await rowOf(stub, "xin-plugin-two#greet")).toBeUndefined()
    expect(await greeting(stub)).toBe("one")
    expect(field(await listing(stub), "active")).toBe("one")

    expect(await switchTo(stub, "two")).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "xin-plugin-two#greet")).toMatchObject({ state: { kind: "active" } })
    expect(await rowOf(stub, "xin-plugin-one#greet")).toBeUndefined()
    expect(await greeting(stub)).toBe("two")
    expect(field(await listing(stub), "active")).toBe("two")
  })

  it("rolls a switch back when a required row would stop being active", async () => {
    const stub = fresh()
    await writeProfiles(stub, {
      active: "default",
      bundles: [],
      patch: [],
      profiles: {
        default: { bundles: [], patch: [] },
        broken: { bundles: [], patch: [{ id: "pi", disabled: true }] },
      },
    })
    await evictDurableObject(stub)

    expect(await switchTo(stub, "broken")).toMatchObject({ ok: true, result: { application: "failed" } })
    expect(await rowOf(stub, "pi")).toMatchObject({ state: { kind: "active" } })
    expect(field(await listing(stub), "active")).toBe("default")
  })

  it("deletes an inactive profile and refuses the active or a missing one", async () => {
    const stub = fresh()
    await save(stub, "spare")
    expect(await remove(stub, "default")).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(await remove(stub, "missing")).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(await remove(stub, "spare")).toMatchObject({ ok: true, result: { application: "applied", name: "spare" } })
    expect(await listing(stub)).toEqual({ active: "default", profiles: [{ name: "default", bundles: [] }] })
  })

  it("exports a profile as a package.json that installs elsewhere with the same effect", async () => {
    const source = fresh()
    expect(
      await cmd(source, "seed", "bundle.put", {
        package: PACKAGE,
        rows: [
          { id: "greet", plugin: "k-echo", config: { text: "exported" } },
          { id: "style", plugin: "prompt", config: { text: "Answer briefly." } },
        ],
      }),
    ).toMatchObject({ ok: true })
    await cmd(source, "insert-secret", "plugin.insert", { id: "sec", plugin: "k-secret", config: {} })
    await cmd(source, "set-secret", "plugin.secret.set", {
      id: "sec",
      key: "TOKEN",
      value: "top-secret-value",
    })
    await cmd(source, "insert-time", "plugin.insert", {
      id: "time-tokyo",
      plugin: "time",
      config: { timezone: "Asia/Tokyo" },
    })
    await configure(source, "exported")
    await save(source, "demo")

    const exported = await cmd(source, "export", "profile.export", {
      name: "demo",
      package: "xin-plugin-export",
      version: "1.2.3",
    })
    expect(exported).toMatchObject({
      ok: true,
      result: {
        name: "xin-plugin-export",
        version: "1.2.3",
        keywords: ["xin-plugin"],
        xin: {
          patch: expect.arrayContaining([{ id: "k-config", config: { greeting: "exported" } }]),
          requires: [],
        },
      },
    })
    const xin = field(exported.result, "xin")
    const rows = field(xin, "bundle")
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "greet", plugin: "k-echo", config: { text: "exported" } }),
        expect.objectContaining({ id: "style", plugin: "prompt" }),
        expect.objectContaining({ id: "time-tokyo", plugin: "time", config: { timezone: "Asia/Tokyo" } }),
      ]),
    )
    expect(JSON.stringify(exported.result)).not.toContain("top-secret-value")
    expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ plugin: "k-secret" })]))

    const target = fresh()
    expect(
      await cmd(target, "install-export", "bundle.put", {
        package: "xin-plugin-export",
        rows,
        patch: field(xin, "patch"),
        requires: field(xin, "requires"),
      }),
    ).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(target, "xin-plugin-export#greet")).toMatchObject({
      layer: "runtime",
      state: { kind: "active" },
      config: { text: "exported" },
    })
    expect(await greeting(target)).toBe("exported")
  })

  it("re-homes colliding row ids deterministically in an export", async () => {
    const stub = fresh()
    const rows = [{ id: "greet", plugin: "k-echo", config: { text: "one" } }]
    await cmd(stub, "one", "bundle.put", { package: "xin-plugin-one", rows })
    await cmd(stub, "two", "bundle.put", {
      package: "xin-plugin-two",
      rows: [{ id: "greet", plugin: "k-echo", config: { text: "two" } }],
    })
    const exported = await cmd(stub, "export", "profile.export", {
      package: "xin-plugin-export",
      version: "1.0.0",
    })
    const bundle = field(field(exported.result, "xin"), "bundle")
    expect(Array.isArray(bundle) ? bundle.map((row) => field(row, "id")) : undefined).toEqual(["greet", "greet-2"])
  })

  it("keeps the profiles and the active setup across an eviction", async () => {
    const stub = fresh()
    await put(stub, "xin-plugin-one", "one")
    await save(stub, "one")
    await cmd(stub, "drop-one", "bundle.remove", { package: "xin-plugin-one" })
    expect(await switchTo(stub, "one")).toMatchObject({ ok: true, result: { application: "applied" } })

    await evictDurableObject(stub)
    expect(field(await listing(stub), "active")).toBe("one")
    expect(await rowOf(stub, "xin-plugin-one#greet")).toMatchObject({ state: { kind: "active" } })

    expect(await switchTo(stub, "default")).toMatchObject({ ok: true, result: { application: "applied" } })
    expect(await rowOf(stub, "xin-plugin-one#greet")).toBeUndefined()
  })

  it("converges on the named profile after a crash between the record and the setup writes", async () => {
    const stub = fresh()
    await put(stub, "xin-plugin-one", "one")
    await save(stub, "one")
    await cmd(stub, "drop-one", "bundle.remove", { package: "xin-plugin-one" })
    expect(await rowOf(stub, "xin-plugin-one#greet")).toBeUndefined()

    await runInDurableObject(stub, async (_home: Home, state) => {
      const record = state.storage.kv.get<Record<string, unknown>>("plugins.profiles")
      const profiles = record?.profiles as Record<string, { bundles?: unknown; patch?: unknown }> | undefined
      const one = profiles?.one
      state.storage.kv.put("plugins.profiles", {
        ...record,
        active: "one",
        bundles: one?.bundles ?? [],
        patch: one?.patch ?? [],
      })
    })
    await evictDurableObject(stub)

    expect(field(await listing(stub), "active")).toBe("one")
    expect(await rowOf(stub, "xin-plugin-one#greet")).toMatchObject({ state: { kind: "active" } })
    expect(
      await runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get("plugins.bundles")),
    ).toMatchObject([{ bundle: { package: "xin-plugin-one" } }])
  })

  it("keeps an invalid profiles record and serves a default until a save", async () => {
    const stub = fresh()
    await writeProfiles(stub, { active: 7 })
    await evictDurableObject(stub)

    expect(await listing(stub)).toEqual({ active: "default", profiles: [{ name: "default", bundles: [] }] })
    expect(
      await runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get("plugins.profiles")),
    ).toEqual({ active: 7 })
    expect(field((await cmd(stub, "tree-invalid", "plugin.tree")).result, "warnings")).toEqual(
      expect.arrayContaining([expect.stringContaining("kept as stored")]),
    )

    expect(await save(stub, "one")).toMatchObject({ ok: true })
    expect(field(await listing(stub), "active")).toBe("default")
    await evictDurableObject(stub)
    expect(field(await listing(stub), "profiles")).toMatchObject([{ name: "default" }, { name: "one" }])
  })

  it("keeps the active setup when a switch fails validation", async () => {
    const stub = fresh()
    await put(stub, "xin-plugin-one", "one")
    await writeProfiles(stub, {
      active: "default",
      bundles: [bundleOf("xin-plugin-one", [], [{ id: "greet", plugin: "k-echo", config: { text: "one" } }])],
      patch: [],
      profiles: {
        default: { bundles: [], patch: [] },
        bad: {
          bundles: [{ package: "not a name", source: { kind: "local" }, rows: [], patch: [], requires: [] }],
          patch: [],
        },
      },
    })
    await evictDurableObject(stub)

    expect(await switchTo(stub, "bad")).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(field(await listing(stub), "active")).toBe("default")
    expect(await rowOf(stub, "xin-plugin-one#greet")).toMatchObject({ state: { kind: "active" } })
    expect(field((await cmd(stub, "tree-switch", "plugin.tree")).result, "runtime")).toMatchObject([
      { package: "xin-plugin-one" },
    ])
  })

  it("replaces an existing profile on save", async () => {
    const stub = fresh()
    await put(stub, "xin-plugin-one", "one")
    await save(stub, "demo")
    await cmd(stub, "drop-demo", "bundle.remove", { package: "xin-plugin-one" })
    await put(stub, "xin-plugin-two", "two")
    await save(stub, "demo")

    expect(field(await listing(stub), "profiles")).toMatchObject([
      { name: "default", bundles: [] },
      { name: "demo", bundles: ["xin-plugin-two"] },
    ])
  })

  it("exports bundle patches in order with the owner patch last", async () => {
    const stub = fresh()
    await writeProfiles(stub, {
      active: "demo",
      bundles: [],
      patch: [],
      profiles: {
        demo: {
          bundles: [bundleOf("xin-plugin-first", first), bundleOf("xin-plugin-second", second)],
          patch: [{ id: "k-config", config: { greeting: "owner" }, disabled: false }, { id: "pi" }],
        },
      },
    })
    await evictDurableObject(stub)

    const exported = await cmd(stub, "export-ordered", "profile.export", {
      name: "demo",
      package: "xin-plugin-export",
      version: "1.0.0",
    })
    expect(exported).toMatchObject({ ok: true })
    const xin = field(exported.result, "xin")
    const patch = field(xin, "patch")
    expect(patch).toEqual([
      { id: "k-config", config: { greeting: "first" } },
      { id: "k-config", config: { greeting: "second" } },
      { id: "k-config", config: { greeting: "owner" }, disabled: false },
    ])
    expect(
      await cmd(stub, "install-ordered", "bundle.put", {
        package: "xin-plugin-export",
        rows: field(xin, "bundle"),
        patch,
        requires: field(xin, "requires"),
      }),
    ).toMatchObject({ ok: true, result: { application: "applied" } })
    expect((await cmd(stub, "ordered-greeting", "k.greeting")).result).toBe("owner")
  })

  it("rejects an export of an unknown profile or an invalid package name", async () => {
    const stub = fresh()
    expect(
      await cmd(stub, "export-unknown", "profile.export", { name: "ghost", package: "xin-plugin-x", version: "1.0.0" }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect(
      await cmd(stub, "export-bad-name", "profile.export", {
        name: "default",
        package: "Not A Name",
        version: "1.0.0",
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })

  it("excludes a non-multiple owner-inserted row from an export", async () => {
    const stub = fresh()
    expect(
      await cmd(stub, "insert-extra", "plugin.insert", { id: "extra-secret", plugin: "k-secret", config: {} }),
    ).toMatchObject({ ok: true })
    const exported = await cmd(stub, "export-secret", "profile.export", {
      package: "xin-plugin-export",
      version: "1.0.0",
    })
    const rows = field(field(exported.result, "xin"), "bundle")
    expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "extra-secret" })]))
  })
})
