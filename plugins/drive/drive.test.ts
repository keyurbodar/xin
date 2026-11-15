import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { CommandId } from "../../src/ids.ts"
import { blobKey } from "../../src/r2env.ts"
import { captainOf } from "../../test/plugins/drivescopes.ts"
import { requests, script, SKILL_MODEL } from "../../test/plugins/skills.ts"
import { addThreads, cmd, field, fresh, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

const ok = async (stub: Stub, id: string, op: string, args: unknown): Promise<unknown> => {
  const ack = await cmd(stub, id, op, args)
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
  return ack.result
}

async function project(stub: Stub, slug: string): Promise<string> {
  const id = field(await ok(stub, `${slug}-project`, "project.create", { slug, name: slug }), "id")
  if (typeof id !== "string") throw new Error("project.create returned no id")
  return id
}

const lastPrompt = (): string => {
  const request = requests.at(-1)
  if (request === undefined) throw new Error("no request recorded")
  return getCurrentSystemPrompt(request.messages)
}

const reads = (stub: Stub): Promise<number> =>
  runInDurableObject(stub, (home: Home) => {
    const meter = home.meter()
    return meter.sql.reads + meter.kv.reads
  })

const get = (path: string, headers?: Record<string, string>) =>
  exports.default.fetch(new Request(`https://ingle.test${path}`, headers === undefined ? {} : { headers }))

const skillMarkdown = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`

describe("drive", () => {
  it("keeps a file's versions through writes, checkout and a move", async () => {
    const stub = fresh()
    const scope = { kind: "project", id: await project(stub, "acme") }

    const first = await ok(stub, "w1", "drive.write", { scope, path: "notes/plan.md", text: "one" })
    expect(first).toMatchObject({ path: "notes/plan.md", type: "text/markdown", size: 3 })
    await ok(stub, "w2", "drive.write", { scope, path: "/notes/plan.md", text: "two" })

    expect(await ok(stub, "l1", "drive.list", { scope })).toMatchObject({
      root: "/projects/acme/",
      files: [{ path: "notes/plan.md", size: 3 }],
    })
    expect(await ok(stub, "l2", "drive.list", { scope, prefix: "elsewhere" })).toMatchObject({ files: [] })

    const history = await ok(stub, "h1", "drive.history", { scope, path: "notes/plan.md" })
    const versions = field(history, "versions")
    expect(versions).toHaveLength(1)
    const old = field(Array.isArray(versions) ? versions[0] : undefined, "sha256")
    expect(field(first, "sha256")).toBe(old)
    expect(await ok(stub, "r1", "drive.read", { scope, path: "notes/plan.md", sha256: old })).toMatchObject({
      text: "one",
    })

    await ok(stub, "c1", "drive.checkout", { scope, path: "notes/plan.md", sha256: old })
    expect(await ok(stub, "r2", "drive.read", { scope, path: "notes/plan.md" })).toMatchObject({ text: "one" })

    await ok(stub, "m1", "drive.move", { scope, from: "notes/plan.md", to: "plan.md", toScope: { kind: "user" } })
    const moved = await ok(stub, "h2", "drive.history", { scope: { kind: "user" }, path: "plan.md" })
    expect(field(field(moved, "current"), "sha256")).toBe(old)
    expect(field(moved, "versions")).toHaveLength(1)
    expect(await ok(stub, "l3", "drive.list", { scope })).toMatchObject({ files: [] })

    expect(await ok(stub, "d1", "drive.delete", { scope: { kind: "user" }, path: "plan.md" })).toEqual({
      deleted: true,
    })
  })

  it("drops revisions left at a move's destination instead of merging them into the moved file's history", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    const first = await ok(stub, "w1", "drive.write", { scope: user, path: "a.md", text: "one" })
    await ok(stub, "w2", "drive.write", { scope: user, path: "a.md", text: "two" })
    const shared = field(first, "sha256")
    if (typeof shared !== "string") throw new Error("no sha")
    await runInDurableObject(stub, async (home: Home) => {
      for (const sha of [shared, "f".repeat(64)])
        await home.db.run(
          "INSERT INTO file_revisions (path, sha256, size, type, at) VALUES (?, ?, 3, 'text/markdown', 1)",
          "/me/b.md",
          sha,
        )
    })

    await ok(stub, "m1", "drive.move", { scope: user, from: "a.md", to: "b.md" })
    const history = await ok(stub, "h1", "drive.history", { scope: user, path: "b.md" })
    expect(field(history, "versions")).toEqual([expect.objectContaining({ sha256: shared })])
    expect(field(field(history, "versions"), "0")).not.toMatchObject({ at: 1 })
  })

  it("rejects paths that leave the scope and scopes that do not exist", async () => {
    const stub = fresh()
    expect(await cmd(stub, "e1", "drive.write", { scope: { kind: "user" }, path: "../x", text: "" })).toMatchObject({
      ok: false,
    })
    expect(await cmd(stub, "e2", "drive.write", { scope: { kind: "user" }, path: "/", text: "" })).toMatchObject({
      ok: false,
    })
    expect(await cmd(stub, "e3", "drive.list", { scope: { kind: "project", id: "missing" } })).toMatchObject({
      ok: false,
    })
    expect(await cmd(stub, "e4", "drive.list", { scope: { kind: "captain", id: "../me" } })).toMatchObject({
      ok: false,
    })
  })

  it("injects AGENTS.md from cache on later turns and reloads it after a write", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    const written = await ok(stub, "a1", "drive.write", { scope: user, path: "AGENTS.md", text: "Answer in haiku." })
    script(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")))

    await turn(stub, "t1", { text: "hello", model: SKILL_MODEL })
    expect(lastPrompt()).toContain(
      '<instructions scope="user" path="/me/AGENTS.md">\nAnswer in haiku.\n</instructions>',
    )
    expect(lastPrompt()).toContain("- user: /me/")

    const sha = field(written, "sha256")
    if (typeof sha !== "string") throw new Error("no sha")
    await env.FILES.delete(blobKey(sha))
    await turn(stub, "t2", { text: "again", model: SKILL_MODEL })
    expect(lastPrompt()).toContain("Answer in haiku.")

    await ok(stub, "a2", "drive.write", { scope: user, path: "AGENTS.md", text: "Answer in prose." })
    await turn(stub, "t3", { text: "once more", model: SKILL_MODEL })
    expect(lastPrompt()).toContain("Answer in prose.")
    expect(lastPrompt()).not.toContain("haiku")
  })

  it("reads no rows for instructions or skills on a turn once they are cached", async () => {
    const stub = fresh()
    await ok(stub, "a1", "drive.write", { scope: { kind: "user" }, path: "AGENTS.md", text: "Be brief." })
    await ok(stub, "s1", "skill.put", { name: "brief", markdown: skillMarkdown("brief", "Say less.") })
    script(Array.from({ length: 6 }, () => fauxAssistantMessage("ok")))
    await turn(stub, "t1", { text: "warm", model: SKILL_MODEL })
    await turn(stub, "t2", { text: "base", model: SKILL_MODEL })
    const before = await reads(stub)
    await turn(stub, "t3", { text: "base", model: SKILL_MODEL })
    const cached = (await reads(stub)) - before

    const bare = fresh()
    await turn(bare, "t1", { text: "warm", model: SKILL_MODEL })
    await turn(bare, "t2", { text: "base", model: SKILL_MODEL })
    const bareBefore = await reads(bare)
    await turn(bare, "t3", { text: "base", model: SKILL_MODEL })
    expect(cached).toBeLessThanOrEqual((await reads(bare)) - bareBefore)
    expect(lastPrompt()).not.toContain("Be brief.")
  })

  it("stores skills in the user Drive and moves legacy kv skills there on boot", async () => {
    const stub = fresh()
    await ok(stub, "s1", "skill.put", { name: "research", markdown: skillMarkdown("research", "Read sources.") })
    expect(
      await ok(stub, "r1", "drive.read", { scope: { kind: "user" }, path: "skills/research/SKILL.md" }),
    ).toMatchObject({ text: skillMarkdown("research", "Read sources.") })

    await runInDurableObject(stub, (home: Home) =>
      home.db.run("INSERT INTO kv (key, value) VALUES (?, ?)", "skill:legacy", skillMarkdown("legacy", "Old.")),
    )
    await evictDurableObject(stub)
    expect(await ok(stub, "l1", "skill.list", {})).toEqual([
      { name: "legacy", description: "The legacy skill." },
      { name: "research", description: "The research skill." },
    ])
    const left = await runInDurableObject(stub, (home: Home) =>
      home.db.get<{ n: number }>("SELECT count(*) AS n FROM kv WHERE key = ?", "skill:legacy"),
    )
    expect(left?.n).toBe(0)
  })

  it("gives a thread its project and Captain scopes and opens only the Captain folder to its file tools", async () => {
    const stub = fresh()
    const projectId = await project(stub, "crew")
    const [thread] = await addThreads(stub, projectId, ["worker"])
    if (thread === undefined) throw new Error("no thread")
    captainOf.set(thread.id, "bosun")
    try {
      expect(await ok(stub, "sc1", "drive.scopes", { conversationId: thread.id })).toEqual([
        { scope: { kind: "user" }, root: "/me/", label: "user" },
        { scope: { kind: "project", id: projectId }, root: "/projects/crew/", label: "project crew" },
        { scope: { kind: "captain", id: "bosun" }, root: "/captains/bosun/", label: "captain bosun" },
      ])
      const put = (id: string, path: string) =>
        runInDurableObject(stub, (home: Home) =>
          home.commands.run(
            { id: id as CommandId, op: "file.put", args: { path, text: "x" } },
            { kind: "agent", conversationId: thread.id },
          ),
        )
      expect(await put("p1", "/captains/bosun/notes.md")).toMatchObject({ kind: "ok" })
      expect(await put("p2", "/captains/other/notes.md")).toMatchObject({ kind: "rejected", code: "forbidden" })
      expect(await put("p3", "/me/notes.md")).toMatchObject({ kind: "rejected", code: "forbidden" })
    } finally {
      captainOf.delete(thread.id)
    }
  })

  it("serves a share link from R2 without auth, follows writes and moves, and stops on unshare or delete", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    await ok(stub, "w1", "drive.write", { scope: user, path: "pages/report.html", text: "<p>v1</p>" })
    const link = await ok(stub, "sh1", "drive.share", { scope: user, path: "pages/report.html" })
    const url = field(link, "url")
    if (typeof url !== "string") throw new Error("no url")
    expect(url).toMatch(/^\/s\/[0-9a-f]{32}\/report\.html$/)
    expect(await ok(stub, "sh2", "drive.share", { scope: user, path: "pages/report.html" })).toEqual(link)

    const first = await get(url)
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("text/html")
    expect(first.headers.get("content-security-policy")).toBe("sandbox")
    expect(await first.text()).toBe("<p>v1</p>")

    await ok(stub, "w2", "drive.write", { scope: user, path: "pages/report.html", text: "<p>v2</p>" })
    expect(await (await get(url)).text()).toBe("<p>v2</p>")

    await ok(stub, "m1", "drive.move", { scope: user, from: "pages/report.html", to: "report.html" })
    expect(await (await get(url)).text()).toBe("<p>v2</p>")
    expect(await ok(stub, "l1", "drive.list", { scope: user })).toMatchObject({
      shares: { "report.html": field(link, "id") },
    })

    expect(await ok(stub, "u1", "drive.unshare", { scope: user, path: "report.html" })).toEqual({ revoked: true })
    expect((await get(url)).status).toBe(404)

    const again = field(await ok(stub, "sh3", "drive.share", { scope: user, path: "report.html" }), "url")
    if (typeof again !== "string") throw new Error("no url")
    expect(again).not.toBe(url)
    await ok(stub, "d1", "drive.delete", { scope: user, path: "report.html" })
    expect((await get(again)).status).toBe(404)
    expect((await get("/s/not-an-id")).status).toBe(401)
  })

  it("answers a share link's conditional and ranged reads with 304, 412, 206 and 416, and honours If-Range", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    await ok(stub, "w1", "drive.write", { scope: user, path: "digits.txt", text: "0123456789" })
    const url = field(await ok(stub, "sh1", "drive.share", { scope: user, path: "digits.txt" }), "url")
    if (typeof url !== "string") throw new Error("no url")

    const whole = await get(url)
    expect(whole.headers.get("accept-ranges")).toBe("bytes")
    const etag = whole.headers.get("etag")
    if (etag === null) throw new Error("no etag")
    await whole.arrayBuffer()

    const cached = await get(url, { "if-none-match": etag })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe("")
    expect((await get(url, { "if-none-match": '"other"' })).status).toBe(200)

    const middle = await get(url, { range: "bytes=2-4" })
    expect(middle.status).toBe(206)
    expect(middle.headers.get("content-range")).toBe("bytes 2-4/10")
    expect(middle.headers.get("content-length")).toBe("3")
    expect(await middle.text()).toBe("234")

    const tail = await get(url, { range: "bytes=-3" })
    expect(tail.status).toBe(206)
    expect(tail.headers.get("content-range")).toBe("bytes 7-9/10")
    expect(await tail.text()).toBe("789")

    const open = await get(url, { range: "bytes=8-" })
    expect(open.headers.get("content-range")).toBe("bytes 8-9/10")
    expect(await open.text()).toBe("89")

    const current = await get(url, { range: "bytes=2-4", "if-range": etag })
    expect(current.status).toBe(206)
    expect(await current.text()).toBe("234")
    const staleTag = await get(url, { range: "bytes=2-4", "if-range": '"old"' })
    expect(staleTag.status).toBe(200)
    expect(staleTag.headers.get("content-range")).toBeNull()
    expect(await staleTag.text()).toBe("0123456789")
    const staleDate = await get(url, { range: "bytes=2-4", "if-range": "Thu, 01 Jan 1970 00:00:00 GMT" })
    expect(staleDate.status).toBe(200)
    expect(await staleDate.text()).toBe("0123456789")

    const mismatch = await get(url, { "if-match": '"old"' })
    expect(mismatch.status).toBe(412)
    await mismatch.arrayBuffer()
    const changed = await get(url, { "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" })
    expect(changed.status).toBe(412)
    await changed.arrayBuffer()
    const held = await get(url, { "if-match": etag })
    expect(held.status).toBe(200)
    expect(await held.text()).toBe("0123456789")

    const beyond = await get(url, { range: "bytes=20-30" })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get("content-range")).toBe("bytes */10")
    await beyond.arrayBuffer()
  })

  it("refuses a weak If-Match tag, answers a HEAD's failed precondition with 412, and sends last-modified", async () => {
    const stub = fresh()
    const user = { kind: "user" }
    await ok(stub, "w1", "drive.write", { scope: user, path: "notes.txt", text: "hello" })
    const url = field(await ok(stub, "sh1", "drive.share", { scope: user, path: "notes.txt" }), "url")
    if (typeof url !== "string") throw new Error("no url")
    const head = (headers: Record<string, string>) =>
      exports.default.fetch(new Request(`https://ingle.test${url}`, { method: "HEAD", headers }))

    const whole = await get(url)
    const etag = whole.headers.get("etag")
    if (etag === null) throw new Error("no etag")
    const modified = whole.headers.get("last-modified")
    expect(modified).not.toBeNull()
    expect(Number.isNaN(Date.parse(modified ?? ""))).toBe(false)
    await whole.arrayBuffer()

    const weak = await get(url, { "if-match": `W/${etag}` })
    expect(weak.status).toBe(412)
    await weak.arrayBuffer()

    expect((await head({ "if-match": '"old"' })).status).toBe(412)
    expect((await head({ "if-unmodified-since": "Thu, 01 Jan 1970 00:00:00 GMT" })).status).toBe(412)
    const held = await head({ "if-match": etag })
    expect(held.status).toBe(200)
    expect(held.headers.get("last-modified")).toBe(modified)
  })
})
