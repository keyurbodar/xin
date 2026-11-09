import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, eventually, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Reflect.get(value, key)
  return typeof found === "string" ? found : undefined
}

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `create-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const id = stringField(created.result, "id")
  const coordinatorId =
    typeof created.result === "object" && created.result !== null
      ? Reflect.get(created.result, "coordinatorId")
      : undefined
  if (id === undefined || typeof coordinatorId !== "number") throw new Error("project.create returned no project")
  return { id, coordinatorId }
}

async function entriesOf(home: Home, conversationId: number): Promise<readonly EntryRecord[]> {
  const conversation = await home.harness.conversation(conversationId as ConversationId, context)
  if (conversation === undefined) return []
  const page = await conversation.entries({ order: "descending" }, 50, undefined, context)
  return page.items
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

describe("failures", () => {
  it("reports a run failure and resubmits its batch on message.retry", async () => {
    const stub = fresh()
    const project = await makeProject(stub, "retry")
    const sent = await cmd(stub, "retry-1", "message.send", { conv: project.coordinatorId, text: "hello" })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    await fireNow(stub)

    await eventually(stub, async (home: Home) =>
      (await entriesOf(home, project.coordinatorId)).some((entry) => entry.kind === "xin.error"),
    )
    const entries = await runInDurableObject(stub, (home: Home) => entriesOf(home, project.coordinatorId))
    const error = entries.find((entry) => entry.kind === "xin.error")
    const batch = entries.find((entry) => entry.kind === "xin.batch")
    expect(error?.data).toMatchObject({ reason: "no_model" })
    expect(stringField(error?.data, "batchId")).toBeDefined()
    expect(batch).toBeDefined()

    const bad = await cmd(stub, "retry-bad", "message.retry", { entryId: batch?.id })
    expect(bad.ok).toBe(false)
    expect(bad.error?.code).toBe("bad_args")

    const original = await runInDurableObject(stub, async (home: Home) =>
      (await home.intake()).find((item) => item.commandId === "retry-1"),
    )
    expect(original).toBeDefined()

    const retried = await cmd(stub, "retry-op", "message.retry", { entryId: error?.id })
    expect(retried.ok, JSON.stringify(retried)).toBe(true)
    expect(retried.result).toEqual({ resubmitted: 1 })

    const rows = await runInDurableObject(stub, async (home: Home) =>
      (await home.intake())
        .filter((item) => item.commandId.startsWith("retry:"))
        .map((item) => ({ commandId: item.commandId, status: item.status })),
    )
    expect(rows).toEqual([{ commandId: `retry:${error?.id}:${original?.id}`, status: "pending" }])
  }, 20_000)
})
