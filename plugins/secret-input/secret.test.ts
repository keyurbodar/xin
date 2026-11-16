import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { RequestsDoc } from "../../src/contracts/questions.ts"
import { cardThread, threadReply, threadStatus } from "../../test/cards.ts"
import { cmd, eventually, fresh, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const VALUE = "hunter2-correct-horse-7f3a9c"
const CARD = {
  row: "tool-secret-input",
  search: "secret password token",
  tool: "request_secret",
  args: { name: "GITHUB_TOKEN", label: "GitHub token", reason: "to open the pull request" },
}

/** Every row of every table the Home's SQLite holds, the pi journal included, as one string. */
const everyRow = (stub: Stub): Promise<string> =>
  runInDurableObject(stub, (_home: Home, state: DurableObjectState) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
      .toArray()
    return tables
      .map(({ name }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()))
      .join("\n")
  })

/** The sealed row the secret store keeps for a ref: present once stored, never the plaintext. */
const sealedRow = (stub: Stub, ref: string): Promise<string | undefined> =>
  runInDurableObject(stub, async (home: Home) => {
    const row = await home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", `secret.${ref}`)
    return row?.value
  })

const everyEntry = (stub: Stub, threadId: number): Promise<string> =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(threadId as ConversationId, context)
    if (conversation === undefined) throw new Error("no thread conversation")
    const page = await conversation.entries({ order: "ascending" }, 500, undefined, context)
    const requests = await home.harness.snapshot(RequestsDoc, threadId as ConversationId, context)
    return JSON.stringify({ entries: page.items, requests })
  })

describe("request_secret", () => {
  it("keeps the value out of the transcript, the result, every stored row, the logs and the next request", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "secret-store", CARD)
    const opened = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(RequestsDoc, thread.threadId as ConversationId, context),
    )
    expect(opened?.open[thread.requestId]).toMatchObject({ kind: "request_secret", subject: "GITHUB_TOKEN" })

    const provided = await cmd(stub, "secret-provide", "secret.provide", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      value: VALUE,
    })
    expect(provided.result).toMatchObject({ kind: "answered", run: 2 })
    expect(JSON.stringify(provided)).not.toContain(VALUE)

    const reply = await threadReply(stub, thread, "stored as GITHUB_TOKEN")
    await eventually(stub, async (home: Home) => (await threadStatus(home, thread.threadId)) === "completed")

    const sealed = await sealedRow(stub, "GITHUB_TOKEN")
    expect(sealed).toBeDefined()
    expect(sealed).not.toContain(VALUE)
    expect(reply.text).toContain("stored as GITHUB_TOKEN")
    for (const seen of thread.seen) expect(seen.text).not.toContain(VALUE)
    expect(await everyEntry(stub, thread.threadId)).not.toContain(VALUE)
    expect(await everyRow(stub)).not.toContain(VALUE)
    expect(JSON.stringify(await cmd(stub, "secret-list", "request.list"))).not.toContain(VALUE)
    expect(JSON.stringify(await cmd(stub, "secret-logs", "system.logs"))).not.toContain(VALUE)
  }, 30_000)

  it("answers declined without storing anything", async () => {
    const stub = fresh()
    const thread = await cardThread(stub, "secret-decline", CARD)
    const declined = await cmd(stub, "secret-decline", "secret.provide", {
      threadId: thread.threadId,
      requestId: thread.requestId,
    })
    expect(declined.result).toMatchObject({ kind: "answered" })
    const reply = await threadReply(stub, thread, "declined")
    expect(reply.text).toContain("declined")
    expect(await sealedRow(stub, "GITHUB_TOKEN")).toBeUndefined()

    const again = await cmd(stub, "secret-again", "secret.provide", {
      threadId: thread.threadId,
      requestId: thread.requestId,
      value: VALUE,
    })
    expect(again.result).toMatchObject({ kind: "already_answered", answer: "declined" })
    expect(await sealedRow(stub, "GITHUB_TOKEN")).toBeUndefined()
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

    const stray = await cmd(stub, "secret-stray", "secret.provide", {
      threadId: thread.threadId,
      requestId: "q:not-a-request",
      value: VALUE,
    })
    expect(stray).toMatchObject({ ok: false })
  }, 30_000)
})
