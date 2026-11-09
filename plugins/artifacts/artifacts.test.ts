import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { ArtifactsDoc } from "../../src/contracts/artifacts.ts"
import { M5_MODEL } from "../../test/plugins/m5.ts"
import type { CommandId } from "../../src/ids.ts"
import { cmd, eventually, field, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
type Stub = ReturnType<typeof fresh>

async function setup(stub: Stub): Promise<number> {
  const created = await cmd(stub, "create-alpha", "project.create", { slug: "alpha", name: "Alpha" })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { coordinatorId: number }
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(project.coordinatorId as ConversationId, context)
    if (conversation === undefined) throw new Error("no coordinator conversation")
    await conversation.configure({ model: M5_MODEL }, context)
  })
  const thread = await cmd(stub, "thread-1", "thread.create", {
    project: "alpha",
    title: "Artifact thread",
    task: "do it",
  })
  expect(thread.ok, JSON.stringify(thread)).toBe(true)
  return Number(field(thread.result, "threadId"))
}

describe("artifacts", () => {
  it("writes, reads, updates with a revision, reports a stale save, and deletes", async () => {
    const stub = fresh()
    const threadId = await setup(stub)

    const written = await cmd(stub, "artifact-write-1", "artifact.write", {
      threadId,
      title: "Plan",
      markdown: "# Plan",
    })
    expect(written.ok, JSON.stringify(written)).toBe(true)
    expect(written.result).toMatchObject({ revision: 1 })
    const id = String(field(written.result, "id"))

    const read = await cmd(stub, "artifact-read-1", "artifact.read", { threadId, id })
    expect(read.result).toMatchObject({ id, title: "Plan", markdown: "# Plan", revision: 1 })

    const updated = await cmd(stub, "artifact-write-2", "artifact.write", {
      threadId,
      id,
      title: "Plan",
      markdown: "# Plan v2",
      expectedRevision: 1,
    })
    expect(updated.result).toMatchObject({ revision: 2 })

    const stale = await cmd(stub, "artifact-write-3", "artifact.write", {
      threadId,
      id,
      title: "Plan",
      markdown: "# Plan v3",
      expectedRevision: 1,
    })
    expect(stale.result).toMatchObject({ kind: "stale", revision: 2, markdown: "# Plan v2" })

    const listed = await cmd(stub, "artifact-list-1", "artifact.list", { threadId })
    expect(Array.isArray(field(listed.result, "artifacts"))).toBe(true)
    expect((field(listed.result, "artifacts") as unknown[]).length).toBe(1)

    const deleted = await cmd(stub, "artifact-delete-1", "artifact.delete", { threadId, id })
    expect(deleted.result).toMatchObject({ deleted: true, id })
    const gone = await cmd(stub, "artifact-read-2", "artifact.read", { threadId, id })
    expect(gone).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })

  it("refuses a thread that targets a sibling thread's artifacts", async () => {
    const stub = fresh()
    const alpha = await setup(stub)
    const made = await cmd(stub, "thread-2", "thread.create", {
      project: "alpha",
      title: "Sibling",
      task: "other",
    })
    expect(made.ok, JSON.stringify(made)).toBe(true)
    const beta = Number(field(made.result, "threadId"))
    const asAlpha = (id: string, op: string, args: unknown) =>
      runInDurableObject(stub, (home: Home) =>
        home.commands.run(
          { id: id as CommandId, op, args },
          { kind: "agent", conversationId: alpha as ConversationId },
        ),
      )

    expect(
      await asAlpha("artifact-own", "artifact.write", { threadId: alpha, title: "Mine", markdown: "# Mine" }),
    ).toMatchObject({ kind: "ok" })
    for (const [op, args] of [
      ["artifact.list", { threadId: beta }],
      ["artifact.read", { threadId: beta, id: "art" }],
      ["artifact.write", { threadId: beta, title: "Stolen", markdown: "# Stolen" }],
      ["artifact.delete", { threadId: beta, id: "art" }],
    ] as const)
      expect(await asAlpha(`artifact-sibling-${op}`, op, args)).toMatchObject({ kind: "rejected", code: "bad_args" })

    const stored = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(ArtifactsDoc, beta as ConversationId, context),
    )
    expect(stored?.items ?? {}).toEqual({})
  })

  it("lets a thread write its own artifact through the tool", async () => {
    const stub = fresh()
    const threadId = await setup(stub)
    const sent = await cmd(stub, "artifact-thread-1", "thread.send", {
      threadId,
      text: "write artifact",
      mode: "steer",
    })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)

    await eventually(stub, async (home) => {
      const doc = await home.harness.snapshot(ArtifactsDoc, threadId as ConversationId, context)
      return Object.values(doc?.items ?? {}).some((artifact) => artifact.title === "Note")
    })
    const doc = await runInDurableObject(stub, (home: Home) =>
      home.harness.snapshot(ArtifactsDoc, threadId as ConversationId, context),
    )
    expect(Object.values(doc?.items ?? {})).toMatchObject([{ title: "Note", markdown: "# Note", revision: 1 }])
  })
})
