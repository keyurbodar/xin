import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, recordOffers, setRow, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT
const HEADERS = { "content-type": "application/json" }

type Call = { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string }

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: HEADERS })

const COMMITS = [
  {
    sha: "abc123def4567890",
    commit: {
      message: "Fix the app\n\nA longer body.",
      author: { name: "Keyur", date: "2026-11-09T00:00:00Z" },
    },
    author: { login: "keyur" },
  },
  {
    sha: "def456abc1237890",
    commit: { message: "Initial commit", author: { name: "Keyur", date: "2026-11-08T00:00:00Z" } },
    author: { login: "keyur" },
  },
]

const DETAIL = {
  sha: "abc123def4567890",
  commit: { message: "Fix the app\n\nA longer body.", author: { name: "Keyur", date: "2026-11-09T00:00:00Z" } },
  files: [
    {
      filename: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
}

const COMPARE = {
  status: "ahead",
  ahead_by: 1,
  behind_by: 0,
  total_commits: 1,
  files: [
    {
      filename: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ],
  commits: [COMMITS[0]],
}

const BLAME = {
  data: {
    repository: {
      object: {
        blame: {
          ranges: [
            {
              startingLine: 1,
              endingLine: 2,
              commit: {
                oid: "abc123def4567890",
                abbreviatedOid: "abc123d",
                message: "Fix the app",
                author: { name: "Keyur", date: "2026-11-09T00:00:00Z" },
              },
            },
          ],
        },
      },
    },
  },
}

function fakeFetch(): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : ""
    calls.push({ method, url, headers: new Headers(init?.headers), body })
    if (url.startsWith("https://api.github.com/repos/acme/demo/commits?")) return json(COMMITS)
    if (url === "https://api.github.com/repos/acme/demo/commits/abc123") return json(DETAIL)
    if (url.startsWith("https://api.github.com/repos/acme/demo/compare/main...feature")) return json(COMPARE)
    if (url === "https://api.github.com/graphql") return json(BLAME)
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

async function makeProject(
  stub: Stub,
  slug: string,
  git?: { repo: string; ref?: string },
): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `git-project-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const project = created.result as { id: string; coordinatorId: number }
  if (git !== undefined) {
    const updated = await cmd(stub, `git-settings-${slug}`, "project.update", {
      id: project.id,
      settings: { git },
    })
    expect(updated.ok, JSON.stringify(updated)).toBe(true)
  }
  return project
}

async function turnAt(stub: Stub, conversationId: ConversationId, text: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId, context)
    if (conversation === undefined) throw new Error("conversation disappeared")
    await conversation.configure({ model: M8_MODEL }, context)
    await conversation.submit({ type: "input", content: text, requestId: `git-${crypto.randomUUID()}` }, context)
    await home.harness.waitForIdle(context)
  })
}

const toolTexts = (home: Home, conversationId: ConversationId): Promise<string[]> =>
  home.harness.conversation(conversationId, context).then(async (conversation) => {
    if (conversation === undefined) return []
    const page = await conversation.entries({ order: "ascending" }, 300, undefined, context)
    return page.items.flatMap((entry) =>
      (entry.model ?? [])
        .filter((message) => message.role === "toolResult")
        .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))),
    )
  })

describe("git tools", () => {
  it("ships the git row disabled", async () => {
    const stub = fresh()
    const listed = await cmd(stub, "git-row-default", "plugin.list")
    const row = Array.isArray(listed.result)
      ? listed.result.find((entry) => Reflect.get(entry, "id") === "tool-git")
      : undefined
    expect(row).toMatchObject({ disabled: true, state: { kind: "disabled" } })
  })

  it("reads log, show, diff and blame from the thread's project repository", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git", true)
    const fake = fakeFetch()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetch
    try {
      const project = await makeProject(stub, "git-thread", { repo: "acme/demo", ref: "main" })
      const [thread] = await addThreads(stub, project.id, ["git thread"])
      if (thread === undefined) throw new Error("no thread")
      expect(await cmd(stub, "git-secret", "secret.set", { ref: "github.token", value: "test-token" })).toMatchObject({
        ok: true,
      })
      respond([
        () => fauxAssistantMessage([fauxToolCall("git_log", {})], { stopReason: "toolUse" }),
        () => fauxAssistantMessage([fauxToolCall("git_show", { ref: "abc123" })], { stopReason: "toolUse" }),
        () =>
          fauxAssistantMessage([fauxToolCall("git_diff", { base: "main", head: "feature" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage([fauxToolCall("git_blame", { path: "src/app.ts" })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage("done"),
      ])
      await turnAt(stub, thread.id, "inspect the repo")

      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.some((text) => text.includes("Commits on acme/demo (main):"))).toBe(true)
      expect(texts.some((text) => text.includes("Fix the app"))).toBe(true)
      expect(texts.some((text) => text.includes("ahead 1"))).toBe(true)
      expect(texts.some((text) => text.includes("1-2 abc123d"))).toBe(true)
      expect(
        fake.calls.find((call) => call.url.startsWith("https://api.github.com/repos/acme/demo/commits?"))?.url,
      ).toContain("sha=main")
      expect(
        fake.calls.find((call) => call.url === "https://api.github.com/graphql")?.headers.get("authorization"),
      ).toBe("Bearer test-token")
      expect(fake.calls.find((call) => call.url === "https://api.github.com/graphql")?.body).toContain("src/app.ts")
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it("refuses a ref that would walk out of the project repository", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git", true)
    const fake = fakeFetch()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetch
    try {
      const project = await makeProject(stub, "git-escape", { repo: "acme/demo", ref: "main" })
      const [thread] = await addThreads(stub, project.id, ["escape thread"])
      if (thread === undefined) throw new Error("no thread")
      respond([
        () =>
          fauxAssistantMessage([fauxToolCall("git_show", { ref: "../../../other/secret/commits" })], {
            stopReason: "toolUse",
          }),
        () =>
          fauxAssistantMessage([fauxToolCall("git_diff", { base: "..", head: "main" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("done"),
      ])
      await turnAt(stub, thread.id, "inspect the repo")

      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.some((text) => text.includes("git_show failed") && text.includes("is invalid"))).toBe(true)
      expect(texts.some((text) => text.includes("git_diff failed") && text.includes("is invalid"))).toBe(true)
      expect(fake.calls.filter((call) => call.url.includes(".."))).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it("refuses a project without a repository", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git", true)
    const project = await makeProject(stub, "git-none")
    respond([
      () => fauxAssistantMessage([fauxToolCall("git_log", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ])
    await turnAt(stub, project.coordinatorId as ConversationId, "inspect")
    const texts = await runInDurableObject(stub, (home: Home) =>
      toolTexts(home, project.coordinatorId as ConversationId),
    )
    expect(texts.some((text) => text.includes("needs a project repository"))).toBe(true)
  }, 20_000)

  it("hides the git tools when the tool-git row is disabled", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git", true)
    const project = await makeProject(stub, "git-row", { repo: "acme/demo" })
    const [thread] = await addThreads(stub, project.id, ["git row thread"])
    if (thread === undefined) throw new Error("no thread")
    const offers = recordOffers()
    respond([offers.step("ok")])
    await turnAt(stub, thread.id, "first")
    expect(offers.at(0).tools).toContain("git_log")

    await setRow(stub, "tool-git", false)
    respond([offers.step("ok")])
    await turnAt(stub, thread.id, "second")
    expect(offers.at(1).tools).not.toContain("git_log")
  }, 20_000)
})
