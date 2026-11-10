import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { fakeRemote, FIXTURE_BASE, FIXTURE_HEAD, FIXTURE_URL, NOTES_LINES } from "../../test/plugins/gitnative.ts"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { addThreads, cmd, fresh, recordOffers, setRow, type Stub } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { cloneInto, diff, open, type Port, repoId, show } from "./git.ts"

const context = BACKGROUND_CONTEXT

async function makeProject(stub: Stub, slug: string): Promise<{ id: string; coordinatorId: number }> {
  const created = await cmd(stub, `gn-project-${slug}`, "project.create", { slug, name: slug })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as { id: string; coordinatorId: number }
}

async function turnAt(stub: Stub, conversationId: ConversationId, text: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId, context)
    if (conversation === undefined) throw new Error("conversation disappeared")
    await conversation.configure({ model: M8_MODEL }, context)
    await conversation.submit({ type: "input", content: text, requestId: `gn-${crypto.randomUUID()}` }, context)
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

const portOf = (home: Home, fake: ReturnType<typeof fakeRemote>): Port => ({
  db: home.db,
  bucket: env.FILES,
  fetcher: fake.fetch,
  now: () => Date.now(),
})

describe("native git tools", () => {
  it("ships the native git row disabled", async () => {
    const stub = fresh()
    const listed = await cmd(stub, "gn-row-default", "plugin.list")
    const row = Array.isArray(listed.result)
      ? listed.result.find((entry) => Reflect.get(entry, "id") === "tool-git-native")
      : undefined
    expect(row).toMatchObject({ disabled: true, state: { kind: "disabled" } })
  })

  it("clones a repository on another host and reads its history, a file and a diff", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const fake = fakeRemote()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetch
    try {
      const project = await makeProject(stub, "gn-thread")
      const [thread] = await addThreads(stub, project.id, ["gn thread"])
      if (thread === undefined) throw new Error("no thread")
      respond([
        () => fauxAssistantMessage([fauxToolCall("git_native_clone", { url: FIXTURE_URL })], { stopReason: "toolUse" }),
        () =>
          fauxAssistantMessage([fauxToolCall("git_native_log", { url: FIXTURE_URL, limit: 10 })], {
            stopReason: "toolUse",
          }),
        () =>
          fauxAssistantMessage([fauxToolCall("git_native_show", { url: FIXTURE_URL, path: "notes.txt" })], {
            stopReason: "toolUse",
          }),
        () =>
          fauxAssistantMessage(
            [fauxToolCall("git_native_diff", { url: FIXTURE_URL, base: FIXTURE_BASE, head: FIXTURE_HEAD })],
            { stopReason: "toolUse" },
          ),
        () => fauxAssistantMessage("done"),
      ])
      await turnAt(stub, thread.id, "read the other host's repository")

      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.join("\n")).toContain("cloned git.example.test/team/project at main")
      expect(texts.some((text) => text.includes("Fix the answer"))).toBe(true)
      expect(texts.some((text) => text.includes("line one hundred and fifty"))).toBe(true)
      expect(
        texts.some((text) => text.includes("-export const answer = 41") && text.includes("+export const answer = 42")),
      ).toBe(true)
      expect(fake.calls.length).toBe(3)
      expect(fake.calls.every((call) => call.url.startsWith(FIXTURE_URL))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it("re-reads a cloned repository without another request", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const fake = fakeRemote()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetch
    try {
      const project = await makeProject(stub, "gn-cheap")
      const [thread] = await addThreads(stub, project.id, ["gn cheap thread"])
      if (thread === undefined) throw new Error("no thread")
      respond([
        () => fauxAssistantMessage([fauxToolCall("git_native_clone", { url: FIXTURE_URL })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage("cloned"),
      ])
      await turnAt(stub, thread.id, "clone")
      const afterClone = fake.calls.length

      respond([
        () => fauxAssistantMessage([fauxToolCall("git_native_log", { url: FIXTURE_URL })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage([fauxToolCall("git_native_log", { url: FIXTURE_URL })], { stopReason: "toolUse" }),
        () =>
          fauxAssistantMessage([fauxToolCall("git_native_show", { url: FIXTURE_URL, path: "README.md" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("read"),
      ])
      await turnAt(stub, thread.id, "read it twice")
      expect(fake.calls.length).toBe(afterClone)
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.filter((text) => text.includes("Commits on git.example.test/team/project")).length).toBe(2)
      expect(texts.some((text) => text.includes("hello world"))).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)

  it("keeps history only when the full pack passes the ceiling", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const fake = fakeRemote()
    const cloned = await runInDurableObject(stub, (home: Home) =>
      cloneInto(portOf(home, fake), { project: "gn-ceiling", url: FIXTURE_URL, maxBytes: 1_200 }),
    )
    expect(cloned.row.partial).toBe(1)
    expect(fake.calls.some((call) => call.body.includes("filter blob:none"))).toBe(true)

    const id = await repoId("gn-ceiling", FIXTURE_URL)
    const result = await runInDurableObject(stub, async (home: Home) => {
      const port = portOf(home, fake)
      const reader = await open(port, id)
      if (reader === undefined) throw new Error("the clone was not stored")
      const files = await diff(reader, { base: FIXTURE_BASE, head: FIXTURE_HEAD })
      const shown = await show(port, reader, { path: "notes.txt" })
      return { files, shown }
    })
    expect(result.files.map((entry) => entry.path)).toEqual(["README.md", "notes.txt", "src/app.ts"])
    expect(result.files.every((entry) => entry.patch === null)).toBe(true)
    expect(result.shown.text.split("\n")).toHaveLength(NOTES_LINES + 1)
    expect(fake.calls.some((call) => call.body.includes(`want ${result.shown.sha}`))).toBe(true)
  }, 30_000)

  it("refuses a remote that is not public http", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const fake = fakeRemote()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetch
    try {
      const project = await makeProject(stub, "gn-url")
      const [thread] = await addThreads(stub, project.id, ["gn url thread"])
      if (thread === undefined) throw new Error("no thread")
      respond([
        () =>
          fauxAssistantMessage([fauxToolCall("git_native_clone", { url: "ssh://git@example.test/team/project" })], {
            stopReason: "toolUse",
          }),
        () => fauxAssistantMessage("done"),
      ])
      await turnAt(stub, thread.id, "clone over ssh")
      const texts = await runInDurableObject(stub, (home: Home) => toolTexts(home, thread.id))
      expect(texts.some((text) => text.includes("git_native_clone failed") && text.includes("http or https"))).toBe(
        true,
      )
      expect(fake.calls).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  }, 20_000)

  it("needs a url or a project repository", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const project = await makeProject(stub, "gn-nourl")
    respond([
      () => fauxAssistantMessage([fauxToolCall("git_native_clone", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ])
    await turnAt(stub, project.coordinatorId as ConversationId, "clone nothing")
    const texts = await runInDurableObject(stub, (home: Home) =>
      toolTexts(home, project.coordinatorId as ConversationId),
    )
    expect(
      texts.some(
        (text) => text.includes("git_native_clone failed") && text.includes("needs a project repository or a url"),
      ),
    ).toBe(true)
  }, 20_000)

  it("hides the native git tools when the row is disabled", async () => {
    const stub = fresh()
    await setRow(stub, "tool-git-native", true)
    const project = await makeProject(stub, "gn-offers")
    const [thread] = await addThreads(stub, project.id, ["gn offers thread"])
    if (thread === undefined) throw new Error("no thread")
    const offers = recordOffers()
    respond([offers.step("ok")])
    await turnAt(stub, thread.id, "first")
    expect(offers.at(0).tools).toContain("git_native_clone")

    await setRow(stub, "tool-git-native", false)
    respond([offers.step("ok")])
    await turnAt(stub, thread.id, "second")
    expect(offers.at(1).tools).not.toContain("git_native_clone")
  }, 20_000)
})
