import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const CREATE_WRITE_BOUND = 12
const COMMENT_WRITE_BOUND = 9
const LIST_READ_BOUND = 24
const GET_READ_BOUND = 9
const SEARCH_READ_BOUND = 320
const SEARCH_ISSUES = 300

const billed = (stub: Stub) =>
  runInDurableObject(stub, (home: Home) => {
    const meter = home.meter()
    return {
      written: meter.sql.writes + meter.kv.writes + meter.alarm.writes,
      read: meter.sql.reads + meter.kv.reads + meter.alarm.reads,
    }
  })

async function measure(stub: Stub, action: () => Promise<unknown>): Promise<{ written: number; read: number }> {
  const before = await billed(stub)
  await action()
  const after = await billed(stub)
  return { written: after.written - before.written, read: after.read - before.read }
}

let seq = 0
async function op(stub: Stub, name: string, args: unknown): Promise<unknown> {
  const ack = await cmd(stub, `issue-cost-${(seq += 1)}`, name, args)
  if (!ack.ok) throw new Error(`${name}: ${JSON.stringify(ack.error)}`)
  return ack.result
}

describe("issues, in what the platform bills", () => {
  it("creates, comments, lists and reads within the measured row bounds", async () => {
    const stub = fresh()
    await op(stub, "issue.create", { title: "Warm the home" })

    const create = await measure(stub, () =>
      op(stub, "issue.create", {
        title: "Cost of one issue",
        description: "rows written by an issue with two labels and an assignee",
        labels: ["cost", "backend"],
        assignees: [{ kind: "person", id: "owner" }],
      }),
    )
    const comment = await measure(stub, () => op(stub, "issue.comment", { id: 2, body: "one comment" }))
    for (let n = 0; n < 18; n += 1) await op(stub, "issue.create", { title: `Filler ${n}` })
    const list = await measure(stub, () => op(stub, "issue.list", { limit: 20 }))
    const get = await measure(stub, () => op(stub, "issue.get", { id: 2 }))

    expect(create.written).toBeLessThanOrEqual(CREATE_WRITE_BOUND)
    expect(comment.written).toBeLessThanOrEqual(COMMENT_WRITE_BOUND)
    expect(list.read).toBeLessThanOrEqual(LIST_READ_BOUND)
    expect(get.read).toBeLessThanOrEqual(GET_READ_BOUND)
  })

  it("keeps a broad search over many issues within the measured read bound", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      const issues = home.loader.ctx.get("issues")
      if (issues === undefined) throw new Error("no issues service")
      for (let n = 0; n < SEARCH_ISSUES; n += 1)
        await issues.create({ kind: "person", id: "owner" }, { title: `task ${n} alpha`, description: "a shared task" })
    })
    const broad = await measure(stub, () => op(stub, "issue.list", { q: "task", limit: 50 }))
    const short = await measure(stub, () => op(stub, "issue.list", { q: "a", limit: 50 }))
    expect(broad.read).toBeLessThanOrEqual(SEARCH_READ_BOUND)
    expect(short.read).toBeLessThanOrEqual(SEARCH_READ_BOUND)
  })
})
