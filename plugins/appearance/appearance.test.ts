import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"

const id = (): string => crypto.randomUUID()

describe("appearance", () => {
  it("reads empty, then returns what the last set stored", async () => {
    const stub = fresh()
    const empty = await cmd(stub, id(), "appearance.read")
    expect(empty).toMatchObject({ ok: true, result: { doc: null, rev: 0 } })

    const doc = JSON.stringify({ v: 1, theme: "dark", ui: { textScale: 110 } })
    const saved = await cmd(stub, id(), "appearance.set", { doc, rev: 0 })
    expect(saved).toMatchObject({ ok: true, result: { rev: 1 } })

    const read = await cmd(stub, id(), "appearance.read")
    expect(read).toMatchObject({ ok: true, result: { doc, rev: 1 } })
  })

  it("refuses a save from a tab that read an older revision", async () => {
    const stub = fresh()
    await cmd(stub, id(), "appearance.set", { doc: '{"theme":"light"}', rev: 0 })
    const stale = await cmd(stub, id(), "appearance.set", { doc: '{"theme":"rose"}', rev: 0 })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe("busy")
    const read = await cmd(stub, id(), "appearance.read")
    expect(read).toMatchObject({ result: { doc: '{"theme":"light"}', rev: 1 } })
  })

  it("refuses a save that does not name the revision it read", async () => {
    const stub = fresh()
    await cmd(stub, id(), "appearance.set", { doc: '{"theme":"light"}', rev: 0 })
    const blind = await cmd(stub, id(), "appearance.set", { doc: '{"theme":"rose"}' })
    expect(blind.ok).toBe(false)
    expect(blind.error?.code).toBe("bad_args")
    const read = await cmd(stub, id(), "appearance.read")
    expect(read).toMatchObject({ result: { doc: '{"theme":"light"}', rev: 1 } })
  })

  it("refuses a doc that is not a JSON object", async () => {
    const stub = fresh()
    for (const doc of ["[1,2]", "nope", '"text"']) {
      const reply = await cmd(stub, id(), "appearance.set", { doc, rev: 0 })
      expect(reply.ok).toBe(false)
      expect(reply.error?.code).toBe("bad_args")
    }
  })
})
