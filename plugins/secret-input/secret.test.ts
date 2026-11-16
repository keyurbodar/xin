import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import type { CommandId } from "../../src/ids.ts"
import type { Outcome } from "../../src/ops.ts"
import { Sealer } from "../../src/seal.ts"
import { cardThread, threadReply, threadStatus } from "../../test/cards.ts"
import { cmd, connect, eventually, fresh, owner, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const VALUE = "hunter2-correct-horse-7f3a9c"
const NAME = "GITHUB_TOKEN"
const CARD = {
  search: "secret password token",
  tool: "request_secret",
  args: { name: NAME, label: "GitHub token", reason: "to open the pull request" },
}

const decoder = new TextDecoder()

const cellText = (cell: unknown): unknown => {
  if (cell instanceof ArrayBuffer) return decoder.decode(cell)
  if (ArrayBuffer.isView(cell)) return decoder.decode(cell)
  return cell
}

/** Every row of every table the Home's SQLite holds, BLOB cells (the pi journal and checkpoints) decoded to text. */
const everyRow = (stub: Stub): Promise<string> =>
  runInDurableObject(stub, (_home: Home, state: DurableObjectState) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
      .toArray()
    return tables
      .map(({ name }) =>
        state.storage.sql
          .exec(`SELECT * FROM "${name}"`)
          .toArray()
          .map((row) => JSON.stringify(Object.values(row).map(cellText)))
          .join("\n"),
      )
      .join("\n")
  })

/** Every object in the test env's file bucket, as text. */
async function everyObject(): Promise<{ readonly count: number; readonly text: string }> {
  const texts: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.FILES.list(cursor === undefined ? {} : { cursor })
    for (const object of page.objects) {
      const body = await env.FILES.get(object.key)
      texts.push(`${object.key} ${(await body?.text()) ?? ""}`)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return { count: texts.length, text: texts.join("\n") }
}

const sealedRow = (stub: Stub, ref: string): Promise<string | undefined> =>
  runInDurableObject(stub, async (home: Home) => {
    const row = await home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", `secret.${ref}`)
    return row?.value
  })

/** The plaintext the store keeps for a ref, unsealed with the test KEK. */
async function storedValue(stub: Stub, ref: string): Promise<string | undefined> {
  const row = await sealedRow(stub, ref)
  if (row === undefined) return undefined
  return new Sealer(env.KEK).unseal(JSON.parse(row), `credential:${ref}`)
}

const everyEntry = (stub: Stub, threadId: number): Promise<string> =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(threadId as ConversationId, context)
    if (conversation === undefined) throw new Error("no thread conversation")
    const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
    const requests = await home.harness.snapshot(RequestsDoc, threadId as ConversationId, context)
    return JSON.stringify({ entries: page.items, requests })
  })

const kindOf = (outcome: Outcome | undefined): string | undefined =>
  outcome?.kind === "ok" ? String(Reflect.get(Object(outcome.result), "kind")) : undefined

const provide = (stub: Stub, id: string, threadId: number, requestId: string, value?: string) =>
  cmd(stub, id, "secret.provide", { threadId, requestId, ...(value === undefined ? {} : { value }) })

describe("request_secret", () => {
  it("keeps the value out of the transcript, the result, every row and blob, R2, the socket, the logs and the next request", async () => {
    const stub = owner()
    const thread = await cardThread(stub, "secret-store", CARD)
    const opened = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(RequestsDoc, thread.threadId as ConversationId, context),
    )
    expect(opened?.open[thread.requestId]).toMatchObject({ kind: "request_secret", subject: NAME })

    const socket = await connect()
    try {
      for (const stream of ["home", `conv:${thread.threadId}`, `conv:${thread.coordinatorId}`]) {
        socket.send({ t: "sub", stream })
        await socket.next((frame) => frame.t === "snap" && frame.stream === stream)
      }

      const provided = await provide(stub, "secret-provide", thread.threadId, thread.requestId, VALUE)
      expect(provided.result).toMatchObject({ kind: "answered", run: 2 })
      expect(JSON.stringify(provided)).not.toContain(VALUE)

      const reply = await threadReply(stub, thread, `stored as ${NAME}`)
      await eventually(stub, async (home: Home) => (await threadStatus(home, thread.threadId)) === "completed")
      await socket.next((frame) => frame.t === "ev" && frame.stream === `conv:${thread.threadId}`)

      expect(await storedValue(stub, NAME)).toBe(VALUE)
      expect(await sealedRow(stub, NAME)).not.toContain(VALUE)
      expect(reply.text).toContain(`stored as ${NAME}`)
      for (const seen of thread.seen) expect(seen.text).not.toContain(VALUE)
      expect(await everyEntry(stub, thread.threadId)).not.toContain(VALUE)

      const rows = await everyRow(stub)
      expect(rows, "the scan reads the journal blobs").toContain(`stored as ${NAME}`)
      expect(rows).not.toContain(VALUE)

      await env.FILES.put("cards/seed.txt", "a seeded object, so the scan has something to read")
      const objects = await everyObject()
      expect(objects.count, "the scan reads the bucket").toBeGreaterThan(0)
      expect(objects.text).not.toContain(VALUE)

      const frames = socket.received().join("\n")
      expect(frames, "the socket carried the card").toContain(NAME)
      expect(frames).not.toContain(VALUE)

      expect(JSON.stringify(await cmd(stub, "secret-list", "request.list"))).not.toContain(VALUE)
      expect(JSON.stringify(await cmd(stub, "secret-logs", "system.logs"))).not.toContain(VALUE)
    } finally {
      socket.close()
    }
  }, 30_000)

  it("answers declined without storing anything", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "secret-decline", CARD)
    const declined = await provide(stub, "secret-decline", thread.threadId, thread.requestId)
    expect(declined.result).toMatchObject({ kind: "answered" })
    const reply = await threadReply(stub, thread, "declined")
    expect(reply.text).toContain("declined")
    expect(await sealedRow(stub, NAME)).toBeUndefined()

    const again = await provide(stub, "secret-again", thread.threadId, thread.requestId, VALUE)
    expect(again.result).toMatchObject({ kind: "already_answered", answer: "declined" })
    expect(await sealedRow(stub, NAME)).toBeUndefined()
  }, 30_000)

  it("stores nothing and leaves an existing secret alone when the thread was stopped", async () => {
    const stub = fresh()
    expect(await cmd(stub, "secret-existing", "secret.set", { ref: NAME, value: "the-old-token" })).toMatchObject({
      ok: true,
    })
    const before = await sealedRow(stub, NAME)
    const thread = await cardThread(stub, "secret-stopped", CARD)
    expect(await cmd(stub, "secret-stop", "thread.stop", { threadId: thread.threadId })).toMatchObject({ ok: true })
    expect(await runInDurableObject(stub, (home: Home) => threadStatus(home, thread.threadId))).not.toBe("waiting")

    const late = await provide(stub, "secret-late", thread.threadId, thread.requestId, VALUE)
    expect(late.ok).toBe(false)
    expect(await sealedRow(stub, NAME)).toBe(before)
    expect(await storedValue(stub, NAME)).toBe("the-old-token")
  }, 30_000)

  it("lets one of two concurrent provides store its value and answer", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "secret-race", CARD)
    const updates: string[] = []
    await runInDurableObject(stub, (home: Home) => {
      home.loader.ctx.on("credentials/updated", (ref) => {
        updates.push(ref)
      })
    })
    const [first, second] = await runInDurableObject(stub, (home: Home) =>
      Promise.all(
        ["a", "b"].map((side) =>
          home.loader.ctx.ops.run(
            {
              id: `secret-race-${side}` as CommandId,
              op: "secret.provide",
              args: { threadId: thread.threadId, requestId: thread.requestId, value: `value-from-${side}` },
            },
            { kind: "owner" },
          ),
        ),
      ),
    )
    const answered = [first, second].filter((outcome) => kindOf(outcome) === "answered")
    expect(answered, JSON.stringify([first, second])).toHaveLength(1)
    const other = answered[0] === first ? second : first
    expect(other?.kind === "rejected" || kindOf(other) === "already_answered", JSON.stringify(other)).toBe(true)
    expect(updates).toEqual([NAME])
    expect(await storedValue(stub, NAME)).toBe(answered[0] === first ? "value-from-a" : "value-from-b")
  }, 30_000)

  it("cannot be answered with free text, so a typed secret never reaches the run", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "secret-free", CARD)
    const typed = await cmd(stub, "secret-typed", "request.respond", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      answer: VALUE,
    })
    expect(typed).toMatchObject({ ok: false })
    expect(await runInDurableObject(stub, (home: Home) => threadStatus(home, thread.threadId))).toBe("waiting")
    expect(await everyEntry(stub, thread.threadId)).not.toContain(VALUE)

    const stray = await provide(stub, "secret-stray", thread.threadId, "q:not-a-request", VALUE)
    expect(stray).toMatchObject({ ok: false })
  }, 30_000)
})
