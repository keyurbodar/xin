import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, type Stub, toolTexts, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
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
})
