import { runInDurableObject } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cmd, connect, field, fresh, owner } from "../../test/support.ts"

const num = (value: unknown, key: string): number => {
  if (typeof value !== "number") throw new Error(`${key} is not a number: ${JSON.stringify(value)}`)
  return value
}

describe("system.metrics", () => {
  it("measures a fresh Home from its own rows, storage and push table", async () => {
    const ack = await cmd(fresh(), "metrics-fresh", "system.metrics")
    expect(ack).toMatchObject({ ok: true })
    const result = ack.result
    const rows = field(result, "rows")
    expect(num(field(result, "sockets"), "sockets")).toBe(0)
    expect(num(field(result, "pushDevices"), "pushDevices")).toBe(0)
    expect(num(field(result, "uptimeMs"), "uptimeMs")).toBeGreaterThanOrEqual(0)
    expect(num(field(result, "uptimeMs"), "uptimeMs")).toBeLessThan(60_000)
    expect(num(field(result, "storageBytes"), "storageBytes")).toBeGreaterThan(0)
    expect(num(field(rows, "total"), "rows.total")).toBeGreaterThan(0)
    expect(num(field(rows, "active"), "rows.active")).toBeGreaterThan(0)
    expect(num(field(rows, "active"), "rows.active")).toBeLessThanOrEqual(num(field(rows, "total"), "rows.total"))
  })

  it("counts the connected socket", async () => {
    const socket = await connect()
    try {
      const result = (await cmd(owner(), "metrics-socket", "system.metrics")).result
      expect(num(field(result, "sockets"), "sockets")).toBe(1)
    } finally {
      socket.close()
    }
  })
})

const texts = (result: unknown): readonly unknown[] => {
  const entries = field(result, "entries")
  if (!Array.isArray(entries)) throw new Error(`entries is not an array: ${JSON.stringify(entries)}`)
  return entries.map((entry) => field(entry, "text"))
}

describe("system.logs", () => {
  const consoleTarget = console
  let savedWarn = consoleTarget.warn
  let savedError = consoleTarget.error

  beforeEach(() => {
    savedWarn = consoleTarget.warn
    savedError = consoleTarget.error
  })

  afterEach(() => {
    consoleTarget.warn = savedWarn
    consoleTarget.error = savedError
  })

  it("answers a warning written inside the Home", async () => {
    const stub = fresh()
    await cmd(stub, "logs-boot", "system.version")
    await runInDurableObject(stub, () => {
      console.warn("probe from the test")
    })
    const ack = await cmd(stub, "logs-probe", "system.logs")
    expect(ack).toMatchObject({ ok: true })
    expect(texts(ack.result)).toContain("probe from the test")
  })

  it("lists the newest warning last", async () => {
    const stub = fresh()
    await cmd(stub, "logs-order-boot", "system.version")
    await runInDurableObject(stub, () => {
      console.warn("first probe")
      console.warn("second probe")
    })
    const listed = texts((await cmd(stub, "logs-order", "system.logs")).result)
    expect(listed.indexOf("first probe")).toBeGreaterThanOrEqual(0)
    expect(listed.indexOf("first probe")).toBeLessThan(listed.indexOf("second probe"))
  })
})
