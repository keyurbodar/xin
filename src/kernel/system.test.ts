import { describe, expect, it } from "vitest"
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
