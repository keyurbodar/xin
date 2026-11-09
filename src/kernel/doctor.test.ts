import { describe, expect, it } from "vitest"
import { cmd, fresh, type Stub } from "../../test/support.ts"

type Issue = { readonly kind: string; readonly [key: string]: unknown }

type Diagnosis = {
  readonly id: string
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
      package: "xin-plugin-market",
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
})
