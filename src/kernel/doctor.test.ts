import { describe, expect, it } from "vitest"
import { cmd, fresh, type Stub } from "../../test/support.ts"

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
    const reply = await cmd(fresh(), "k-reach-1", "k.reach")
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
      frame: expect.stringContaining("may not deliver socket frames"),
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
