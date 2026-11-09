import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable"
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { MARK } from "../../test/plugins/intakebatch.ts"
import { eventually, fresh, setRow } from "../../test/support.ts"
import { FAUX_MODEL, type Home } from "../../test/worker.ts"
import { IntakeDoc } from "../../src/contracts/intake.ts"
import type { CommandId } from "../../src/ids.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>

const send = async (stub: Stub, id: string, text: string): Promise<void> => {
  const outcome = await runInDurableObject(stub, (home: Home) =>
    home.commands.run({ id: id as CommandId, op: "message.send", args: { text, clientTs: 1_000 } }, { kind: "owner" }),
  )
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ok" })
}

async function script(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    home.script(["noted"])
    await home.chooseModel(FAUX_MODEL)
  })
}

async function fireNow(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (home: Home) => home.fireIntake())
  await runDurableObjectAlarm(stub)
}

async function history(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
  return [...page.items]
}

const texts = (entries: readonly EntryRecord[], role: "user" | "assistant"): string[] =>
  entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === role && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : message.role === role && typeof message.content === "string"
          ? [message.content]
          : [],
    ),
  )

const users = (stub: Stub): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) => texts(await history(await home.root()), "user"))

describe("intake/batch event", () => {
  it("lets a listener rewrite the text the model receives", async () => {
    const stub = fresh()
    await script(stub)
    await setRow(stub, "intakebatch", true)
    await send(stub, "rewrite-1", "hello")
    await fireNow(stub)
    await eventually(stub, async (home: Home) => texts(await history(await home.root()), "user").length === 1)
    expect(await users(stub)).toEqual([`<msg t="00:00:01">${MARK} hello</msg>`])
  })

  it("marks a batch done without dispatching when a listener drops it", async () => {
    const stub = fresh()
    await script(stub)
    await setRow(stub, "intakebatch", true)
    const configured = await runInDurableObject(stub, (home: Home) =>
      home.commands.run(
        {
          id: "intakebatch-drop" as CommandId,
          op: "plugin.configure",
          args: { id: "intakebatch", config: { mode: "drop" } },
        },
        { kind: "owner" },
      ),
    )
    expect(configured, JSON.stringify(configured)).toMatchObject({
      kind: "ok",
      result: { application: "applied" },
    })
    await send(stub, "drop-1", "hello")
    await fireNow(stub)
    await eventually(stub, async (home: Home) => (await home.intake()).every((item) => item.status === "done"))
    expect(await users(stub)).toEqual([])
  })

  it("rewrites a claimed batch recovered at boot after the listener row mounts", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["noted"])
      await home.chooseModel(FAUX_MODEL)
    })
    await setRow(stub, "intakebatch", true)
    await runInDurableObject(stub, async (home: Home) => {
      const root = await home.root()
      await home.harness.commit(async (tx) => {
        const doc = await tx.doc(IntakeDoc)
        doc.items.push({
          id: 1,
          target: root.id,
          kind: "user",
          commandId: "recovered-1",
          body: JSON.stringify({ kind: "user", text: "hello" }),
          clientTs: 1_000,
          firstAt: 1_000,
          fireAt: 1_000,
          status: "claimed",
          batchId: "recovered-batch",
        })
        doc.nextId = 2
      }, context)
    })
    await evictDurableObject(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await eventually(stub, async (home: Home) => texts(await history(await home.root()), "user").length === 1)
    expect(await users(stub)).toEqual([`<msg t="00:00:01">${MARK} hello</msg>`])
  })

  it("dispatches the batch as given when a listener throws", async () => {
    const stub = fresh()
    await script(stub)
    await runInDurableObject(stub, (home: Home) => {
      home.loader.ctx.on("intake/batch", () => {
        throw new Error("listener exploded")
      })
    })
    await send(stub, "throw-1", "hello")
    await fireNow(stub)
    await eventually(stub, async (home: Home) => texts(await history(await home.root()), "user").length === 1)
    expect(await users(stub)).toEqual([`<msg t="00:00:01">hello</msg>`])
    await eventually(stub, async (home: Home) => (await home.intake()).every((item) => item.status === "done"))
  })

  it("does not resend unrewritten text when a restart picks up an earlier batch", async () => {
    const stub = fresh()
    await runInDurableObject(stub, async (home: Home) => {
      home.script(["hang", "combined"])
      await home.chooseModel(FAUX_MODEL)
    })
    await setRow(stub, "intakebatch", true)
    await send(stub, "restart-1", "alpha")
    await fireNow(stub)
    await runInDurableObject(stub, (home: Home) => home.hanging.promise)
    await send(stub, "restart-2", "beta")
    await fireNow(stub)
    await eventually(stub, async (home: Home) =>
      texts(await history(await home.root()), "assistant").includes("combined"),
    )
    const said = await users(stub)
    expect(said).toHaveLength(2)
    const last = said.at(-1) ?? ""
    expect(last).toContain(`${MARK} alpha`)
    expect(last).toContain(`${MARK} beta`)
    expect(last.split(MARK).length - 1).toBe(2)
  })
})
