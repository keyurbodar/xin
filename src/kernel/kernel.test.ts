import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const rowOf = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}-${crypto.randomUUID()}`, "plugin.list")
  return Array.isArray(listed.result) ? listed.result.find((row) => field(row, "id") === id) : undefined
}

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

  it("refuses to insert a required plugin or a second copy of a single-instance plugin", async () => {
    const stub = fresh()
    expect(await cmd(stub, "ip1", "plugin.insert", { id: "pi2", plugin: "pi", config: {} })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await cmd(stub, "it1", "plugin.insert", { id: "time2", plugin: "time", config: {} })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect(await rowOf(stub, "time2")).toBeUndefined()
  })

  it("reports an owner row whose plugin left the build as missing, refuses config, and removes it", async () => {
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
    expect(await cmd(stub, "gm1", "plugin.reset", { id: "ghost" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
    expect((await cmd(stub, "gm2", "plugin.remove", { id: "ghost" })).result).toMatchObject({
      application: "applied",
      id: "ghost",
    })
    await evictDurableObject(stub)
    expect(await rowOf(stub, "ghost")).toBeUndefined()
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
    await cmd(stub, "r1", "plugin.reset", { id: "k-config" })
    expect((await cmd(stub, "g4", "k.greeting")).result).toBe("hi")
    const tree = await cmd(stub, "t1", "plugin.tree")
    expect(field(tree.result, "owner")).toEqual([])
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

  it("inserts a second copy of a catalog plugin, and an inserted clash fails alone", async () => {
    const stub = fresh()
    const clash = await cmd(stub, "i1", "plugin.insert", { id: "clash", plugin: "k-clash", config: {} })
    expect(clash.result).toMatchObject({ application: "failed", row: { state: { kind: "failed" } } })
    expect(JSON.stringify(clash.result)).toContain("file.list is already defined")
    expect((await cmd(stub, "f1", "file.list", { prefix: "/" })).ok).toBe(true)
    await cmd(stub, "rm", "plugin.remove", { id: "clash" })
    expect(await rowOf(stub, "clash")).toBeUndefined()
  })

  it("runs an ops/before policy over every op and drops it when the row is disabled", async () => {
    const stub = fresh()
    expect(await cmd(stub, "p1", "test.bump", { by: 13 })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await cmd(stub, "p2", "plugin.enable", { id: "k-policy", enabled: false })
    expect(await cmd(stub, "p3", "test.bump", { by: 13 })).toMatchObject({ ok: true, result: 13 })
  })

  it("runs harness startup work for a row mounted late", async () => {
    const stub = fresh()
    await cmd(stub, "late", "plugin.insert", { id: "late", plugin: "k-ready", config: {} })
    const ran = await runInDurableObject(stub, async (_home: Home, state) => state.storage.kv.get<number>("k-ready"))
    expect(ran).toBe(1)
  })

  it("restarts in place and updates through the deployer seam", async () => {
    const stub = fresh()
    expect((await cmd(stub, "u0", "system.update")).result).toMatchObject({ application: "failed" })
    await cmd(stub, "dh", "plugin.enable", { id: "deploy-hook", enabled: false })
    await cmd(stub, "fd", "plugin.insert", { id: "fake-deployer", plugin: "k-deployer", config: {} })
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
