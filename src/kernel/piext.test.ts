import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { describe, expect, it } from "vitest"
import { answer, M8_MODEL, respond, tool } from "../../test/plugins/m8.ts"
import {
  clearObservations,
  HOOK_MARK,
  latest,
  record,
  SECTION_MARK,
  TASK_MARK,
  WRAP_MARK,
  XTask,
} from "../../test/plugins/piext.ts"
import { fresh, setRow } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
const installed = (stub: Stub, name: string): Promise<boolean> =>
  runInDurableObject(stub, (home: Home) => {
    try {
      home.extension(name)
      return true
    } catch {
      return false
    }
  })

async function turn(stub: Stub, requestId: string): Promise<string[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const before = (await results(home)).length
    await home.chooseModel(M8_MODEL)
    await home.submit("go", requestId)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    return (await results(home)).slice(before)
  })
}

async function results(home: Home): Promise<string[]> {
  const page = await (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)
  return page.items.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    ),
  )
}

async function observe(stub: Stub): Promise<void> {
  clearObservations()
  respond([record("noted")])
  await turn(stub, `turn-${crypto.randomUUID()}`)
}

describe("pi extensions installed by plugin rows", () => {
  it("records the installing row id on the installed extension", async () => {
    const stub = fresh()
    const row = (name: string): Promise<string | undefined> =>
      runInDurableObject(stub, (home: Home) => home.loader.ctx.pi.installed.get(name)?.row)

    expect(await row("x-hook")).toBeUndefined()
    await setRow(stub, "x-hook", true)
    expect(await row("x-hook")).toBe("x-hook")
  })

  it("runs a generation hook only while its row is active", async () => {
    const stub = fresh()
    expect(await installed(stub, "x-hook")).toBe(false)
    await setRow(stub, "x-hook", true)
    expect(await installed(stub, "x-hook")).toBe(true)
    await observe(stub)
    expect(latest().users.join(" ")).toContain(HOOK_MARK)

    await setRow(stub, "x-hook", false)
    expect(await installed(stub, "x-hook")).toBe(false)
    await observe(stub)
    expect(latest().users.join(" ")).not.toContain(HOOK_MARK)

    await setRow(stub, "x-hook", true)
    expect(await installed(stub, "x-hook")).toBe(true)
    await observe(stub)
    expect(latest().users.join(" ")).toContain(HOOK_MARK)
  })

  it("shows a prompt section only while its row is active", async () => {
    const stub = fresh()
    expect(await installed(stub, "x-section")).toBe(false)
    await setRow(stub, "x-section", true)
    expect(await installed(stub, "x-section")).toBe(true)
    await observe(stub)
    expect(latest().system).toContain(SECTION_MARK)

    await setRow(stub, "x-section", false)
    expect(await installed(stub, "x-section")).toBe(false)
    await observe(stub)
    expect(latest().system).not.toContain(SECTION_MARK)

    await setRow(stub, "x-section", true)
    expect(await installed(stub, "x-section")).toBe(true)
    await observe(stub)
    expect(latest().system).toContain(SECTION_MARK)
  })

  it("wraps a tool only while its row is active, leaving the tool itself working when unloaded", async () => {
    const stub = fresh()
    expect(await installed(stub, "x-wrap")).toBe(false)
    await setRow(stub, "x-wrap", true)
    expect(await installed(stub, "x-wrap")).toBe(true)
    respond([tool("current_time"), answer("done")])
    const [wrapped] = await turn(stub, "w1")
    expect(wrapped).toContain(WRAP_MARK)
    expect(wrapped).toContain("(UTC, ")

    await setRow(stub, "x-wrap", false)
    expect(await installed(stub, "x-wrap")).toBe(false)
    respond([tool("current_time"), answer("done")])
    const [plain] = await turn(stub, "w2")
    expect(plain).not.toContain(WRAP_MARK)
    expect(plain).toContain("(UTC, ")

    await setRow(stub, "x-wrap", true)
    expect(await installed(stub, "x-wrap")).toBe(true)
    respond([tool("current_time"), answer("done")])
    const [again] = await turn(stub, "w3")
    expect(again).toContain(WRAP_MARK)
  })

  it("runs a task defined by a plugin row and unloads the definition with it", async () => {
    const stub = fresh()
    expect(await installed(stub, "x-task")).toBe(false)
    await setRow(stub, "x-task", true)
    expect(await installed(stub, "x-task")).toBe(true)
    const settled = await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.root()
      const id = await conversation.commit(
        (tx) => tx.createTask(XTask, null, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      )
      return home.harness.waitForTask(id, BACKGROUND_CONTEXT)
    })
    expect(settled.state.outcome).toEqual({ status: "completed", result: { mark: TASK_MARK } })

    await setRow(stub, "x-task", false)
    expect(await installed(stub, "x-task")).toBe(false)
  })
})
