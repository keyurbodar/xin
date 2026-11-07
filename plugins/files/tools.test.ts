import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, field, fresh, recordOffers, rowState, turn } from "../../test/support.ts"

const FILE_TOOLS = ["edit", "read", "write"]

describe("files tool row", () => {
  it("offers the text tools only while tool-files is enabled, and the files service keeps serving", async () => {
    const stub = fresh()
    const offers = recordOffers()

    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILE_TOOLS))

    const disabled = await cmd(stub, "off", "plugin.enable", { id: "tool-files", enabled: false })
    expect(disabled.result).toMatchObject({ application: "applied", row: { state: { kind: "disabled" } } })

    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    const hidden = offers.latest().tools
    for (const name of FILE_TOOLS) expect(hidden).not.toContain(name)
    expect(hidden).toContain("capabilities")

    const path = `/projects/m4/tool-row-${crypto.randomUUID()}.txt`
    const put = await cmd(stub, "put", "file.put", { path, text: "still here" })
    expect(put).toMatchObject({ ok: true, result: { path, size: 10 } })
    const listed = await cmd(stub, "ls", "file.list", { prefix: "/projects/m4" })
    expect(Array.isArray(listed.result) ? listed.result.map((entry) => field(entry, "path")) : []).toContain(path)
    expect(await rowState(stub, "files")).toEqual({ kind: "active" })

    const enabled = await cmd(stub, "on", "plugin.enable", { id: "tool-files", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })

    respond([offers.step()])
    await turn(stub, `turn-${crypto.randomUUID()}`)
    expect(offers.latest().tools).toEqual(expect.arrayContaining(FILE_TOOLS))
    expect(await rowState(stub, "files")).toEqual({ kind: "active" })
  })
})
