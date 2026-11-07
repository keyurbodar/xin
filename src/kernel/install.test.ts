import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { DEPLOYED_PACKAGES } from "../../test/plugins/fakedeploy.ts"
import { api, cmd, field, fresh, rowOf, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { buildId, parseSpec } from "./packages.ts"

const PENDING_KEY = "plugins.packages"

const pending = (ack: { result?: unknown }): unknown => field(ack.result, "pending")

const deployerStub = async (stub: Stub): Promise<void> => {
  await cmd(stub, `off-${crypto.randomUUID()}`, "plugin.enable", { id: "deploy-hook", enabled: false })
  const inserted = await cmd(stub, `in-${crypto.randomUUID()}`, "plugin.insert", {
    id: "fake-deployer",
    plugin: "k-package-deployer",
    config: {},
  })
  expect(field(inserted.result, "row")).toMatchObject({ state: { kind: "active" } })
}

const writeStored = (stub: Stub, value: unknown): Promise<void> =>
  runInDurableObject(stub, async (_home: Home, state) => {
    state.storage.kv.put(PENDING_KEY, value)
  })

describe("package specs", () => {
  it("parses registry, scoped and git specs", () => {
    expect(parseSpec("left-pad")).toEqual({ kind: "registry", name: "left-pad" })
    expect(parseSpec("left-pad@^1.2")).toEqual({ kind: "registry", name: "left-pad", range: "^1.2" })
    expect(parseSpec("@scope/x@~1")).toEqual({ kind: "registry", name: "@scope/x", range: "~1" })
    expect(parseSpec("github:o/r#tag")).toEqual({ kind: "git", url: "github:o/r", ref: "tag" })
    expect(parseSpec("git+https://host/x.git")).toEqual({ kind: "git", url: "git+https://host/x.git" })
    expect(parseSpec("https://host/x.git#v1")).toEqual({ kind: "git", url: "https://host/x.git", ref: "v1" })
  })

  it("rejects protocols, tarballs, whitespace and shell characters", () => {
    for (const spec of [
      "",
      "file:../x",
      "link:../x",
      "npm:left-pad",
      "https://host/x.tgz",
      "git@github.com:o/r.git",
      "left pad",
      "left-pad; rm -rf /",
      "$(whoami)",
      "-x",
      "left-pad`",
    ])
      expect(parseSpec(spec), spec).toBeUndefined()
  })
})

describe("package installs", () => {
  it("records installs and uninstalls and lists the build's packages", async () => {
    const stub = fresh()
    const installed = await cmd(stub, "p0", "plugin.packages")
    expect(field(installed.result, "installed")).toEqual(
      expect.arrayContaining([
        { package: "xin", version: "dev" },
        { package: "xin-plugin-deploy-hook", version: "0.1.0" },
        { package: "xin-plugin-weather", version: "1.0.0" },
      ]),
    )
    expect(field(installed.result, "pending")).toEqual({ add: [], remove: [] })

    expect(await cmd(stub, "i1", "plugin.install", { spec: "left-pad@1.3.0" })).toMatchObject({
      ok: true,
      result: { application: "applied", pending: { add: ["left-pad@1.3.0"], remove: [] } },
    })
    expect(await cmd(stub, "i2", "plugin.install", { spec: "@scope/x@~1" })).toMatchObject({
      ok: true,
      result: { pending: { add: ["left-pad@1.3.0", "@scope/x@~1"] } },
    })
    expect(await cmd(stub, "u1", "plugin.uninstall", { package: "xin-plugin-weather" })).toMatchObject({
      ok: true,
      result: {
        application: "applied",
        pending: { add: ["left-pad@1.3.0", "@scope/x@~1"], remove: ["xin-plugin-weather"] },
      },
    })
    expect(pending(await cmd(stub, "p1", "plugin.packages"))).toEqual({
      add: ["left-pad@1.3.0", "@scope/x@~1"],
      remove: ["xin-plugin-weather"],
    })
  })

  it("records the same install or uninstall once and lets an install cancel a removal", async () => {
    const stub = fresh()
    await cmd(stub, "i1", "plugin.install", { spec: "left-pad@1.3.0" })
    expect(pending(await cmd(stub, "i2", "plugin.install", { spec: "left-pad@1.3.0" }))).toEqual({
      add: ["left-pad@1.3.0"],
      remove: [],
    })
    await cmd(stub, "u1", "plugin.uninstall", { package: "xin-plugin-weather" })
    expect(pending(await cmd(stub, "u2", "plugin.uninstall", { package: "xin-plugin-weather" }))).toEqual({
      add: ["left-pad@1.3.0"],
      remove: ["xin-plugin-weather"],
    })
    expect(pending(await cmd(stub, "i3", "plugin.install", { spec: "xin-plugin-weather" }))).toEqual({
      add: ["left-pad@1.3.0", "xin-plugin-weather"],
      remove: [],
    })
  })

  it("rejects bad specs, packages that are not in the build, core and local packages", async () => {
    const stub = fresh()
    for (const [index, spec] of [
      "",
      "left pad",
      "left-pad; rm -rf /",
      "$(whoami)",
      "-x",
      "left-pad`",
      "file:../x",
      "link:../x",
      "npm:left-pad",
      "https://host/x.tgz",
    ].entries())
      expect(await cmd(stub, `bad-${index}`, "plugin.install", { spec }), spec).toMatchObject({
        ok: false,
        error: { code: "bad_args" },
      })
    expect(await cmd(stub, "u1", "plugin.uninstall", { package: "not-in-this-build" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: "not-in-this-build is not in this build" },
    })
    expect(await cmd(stub, "u2", "plugin.uninstall", { package: "xin" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: "xin provides core and cannot be removed" },
    })
    expect(await cmd(stub, "u3", "plugin.uninstall", { package: "xin-plugin-time" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: "xin-plugin-time is a local package; disable its bundle instead" },
    })
    expect(pending(await cmd(stub, "p1", "plugin.packages"))).toEqual({ add: [], remove: [] })
  })

  it("passes the pending packages to the deployer", async () => {
    const stub = fresh()
    await cmd(stub, "i1", "plugin.install", { spec: "left-pad@1.3.0" })
    await deployerStub(stub)
    expect(await cmd(stub, "x1", "system.update")).toMatchObject({
      ok: true,
      result: { application: "deploying" },
    })
    const recorded = await runInDurableObject(stub, async (_home: Home, state) =>
      state.storage.kv.get(DEPLOYED_PACKAGES),
    )
    expect(recorded).toEqual({ add: ["left-pad@1.3.0"], remove: [] })
    expect(field(await rowOf(stub, "fake-deployer"), "state")).toEqual({ kind: "active" })
  })

  it("keeps a pending upgrade across an eviction on the same build", async () => {
    const stub = fresh()
    expect(await cmd(stub, "i1", "plugin.install", { spec: "xin-plugin-weather@2.0.0" })).toMatchObject({ ok: true })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p1", "plugin.packages"))).toEqual({
      add: ["xin-plugin-weather@2.0.0"],
      remove: [],
    })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p2", "plugin.packages"))).toEqual({
      add: ["xin-plugin-weather@2.0.0"],
      remove: [],
    })
  })

  it("settles a pending add on a new build only when the build satisfies it", async () => {
    const stub = fresh()
    await writeStored(stub, {
      add: [
        { spec: { kind: "registry", name: "xin-plugin-weather", range: "^1.0.0" }, build: "older" },
        { spec: { kind: "registry", name: "xin-plugin-weather", range: "2.0.0" }, build: "older" },
        { spec: { kind: "registry", name: "left-pad", range: "1.3.0" }, build: "older" },
      ],
      remove: [
        { name: "xin-plugin-weather", build: "older" },
        { name: "not-in-this-build", build: "older" },
      ],
    })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p1", "plugin.packages"))).toEqual({
      add: ["xin-plugin-weather@2.0.0", "left-pad@1.3.0"],
      remove: ["xin-plugin-weather"],
    })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p2", "plugin.packages"))).toEqual({
      add: ["xin-plugin-weather@2.0.0", "left-pad@1.3.0"],
      remove: ["xin-plugin-weather"],
    })
  })

  it("settles git specs on a new build", async () => {
    const stub = fresh()
    await writeStored(stub, {
      add: [{ spec: { kind: "git", url: "github:o/r", ref: "tag" }, build: "older" }],
      remove: [],
    })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p1", "plugin.packages"))).toEqual({ add: [], remove: [] })

    await writeStored(stub, {
      add: [{ spec: { kind: "git", url: "git+https://host/x.git" }, build: buildId() }],
      remove: [],
    })
    await evictDurableObject(stub)
    expect(pending(await cmd(stub, "p2", "plugin.packages"))).toEqual({
      add: ["git+https://host/x.git"],
      remove: [],
    })
  })

  it("serves the pending packages to the build route only with the owner token", async () => {
    const allowed = await api("/v1/build/packages")
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ add: [], remove: [] })
    const denied = await api("/v1/build/packages", { headers: { authorization: "" } })
    expect(denied.status).toBe(401)
  })
})
