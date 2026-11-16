import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, type Stub, toolTexts, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { R2Env } from "../../src/r2env.ts"
import { globMatcher } from "./discovery.ts"

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

const put = async (stub: Stub, path: string, text: string): Promise<void> => {
  const ack = await cmd(stub, `put-${crypto.randomUUID()}`, "file.put", { path, text })
  expect(ack.ok, JSON.stringify(ack)).toBe(true)
}

const TREE: Readonly<Record<string, string>> = {
  "/notes/a.md": "# Alpha\nTODO: write the intro\n",
  "/notes/b.ts": "export const answer = 42\n",
  "/notes/deep/c.ts": "// todo later\nexport const other = 1\n",
  "/notes/deep/deeper/d.txt": "nothing here\n",
}

async function seeded(): Promise<Stub> {
  const stub = fresh()
  for (const [path, text] of Object.entries(TREE)) await put(stub, path, text)
  return stub
}

describe("glob matching", () => {
  it("keeps * in one segment, lets ** span segments, and matches names when there is no slash", () => {
    expect(globMatcher("*.ts")("deep/c.ts")).toBe(true)
    expect(globMatcher("deep/*.ts")("deep/c.ts")).toBe(true)
    expect(globMatcher("deep/*.ts")("deep/deeper/x.ts")).toBe(false)
    expect(globMatcher("**/*.txt")("deep/deeper/d.txt")).toBe(true)
    expect(globMatcher("**/*.txt")("d.txt")).toBe(true)
    expect(globMatcher("?.md")("a.md")).toBe(true)
    expect(globMatcher("a.md")("xa.md")).toBe(false)
  })

  it("expands braces and classes, drops a leading ./ and refuses what it cannot match", () => {
    expect(globMatcher("*.{ts,md}")("deep/c.ts")).toBe(true)
    expect(globMatcher("**/*.{ts,tsx}")("deep/x.tsx")).toBe(true)
    expect(globMatcher("*.{ts,md}")("a.txt")).toBe(false)
    expect(globMatcher("*.[tm]d")("a.md")).toBe(true)
    expect(globMatcher("[!a]*.md")("a.md")).toBe(false)
    expect(globMatcher("[!a]*.md")("b.md")).toBe(true)
    expect(globMatcher("./deep/*.ts")("deep/c.ts")).toBe(true)
    expect(() => globMatcher("/notes/*.ts")).toThrow("relative to path")
    expect(() => globMatcher("*.{ts")).toThrow("unclosed {")
    expect(() => globMatcher("*.[ts")).toThrow("unclosed [")
  })
})

/** The text of every tool result in one conversation, after it answers `content`. */
const runIn = (stub: Stub, id: ConversationId, content: string): Promise<string[]> =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(id, BACKGROUND_CONTEXT)
    if (conversation === undefined) throw new Error("conversation disappeared")
    await conversation.submit({ type: "input", content, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    const page = await conversation.entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT)
    return page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult"
          ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
          : [],
      ),
    )
  })

const insertRows = (stub: Stub, paths: readonly string[], size = 1): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    for (const path of paths)
      await home.db.run(
        "INSERT INTO files (path, r2_key, size, type, sha256, project, updated_at) VALUES (?, ?, ?, 'text/plain', ?, NULL, ?)",
        path,
        `b/${path}`,
        size,
        "0".repeat(64),
        Date.now(),
      )
  })

describe("file discovery tools", () => {
  it("lists a directory, finds by glob and greps text under it", async () => {
    const stub = await seeded()
    respond([
      call("ls", { path: "/notes" }),
      call("find", { pattern: "**/*.ts", path: "/notes" }),
      call("grep", { pattern: "todo", path: "/notes", ignoreCase: true }),
      call("grep", { pattern: "todo", path: "/notes", glob: "*.ts" }),
      call("find", { pattern: "*.py", path: "/notes" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "discovery", { text: "look around" })
    const [ls, find, grep, globbed, none] = await toolTexts(stub)
    expect(ls).toBe("a.md  30\nb.ts  25\ndeep/")
    expect(find).toBe("b.ts\ndeep/c.ts")
    expect(grep).toBe("a.md:2: TODO: write the intro\ndeep/c.ts:1: // todo later")
    expect(globbed).toBe("deep/c.ts:1: // todo later")
    expect(none).toBe("No files under /notes match *.py.")
  })

  it("refuses a bad pattern and a path that is not a directory", async () => {
    const stub = await seeded()
    respond([
      call("grep", { pattern: "(", path: "/notes" }),
      call("ls", { path: "/notes/a.md" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "discovery-errors", { text: "try" })
    const [pattern, notDir] = await toolTexts(stub)
    expect(pattern).toContain("Invalid pattern")
    expect(notDir).toContain("is not a directory")
  })

  it("keeps a thread inside its project", async () => {
    const stub = fresh()
    const created = await cmd(stub, "disc-project", "project.create", { slug: "mine", name: "Mine" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const project = created.result as { id: string }
    await put(stub, "/projects/mine/own.md", "mine\n")
    await put(stub, "/projects/theirs/secret.md", "theirs\n")
    const [thread] = await addThreads(stub, project.id, ["discovery thread"])
    if (thread === undefined) throw new Error("no thread")
    respond([
      call("grep", { pattern: ".", path: "/projects/theirs" }),
      call("find", { pattern: "*.md", path: "/projects" }),
      call("find", { pattern: "*.md", path: "/projects/mine" }),
      fauxAssistantMessage("done"),
    ])
    const texts = await runInDurableObject(stub, async (home: Home) => {
      const conversation = await home.harness.conversation(thread.id, BACKGROUND_CONTEXT)
      if (conversation === undefined) throw new Error("thread conversation disappeared")
      await conversation.submit({ type: "input", content: "look", requestId: "disc-thread" }, BACKGROUND_CONTEXT)
      await home.harness.waitForIdle(BACKGROUND_CONTEXT)
      const page = await conversation.entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT)
      return page.items.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.role === "toolResult"
            ? [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
            : [],
        ),
      )
    })
    expect(texts[0]).not.toContain("theirs")
    expect(texts[1]).not.toContain("secret.md")
    expect(texts[2]).toBe("own.md")
  }, 20_000)

  it("hides /me from a coordinator's ls, find and grep from /", async () => {
    const stub = fresh()
    await put(stub, "/me/owner-only.txt", "owner secret\n")
    await put(stub, "/projects/a/x.txt", "project secret\n")
    const id = await runInDurableObject(
      stub,
      async (home: Home) =>
        (
          await home.harness.createConversation(
            { ownership: { kind: "ownerless" }, agent: { model: M8_MODEL, cwd: "/projects/a" } },
            BACKGROUND_CONTEXT,
          )
        ).id,
    )
    respond([
      call("ls", { path: "/" }),
      call("find", { pattern: "*", path: "/" }),
      call("grep", { pattern: "secret", path: "/" }),
      call("read", { path: "/me/owner-only.txt" }),
      fauxAssistantMessage("done"),
    ])
    const [ls, find, grep, read] = await runIn(stub, id, "look")
    expect(ls).toBe("projects/")
    expect(find).toBe("projects/a/x.txt")
    expect(grep).toBe("projects/a/x.txt:1: project secret")
    expect(read).toContain("only the coordinator may use /me")
  }, 20_000)

  it("lists past 1,000 rows in one subtree, reading one row per entry", async () => {
    const stub = fresh()
    await insertRows(
      stub,
      Array.from({ length: 1_001 }, (_, index) => `/n/a/${String(index).padStart(4, "0")}.txt`),
    )
    await put(stub, "/n/b/needle.ts", "const needle = 1\n")
    const reads = await runInDurableObject(stub, async (home: Home) => {
      const before = home.meter().sql.reads
      const listed = await new R2Env(env.FILES, home.db).listDir("/n", BACKGROUND_CONTEXT)
      return { names: listed.ok ? listed.value.map((entry) => entry.name) : [], rows: home.meter().sql.reads - before }
    })
    expect(reads.names).toEqual(["a", "b"])
    expect(reads.rows).toBeLessThan(10)
    respond([
      call("ls", { path: "/n" }),
      call("find", { pattern: "needle.ts", path: "/n" }),
      call("grep", { pattern: "needle", path: "/n", glob: "**/*.ts" }),
      call("find", { pattern: "*", path: "/n", limit: 1_000 }),
      call("ls", { path: "/n/a" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "discovery-many", { text: "look" })
    const [ls, find, grep, all, many] = await toolTexts(stub)
    expect(ls).toBe("a/\nb/")
    expect(find).toBe("b/needle.ts")
    expect(grep).toBe("b/needle.ts:1: const needle = 1")
    expect(all).toContain("[2 more: raise limit or narrow the pattern.]")
    expect(many).toContain("[Stopped at 200 entries: raise limit or use find.]")
  }, 30_000)

  it("answers a catastrophic regex in linear time and refuses lookaround", async () => {
    const stub = fresh()
    await put(stub, "/redos/a.txt", `${"a".repeat(30)}!\n`)
    respond([
      call("grep", { pattern: "(a+)+$", path: "/redos" }),
      call("grep", { pattern: "(a|a)*b", path: "/redos" }),
      call("grep", { pattern: "(?=a)", path: "/redos" }),
      fauxAssistantMessage("done"),
    ])
    const started = Date.now()
    await turn(stub, "discovery-redos", { text: "look" })
    expect(Date.now() - started).toBeLessThan(2_000)
    const [nested, alternation, lookaround] = await toolTexts(stub)
    expect(nested).toBe("No matches in 1 files under /redos.")
    expect(alternation).toBe("No matches in 1 files under /redos.")
    expect(lookaround).toContain("Invalid pattern")
  }, 20_000)

  it("notes files too large to search and matches no line after the last newline", async () => {
    const stub = fresh()
    await insertRows(stub, ["/big/huge.txt"], 600 * 1024)
    await put(stub, "/big/small.txt", "one\ntwo\n")
    respond([
      call("grep", { pattern: "needle", path: "/big" }),
      call("grep", { pattern: "^$", path: "/big", glob: "small.txt" }),
      call("find", { pattern: "*.{txt", path: "/big" }),
      fauxAssistantMessage("done"),
    ])
    await turn(stub, "discovery-big", { text: "look" })
    const [big, empty, glob] = await toolTexts(stub)
    expect(big).toBe("No matches in 1 files under /big.\n[1 files over 512 KiB skipped.]")
    expect(empty).toBe("No matches in 1 files under /big.")
    expect(glob).toContain("Invalid glob: unclosed {")
  }, 20_000)
})
