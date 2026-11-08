import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, field, fresh, rowOf, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const put = (stub: Stub, rows: readonly { id: string; plugin: string; config?: unknown }[]): ReturnType<typeof cmd> =>
  cmd(stub, `put-${crypto.randomUUID()}`, "bundle.put", { package: "xin-test-row", rows })

describe("plugin kernel", () => {
  it("lists every kernel and feature row as active and failed rows with their error", async () => {
    const stub = fresh()
    for (const id of ["db", "pi", "ops", "wire", "clock", "secrets", "plugins", "system", "models", "orchestrator"])
      expect(field(await rowOf(stub, id), "state"), id).toEqual({ kind: "active" })
    expect(field(await rowOf(stub, "k-broken"), "state")).toEqual({ kind: "failed", error: "k setup exploded" })
    expect(field(await rowOf(stub, "k-harness-broken"), "state")).toEqual({
      kind: "failed",
      error: "k harness exploded",
    })
    expect(field(await rowOf(stub, "orphan"), "state")).toEqual({ kind: "pending" })
    expect(field(await rowOf(stub, "tool-plugins"), "state")).toEqual({ kind: "disabled" })
  })

  it("fails only the row whose harness startup throws", async () => {
    const stub = fresh()
    expect(field(await rowOf(stub, "pi"), "state")).toEqual({ kind: "active" })
    expect(field(await rowOf(stub, "k-config"), "state")).toEqual({ kind: "active" })
    expect((await cmd(stub, "hb1", "test.bump")).result).toBe(1)
  })

  it("refuses to configure a plugin that declares no config schema", async () => {
    const stub = fresh()
    expect(await cmd(stub, "cp0", "plugin.configure", { id: "pi", config: {} })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(field(await rowOf(stub, "pi"), "state")).toEqual({ kind: "active" })
    expect((await cmd(stub, "cp1", "test.bump")).result).toBe(1)
  })

  it("adds a second row of a plugin from a local bundle", async () => {
    const stub = fresh()
    expect(await put(stub, [{ id: "time-tokyo", plugin: "time", config: { timezone: "Asia/Tokyo" } }])).toMatchObject({
      ok: true,
      result: { application: "applied" },
    })
    expect(field(await rowOf(stub, "time-tokyo"), "state")).toEqual({ kind: "active" })
    expect(field(await rowOf(stub, "time"), "state")).toEqual({ kind: "active" })
  })

  it("adds a bundle row that clashes on an op name and leaves the other rows running", async () => {
    const stub = fresh()
    const clash = await put(stub, [{ id: "clash", plugin: "k-clash" }])
    expect(clash.result).toMatchObject({ application: "failed", rows: [{ id: "clash" }] })
    expect(JSON.stringify(clash.result)).toContain("file.list is already defined")
    expect(field(await rowOf(stub, "clash"), "state")).toMatchObject({ kind: "failed" })
    expect((await cmd(stub, "f1", "file.list", { prefix: "/" })).ok).toBe(true)
  })

  it("reports an owner row whose plugin left the build as missing and refuses config", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (_home: Home, state) => {
      state.storage.kv.put("plugins.patch", [{ insert: [{ id: "ghost", name: "cordis:not-in-build" }] }])
    })
    await evictDurableObject(stub)
    expect(field(await rowOf(stub, "ghost"), "state")).toEqual({ kind: "missing" })
    expect(await cmd(stub, "gm0", "plugin.configure", { id: "ghost", config: {} })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await cmd(stub, "gm1", "plugin.enable", { id: "ghost", enabled: false })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })

  it("stays coherent after two back-to-back restarts", async () => {
    const stub = fresh()
    expect((await cmd(stub, "rs1", "system.restart", {})).result).toMatchObject({ application: "restarting" })
    expect((await cmd(stub, "rs2", "system.restart", {})).result).toMatchObject({ application: "restarting" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await cmd(stub, "rs3", "test.bump")).result).toBe(1)
    expect((await cmd(stub, "rs4", "test.bump")).result).toBe(2)
  })

  it("reconfigures a row live, validates against its schema, and keeps the change across eviction", async () => {
    const stub = fresh()
    expect((await cmd(stub, "g1", "k.greeting")).result).toBe("hi")
    const bad = await cmd(stub, "c0", "plugin.configure", { id: "k-config", config: { greeting: 7 } })
    expect(bad).toMatchObject({ ok: false, error: { code: "bad_args" } })
    const changed = await cmd(stub, "c1", "plugin.configure", { id: "k-config", config: { greeting: "hola" } })
    expect(changed.result).toMatchObject({ application: "applied", row: { layer: "owner", state: { kind: "active" } } })
    expect((await cmd(stub, "g2", "k.greeting")).result).toBe("hola")
    await evictDurableObject(stub)
    expect((await cmd(stub, "g3", "k.greeting")).result).toBe("hola")
    await cmd(stub, "r1", "plugin.configure", { id: "k-config", config: { greeting: "hi" } })
    expect((await cmd(stub, "g4", "k.greeting")).result).toBe("hi")
    expect(await rowOf(stub, "k-config")).toMatchObject({ layer: "bundle", config: { greeting: "hi" } })
    expect(field((await cmd(stub, "t1", "plugin.tree")).result, "owner")).toEqual([])
  })

  it("disables a row so its ops vanish, re-enables it, and refuses to disable a required row", async () => {
    const stub = fresh()
    await cmd(stub, "d1", "plugin.enable", { id: "k-config", enabled: false })
    expect(await cmd(stub, "g1", "k.greeting")).toMatchObject({ ok: false, error: { code: "unknown_op" } })
    await evictDurableObject(stub)
    expect(field(await rowOf(stub, "k-config"), "state")).toEqual({ kind: "disabled" })
    await cmd(stub, "d2", "plugin.enable", { id: "k-config", enabled: true })
    expect((await cmd(stub, "g2", "k.greeting")).result).toBe("hi")
    expect(await cmd(stub, "d3", "plugin.enable", { id: "pi", enabled: false })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })

  it("runs an ops/before policy over every op and drops it when the row is disabled", async () => {
    const stub = fresh()
    expect(await cmd(stub, "p1", "test.bump", { by: 13 })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await cmd(stub, "p2", "plugin.enable", { id: "k-policy", enabled: false })
    expect(await cmd(stub, "p3", "test.bump", { by: 13 })).toMatchObject({ ok: true, result: 13 })
  })

  it("runs harness startup work for a row mounted late", async () => {
    const stub = fresh()
    await put(stub, [{ id: "late", plugin: "k-ready" }])
    const ran = await runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get<number>("k-ready"))
    expect(ran).toBe(1)
  })

  it("restarts in place and updates through the deployer seam", async () => {
    const stub = fresh()
    expect((await cmd(stub, "u0", "system.update")).result).toMatchObject({ application: "failed" })
    await cmd(stub, "dh", "plugin.enable", { id: "deploy-hook", enabled: false })
    await put(stub, [{ id: "fake-deployer", plugin: "k-deployer" }])
    expect((await cmd(stub, "u1", "system.update")).result).toMatchObject({ application: "deploying" })
    expect((await cmd(stub, "b1", "test.bump")).result).toBe(1)
    expect((await cmd(stub, "x1", "system.restart", {})).result).toMatchObject({ application: "restarting" })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await cmd(stub, "b2", "test.bump")).result).toBe(2)
    expect(field(await rowOf(stub, "fake-deployer"), "state")).toEqual({ kind: "active" })
    const version = await cmd(stub, "v1", "system.version")
    expect(version.result).toMatchObject({ build: "dev", degraded: true })
  })
})
