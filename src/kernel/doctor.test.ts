import { describe, expect, it } from "vitest"
import { cmd, field, fresh, type Stub } from "../../test/support.ts"

type Issue = { readonly kind: string; readonly [key: string]: unknown }

type Diagnosis = {
  readonly id: string
  readonly registered: { readonly tools: readonly string[]; readonly ops: readonly string[] }
  readonly plugin: string
  readonly package: string
  readonly version: string
  readonly manifest: { readonly requires: readonly string[] }
  readonly state: { readonly kind: string; readonly error?: string }
  readonly issues: readonly Issue[]
}

type Doctor = { readonly ok: boolean; readonly rows: readonly Diagnosis[] }

const doctor = async (stub: Stub): Promise<Doctor> => {
  const ack = await cmd(stub, `doctor-${crypto.randomUUID()}`, "plugin.doctor")
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
  return ack.result as Doctor
}

const row = (report: Doctor, id: string): Diagnosis => {
  const found = report.rows.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no diagnosis for ${id}`)
  return found
}

const issue = (diagnosis: Diagnosis, kind: string): Issue | undefined =>
  diagnosis.issues.find((candidate) => candidate.kind === kind)

describe("plugin doctor", () => {
  it("reports every row's declaration, package and state", async () => {
    const stub = fresh()
    const report = await doctor(stub)

    expect(row(report, "market")).toMatchObject({
      plugin: "market",
      package: "ingle-plugin-market",
      version: "0.1.0",
      manifest: { requires: [] },
      state: { kind: "active" },
      issues: [],
    })
    expect(row(report, "time")).toMatchObject({ state: { kind: "active" }, issues: [] })
    expect(report.ok).toBe(false)
  })

  it("fails a row written against a newer plugin API without stopping the other rows", async () => {
    const stub = fresh()
    const future = row(await doctor(stub), "k-future")

    expect(future.state).toMatchObject({ kind: "failed" })
    expect(future.state.error).toContain("plugin API 2")
    expect(issue(future, "api")).toMatchObject({ declared: 2, supported: 1 })
    expect((await cmd(stub, `bump-${crypto.randomUUID()}`, "test.bump")).ok).toBe(true)
  })

  it("fails a row whose required plugin is absent, and keeps a satisfied one running", async () => {
    const stub = fresh()
    const report = await doctor(stub)

    const missing = row(report, "k-needs-missing")
    expect(missing.state).toMatchObject({ kind: "failed" })
    expect(issue(missing, "require")).toMatchObject({ spec: "absent@^1", reason: "missing" })

    const satisfied = row(report, "k-requires")
    expect(satisfied.state).toEqual({ kind: "active" })
    expect(satisfied.issues).toEqual([])
    expect(satisfied.manifest.requires).toEqual(["time@^0.1.0"])
  })

  it("fails a row that injects a guarded service without declaring its permission", async () => {
    const unpermitted = row(await doctor(fresh()), "k-unpermitted")
    expect(unpermitted.state.error).toContain("secrets permission")
    expect(issue(unpermitted, "permission")).toMatchObject({ permission: "secrets", service: "secrets" })
  })

  it("refuses every route a row has past its permissions to a guarded service or the owner's authority", async () => {
    const stub = fresh()
    await cmd(stub, "k-reach-secret", "secret.set", { ref: "k-reach-probe", value: "s3cret-value" })
    await cmd(stub, "k-reach-bundle", "bundle.put", {
      package: "k-reach-bundle",
      rows: [{ id: "k-reach-hello", plugin: "hello", config: { headers: { authorization: "Bearer s3cret-bundle" } } }],
    })
    const reply = await cmd(stub, "k-reach-1", "k.reach")
    expect(reply.result).toMatchObject({
      secret: expect.stringContaining("without declaring the secrets permission"),
      alias: expect.stringContaining("without declaring the secrets permission"),
      reflect: expect.stringContaining("without declaring the runtime permission"),
      store: expect.stringContaining("without declaring the secrets permission"),
      set: expect.stringContaining("without declaring the secrets permission"),
      inject: expect.stringContaining("without declaring the storage permission"),
      owner: expect.stringContaining("may run ops only as an agent"),
      commands: "no commands",
      defined: "no defined",
      sockets: "no sockets",
      rootSecret: expect.stringContaining("without declaring the secrets permission"),
      rootHost: expect.stringContaining("without declaring the runtime permission"),
      rootOwner: expect.stringContaining("may run ops only as an agent"),
      frame: "no message",
      parentHost: expect.stringContaining("not reachable from outside a row that declares runtime"),
      parentGet: expect.stringContaining("not reachable from outside a row that declares runtime"),
      parentSecret: expect.stringContaining("not reachable from outside a row that declares secrets"),
      entryHost: expect.stringContaining("not reachable from outside a row that declares runtime"),
      entryGet: expect.stringContaining("not reachable from outside a row that declares runtime"),
      opsCtx: "no ctx",
      opsOriginal: "no original",
      opsOriginalOwner: "no original",
      wireOriginal: "no original",
      piOriginal: "no original",
      clockOriginal: "no original",
      getOriginal: "no original",
      rootOriginal: "no original",
      ctxOriginal: "no original",
      harness: expect.stringContaining("without declaring the conversations permission"),
      internalGet: expect.stringContaining("may not listen to internal/get"),
      internalListener: expect.stringContaining("may not listen to internal/listener"),
      piAuth: expect.stringContaining("without declaring the models permission"),
      piInstalled: "no installed",
      piModelSources: "no modelSources",
      piRegister: "no install",
      clockTimers: "no timers",
      piExtensionObject: "no extension",
      piExtensionsNamed: expect.stringContaining("uses extensionsNamed without declaring the plugins permission"),
      piEnv: expect.stringContaining("uses env without declaring the runtime permission"),
      driveWrite: expect.stringContaining("without declaring the files permission"),
      foreignService: expect.stringContaining("uses the push service from push without requiring it"),
      before: {
        "secret.set": JSON.stringify({ ref: "k-reach-probe", value: "[redacted]" }),
        "bundle.put": JSON.stringify({
          package: "k-reach-bundle",
          rows: [{ id: "k-reach-hello", plugin: "hello", config: "[redacted]" }],
        }),
      },
    })
  })

  it("keeps the owner actor, provider keys and other rows' shares from a row that holds runtime and models", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    await cmd(stub, "k-reach-wide-w", "drive.write", { scope: user, path: "shared.md", text: "drive's" })
    await cmd(stub, "k-reach-wide-f", "file.put", { path: "/k-reach.txt", text: "attacker's" })
    const shared = await cmd(stub, "k-reach-wide-s", "drive.share", { scope: user, path: "shared.md" })
    const share = field(shared.result, "id")
    const reply = await cmd(stub, "k-reach-wide-1", "k.reach-wide", { share })
    expect(reply.result).toEqual({
      owner: expect.stringContaining("may run ops only as an agent, not as owner"),
      auth: "no getAuth",
      models: "reached",
      unshareOther: expect.stringContaining("another row owns it"),
      reshareOther: expect.stringContaining("another row owns it"),
      driveTamper: "drive is frozen",
      driveWide: "reached",
    })
    expect(field((await cmd(stub, "k-reach-wide-l", "drive.list", { scope: user })).result, "shares")).toEqual({
      "shared.md": share,
    })
  })

  it("grants a row holding plugins nothing more when it changes the loader state it can read", async () => {
    const reply = await cmd(fresh(), "k-reach-plugins-1", "k.reach-plugins")
    expect(reply.result).toEqual({
      pushPermissions: expect.stringContaining("not extensible"),
      pushComposition: expect.stringContaining("not extensible"),
      granted: expect.stringContaining("without declaring the secrets permission"),
    })
  })

  it("fails a row that registers an op its manifest does not declare", async () => {
    const undeclared = row(await doctor(fresh()), "k-undeclared")
    expect(undeclared.state).toMatchObject({ kind: "failed" })
    expect(undeclared.state.error).toContain("k.undeclared")
  })

  it("lists what each shipped row registered, inside what its manifest declares", async () => {
    const report = await doctor(fresh())
    expect(row(report, "tool-files").registered).toEqual({ tools: ["edit", "read", "write"], ops: [] })
    expect(row(report, "artifacts").registered.ops.length).toBeGreaterThan(0)
    const shipped = report.rows.filter((diagnosis) => diagnosis.package.startsWith("ingle-plugin-"))
    expect(shipped.filter((diagnosis) => diagnosis.issues.length > 0 && diagnosis.state.kind !== "disabled")).toEqual(
      [],
    )
  })
})
