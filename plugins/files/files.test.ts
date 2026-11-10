import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { api, addThreads, cmd, field, owner } from "../../test/support.ts"
import { M4_MODEL } from "../../test/plugins/m4.ts"
import { type Home } from "../../test/worker.ts"
import { sweep } from "./files.ts"
import type { CommandId, PluginId } from "../../src/ids.ts"
import type { Actor, Outcome } from "../../src/ops.ts"
import { blobKey, FileIndex, type FileRow, R2Env } from "../../src/r2env.ts"

const rowOf = (path: string): Promise<FileRow | undefined> =>
  runInDurableObject(owner(), (home: Home) => new FileIndex(home.db).row(path))

const put = (path: string, body: string, headers?: Record<string, string>) =>
  api(`/files${path}`, { method: "PUT", body, ...(headers === undefined ? {} : { headers }) })

const run = (id: string, op: string, args: Record<string, string>, actor: Actor): Promise<Outcome> =>
  runInDurableObject(owner(), (home: Home) => home.commands.run({ id: id as CommandId, op, args }, actor))

const toolTexts = (home: Home, id: ConversationId): Promise<string[]> =>
  home.harness.conversation(id, BACKGROUND_CONTEXT).then(async (conversation) => {
    if (conversation === undefined) throw new Error("conversation disappeared")
    const page = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
    return page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult"
          ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      ),
    )
  })

describe("files", () => {
  it("streams a web upload into R2 and commits metadata without carrying the body to the DO", async () => {
    const path = "/projects/m4/upload.txt"
    const body = "xin-upload:" + "x".repeat(2 * 1024 * 1024)
    const reply = await put(path, body, { "content-type": "text/plain" })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({ path, size: body.length, type: "text/plain" })

    const row = await rowOf(path)
    if (row === undefined) throw new Error("upload did not commit a files row")
    expect(row).toMatchObject({ path, size: body.length, type: "text/plain", project: "m4" })
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)

    const object = await env.FILES.get(row.r2_key)
    if (object === null) throw new Error("upload did not store bytes in R2")
    expect(await object.text()).toBe(body)

    const databaseSize = await runInDurableObject(owner(), (_home, state) => state.storage.sql.databaseSize)
    expect(databaseSize).toBeLessThan(body.length / 4)

    const direct = await owner().fetch(
      new Request("https://xin.internal/v1/files/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(8192),
      }),
    )
    expect(direct.status).toBe(413)
  })

  it("stores identical content once under its content address", async () => {
    const first = "/projects/m4/same-a.txt"
    const second = "/projects/m4/same-b.txt"
    const body = `identical-${crypto.randomUUID()}`
    for (const path of [first, second]) expect((await put(path, body)).status).toBe(200)

    const rows = await runInDurableObject(owner(), async (home: Home) => {
      const indexed = await new FileIndex(home.db).under("/projects/m4/")
      return indexed.filter((row) => row.path === first || row.path === second)
    })
    expect(rows).toHaveLength(2)
    const [a, b] = rows
    expect(a?.r2_key).toBe(b?.r2_key)
    const shared = a?.r2_key ?? ""
    const listed = await env.FILES.list({ prefix: shared })
    expect(listed.objects.map((object) => object.key)).toEqual([shared])
  })

  it("round-trips a file through pi's write and read tools over R2Env", async () => {
    const stub = owner()
    const path = `/projects/m4/roundtrip-${crypto.randomUUID()}.txt`
    const content = "hello from r2"

    await runInDurableObject(stub, async (home: Home) => {
      await home.chooseModel(M4_MODEL)
      await home.submit(`m4 write ${path}\n${content}`, `m4-${crypto.randomUUID()}`)
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })

    const row = await rowOf(path)
    if (row === undefined) throw new Error("the write tool did not index the file")
    expect(row).toMatchObject({ path, size: content.length, type: "text/plain", project: "m4" })
    const object = await env.FILES.get(row.r2_key)
    if (object === null) throw new Error("the write tool did not store bytes in R2")
    expect(await object.text()).toBe(content)

    const answers = await runInDurableObject(stub, async (home: Home) => {
      const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
      return page.items.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        ),
      )
    })
    expect(answers).toContain(`read back: ${content}`)
  })

  it("blocks a non-root agent write to /me through a relative path", async () => {
    const stub = owner()
    const id = await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: M4_MODEL, cwd: "/projects/a" } },
        BACKGROUND_CONTEXT,
      )
      await conversation.submit(
        { type: "input", content: "m4 write ../../me/escape.txt\nblocked", requestId: `escape-${crypto.randomUUID()}` },
        BACKGROUND_CONTEXT,
      )
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return conversation.id
    })

    const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, id))
    expect(texts.some((text) => text.includes("only the coordinator may use /me"))).toBe(true)
    expect(await rowOf("/me/escape.txt")).toBeUndefined()
  })

  it("applies the write scope to file.put and file.delete", async () => {
    const stub = owner()
    const threadId = await runInDurableObject(
      stub,
      async (home: Home) =>
        (await home.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)).id,
    )
    const path = `/me/scope-${crypto.randomUUID()}.txt`
    const plugin: Actor = { kind: "plugin", pluginId: "test" as PluginId }
    const thread: Actor = { kind: "agent", conversationId: threadId }

    expect(await run(`plugin-put-${path}`, "file.put", { path, text: "x" }, plugin)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run(`thread-put-${path}`, "file.put", { path, text: "x" }, thread)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run(`plugin-delete-${path}`, "file.delete", { path }, plugin)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run(`thread-delete-${path}`, "file.delete", { path }, thread)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run(`owner-put-${path}`, "file.put", { path, text: "x" }, { kind: "owner" })).toMatchObject({
      kind: "ok",
    })
  })

  it("confines a thread to its own project for writes and reads", async () => {
    const stub = owner()
    const created = await cmd(stub, "thread-scope-project", "project.create", { slug: "alpha", name: "Alpha" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { id: string }
    const [thread] = await addThreads(stub, project.id, ["alpha thread"], "/projects/alpha")
    if (thread === undefined) throw new Error("no thread")
    const actor: Actor = { kind: "agent", conversationId: thread.id }

    expect(
      await run("thread-own-put", "file.put", { path: "/projects/alpha/own.txt", text: "own" }, actor),
    ).toMatchObject({ kind: "ok" })
    expect(await run("thread-own-read", "file.read", { path: "/projects/alpha/own.txt" }, actor)).toMatchObject({
      kind: "ok",
      result: { text: "own" },
    })
    expect(await run("thread-own-list", "file.list", { prefix: "/projects/alpha/" }, actor)).toMatchObject({
      kind: "ok",
    })
    expect(
      await run("thread-other-put", "file.put", { path: "/projects/beta/other.txt", text: "no" }, actor),
    ).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run("thread-other-read", "file.read", { path: "/projects/beta/other.txt" }, actor)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await run("thread-other-list", "file.list", { prefix: "/projects/beta/" }, actor)).toMatchObject({
      kind: "rejected",
      code: "forbidden",
    })
    expect(await rowOf("/projects/beta/other.txt")).toBeUndefined()
  })

  it("blocks a thread's pi write outside its project", async () => {
    const stub = owner()
    const created = await cmd(stub, "thread-hook-project", "project.create", { slug: "hook", name: "Hook" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { id: string }
    const [thread] = await addThreads(stub, project.id, ["hook thread"], "/projects/hook")
    if (thread === undefined) throw new Error("no thread")

    await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(thread.id, BACKGROUND_CONTEXT)
      if (conversation === undefined) throw new Error("thread conversation disappeared")
      await conversation.configure({ model: M4_MODEL }, BACKGROUND_CONTEXT)
      await conversation.submit(
        {
          type: "input",
          content: "m4 write ../outside/escape.txt\nblocked",
          requestId: `hook-${crypto.randomUUID()}`,
        },
        BACKGROUND_CONTEXT,
      )
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    })

    const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
    expect(texts.some((text) => text.includes("a thread may only use /projects/hook/"))).toBe(true)
    expect(await rowOf("/projects/outside/escape.txt")).toBeUndefined()
  })

  it("blocks a thread's pi read of /me and of another project", async () => {
    const stub = owner()
    const created = await cmd(stub, "thread-read-project", "project.create", { slug: "reader", name: "Reader" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { id: string }
    const [thread] = await addThreads(stub, project.id, ["reader thread"], "/projects/reader")
    if (thread === undefined) throw new Error("no thread")
    expect((await put("/me/owner-only.txt", "owner secret")).status).toBe(200)
    expect((await put("/projects/other/other-only.txt", "other secret")).status).toBe(200)

    const read = async (path: string): Promise<string[]> => {
      await runInDurableObject(stub, async (home: Home) => {
        const conversation = await home.harness.conversation(thread.id, BACKGROUND_CONTEXT)
        if (conversation === undefined) throw new Error("thread conversation disappeared")
        await conversation.configure({ model: M4_MODEL }, BACKGROUND_CONTEXT)
        await conversation.submit(
          { type: "input", content: `m4 read ${path}`, requestId: `read-${crypto.randomUUID()}` },
          BACKGROUND_CONTEXT,
        )
        await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      })
      return runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
    }

    const me = await read("/me/owner-only.txt")
    expect(me.some((text) => text.includes("only the coordinator may use /me"))).toBe(true)
    expect(me.some((text) => text.includes("owner secret"))).toBe(false)

    const other = await read("/projects/other/other-only.txt")
    expect(other.some((text) => text.includes("a thread may only use /projects/reader/"))).toBe(true)
    expect(other.some((text) => text.includes("other secret"))).toBe(false)
  }, 30_000)

  it("blocks a write to /me written with a leading @", async () => {
    const stub = owner()
    const id = await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: M4_MODEL, cwd: "/projects/a" } },
        BACKGROUND_CONTEXT,
      )
      await conversation.submit(
        { type: "input", content: "m4 write @/me/at.txt\nblocked", requestId: `at-${crypto.randomUUID()}` },
        BACKGROUND_CONTEXT,
      )
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      return conversation.id
    })

    const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, id))
    expect(texts.some((text) => text.includes("only the coordinator may use /me"))).toBe(true)
    expect(await rowOf("/me/at.txt")).toBeUndefined()
  })

  it("lists a directory that exists only as row prefixes from a cold environment", async () => {
    const stub = owner()
    const name = `nested-${crypto.randomUUID()}.txt`
    expect((await put(`/projects/m4/deep/${name}`, "deep bytes")).status).toBe(200)

    const listed = await runInDurableObject(stub, async (home: Home) => {
      const files = new R2Env(env.FILES, home.db, { cwd: "/" })
      const deep = await files.listDir("/projects/m4/deep", BACKGROUND_CONTEXT)
      const parent = await files.listDir("/projects/m4", BACKGROUND_CONTEXT)
      if (!deep.ok) throw new Error(`${deep.error.code}: ${deep.error.message}`)
      if (!parent.ok) throw new Error(`${parent.error.code}: ${parent.error.message}`)
      return {
        deep: deep.value.map((entry) => entry.name),
        parent: parent.value.map((entry) => ({ name: entry.name, kind: entry.kind })),
      }
    })
    expect(listed.deep).toContain(name)
    expect(listed.parent).toContainEqual({ name: "deep", kind: "directory" })
  })

  it("hands a stored text file back through file.read and refuses a missing path", async () => {
    const path = `/projects/m4/read-${crypto.randomUUID()}.md`
    expect((await put(path, "# Vendor comparison\n", { "content-type": "text/markdown" })).status).toBe(200)

    const read = await run("read-1", "file.read", { path }, { kind: "owner" })
    expect(read).toMatchObject({ kind: "ok", result: { path, type: "text/markdown", text: "# Vendor comparison\n" } })

    const missing = await run("read-2", "file.read", { path: "/projects/m4/nowhere.md" }, { kind: "owner" })
    expect(missing).toMatchObject({ kind: "rejected", code: "bad_args" })
  })

  it("keeps the version it replaced and hands it back by hash", async () => {
    const path = `/projects/m4/revision-${crypto.randomUUID()}.md`
    expect((await put(path, "first pass", { "content-type": "text/markdown" })).status).toBe(200)
    expect((await put(path, "second pass", { "content-type": "text/markdown" })).status).toBe(200)

    const current = await run("rev-1", "file.read", { path }, { kind: "owner" })
    expect(current).toMatchObject({ kind: "ok", result: { text: "second pass", versions: 2 } })

    const listed = await run("rev-2", "file.revisions", { path }, { kind: "owner" })
    const rows = field(listed, "result")
    const revisions = rows === undefined ? undefined : field(rows, "revisions")
    const first = Array.isArray(revisions) ? revisions[0] : undefined
    const sha = typeof first === "object" && first !== null ? field(first, "sha256") : undefined
    if (typeof sha !== "string") throw new Error("no revision recorded")

    const older = await run("rev-3", "file.revision", { path, sha256: sha }, { kind: "owner" })
    expect(older).toMatchObject({ kind: "ok", result: { text: "first pass", sha256: sha } })
  })

  it("sweeps unreferenced blobs and staging objects past the grace window and keeps referenced ones", async () => {
    const kept = "/projects/m4/kept.txt"
    expect((await put(kept, "kept bytes")).status).toBe(200)
    const keptRow = await rowOf(kept)
    if (keptRow === undefined) throw new Error("upload did not commit a files row")
    const orphan = blobKey("0".repeat(64))
    await env.FILES.put(orphan, "orphan bytes")
    const staged = `tmp/${crypto.randomUUID()}`
    await env.FILES.put(staged, "staging bytes")

    const fresh = await runInDurableObject(owner(), (home: Home, state) =>
      sweep({ state, env, db: home.db }, Date.now()),
    )
    expect(fresh).toBe(0)
    expect(await env.FILES.head(orphan)).not.toBeNull()
    expect(await env.FILES.head(staged)).not.toBeNull()

    const later = Date.now() + 2 * 24 * 60 * 60_000
    const deleted = await runInDurableObject(owner(), (home: Home, state) => sweep({ state, env, db: home.db }, later))
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(await env.FILES.head(orphan)).toBeNull()
    expect(await env.FILES.head(staged)).toBeNull()
    expect(await env.FILES.head(keptRow.r2_key)).not.toBeNull()
  })
})
