import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { requests, script, SKILL_MODEL } from "../../test/plugins/skills.ts"
import { cmd, fresh, type Stub, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const markdown = (description: string, body: string) => `---\nname: research\ndescription: ${description}\n---\n${body}`

const skillEntries = (stub: Stub) => runInDurableObject(stub, async (home: Home) => home.loader.ctx.skills.list())

const insert = (stub: Stub, id: string, md: string) =>
  cmd(stub, `skill-insert-${id}-${crypto.randomUUID()}`, "plugin.insert", {
    id,
    plugin: "skill",
    config: { markdown: md },
  })

function promptAt(index: number): string {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return getCurrentSystemPrompt(request.messages)
}

async function lastToolResult(stub: Stub): Promise<{ isError: boolean; text: string } | undefined> {
  return runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)
    let found: { isError: boolean; text: string } | undefined
    for (const entry of page.items)
      for (const message of entry.model ?? [])
        if (message.role === "toolResult")
          found = {
            isError: message.isError,
            text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          }
    return found
  })
}

describe("skill", () => {
  it("adds a row's skill with the row id as its source", async () => {
    const stub = fresh()
    const inserted = await insert(stub, "research-notes", markdown("Research a topic.", "BODY-CONTRIBUTED"))
    expect(inserted.result).toMatchObject({ application: "applied" })

    expect(await skillEntries(stub)).toContainEqual({
      name: "research",
      description: "Research a topic.",
      body: "BODY-CONTRIBUTED",
      source: { kind: "row", row: "research-notes" },
    })
    expect((await cmd(stub, `skill-list-${crypto.randomUUID()}`, "skill.list")).result).toEqual([
      { name: "research", description: "Research a topic." },
    ])

    script([fauxAssistantMessage("ok")])
    await turn(stub, `skill-turn-${crypto.randomUUID()}`, { text: "hello", model: SKILL_MODEL })
    expect(promptAt(0)).toContain("- research: Research a topic.")
    expect(promptAt(0)).not.toContain("BODY-CONTRIBUTED")
  })

  it("loads a contributed skill with the skill tool", async () => {
    const stub = fresh()
    const body = "1. Read the primary source.\n2. Quote it."
    await insert(stub, "research-notes", markdown("Research a topic.", body))
    script([
      (request) =>
        request.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage([fauxToolCall("skill", { name: "research" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])

    await turn(stub, `skill-turn-${crypto.randomUUID()}`, { text: "please research", model: SKILL_MODEL })

    expect(await lastToolResult(stub)).toEqual({ isError: false, text: body })
  })

  it("removes the skill when the row is removed", async () => {
    const stub = fresh()
    await insert(stub, "research-notes", markdown("Research a topic.", "BODY-CONTRIBUTED"))
    expect((await skillEntries(stub)).map((skill) => skill.name)).toContain("research")

    const removed = await cmd(stub, `skill-remove-${crypto.randomUUID()}`, "plugin.remove", { id: "research-notes" })
    expect(removed.result).toMatchObject({ application: "applied" })

    expect((await skillEntries(stub)).map((skill) => skill.name)).not.toContain("research")
    expect((await cmd(stub, `skill-list-${crypto.randomUUID()}`, "skill.list")).result).toEqual([])
  })

  it("keeps a stored skill over a contributed one and fails the row with the clash", async () => {
    const stub = fresh()
    await cmd(stub, `skill-put-${crypto.randomUUID()}`, "skill.put", {
      name: "research",
      markdown: markdown("The stored description.", "BODY-STORED"),
    })

    const inserted = await insert(stub, "clash-row", markdown("The contributed description.", "BODY-CONTRIBUTED"))
    expect(inserted.result).toMatchObject({
      application: "failed",
      row: { state: { kind: "failed", error: expect.stringContaining("stored") } },
    })

    expect(await skillEntries(stub)).toContainEqual({
      name: "research",
      description: "The stored description.",
      body: "BODY-STORED",
      source: { kind: "stored" },
    })
  })

  it("fails the row when another row already contributes the same skill", async () => {
    const stub = fresh()
    expect(await insert(stub, "first-row", markdown("First.", "BODY-FIRST"))).toMatchObject({
      result: { application: "applied" },
    })

    expect(await insert(stub, "second-row", markdown("Second.", "BODY-SECOND"))).toMatchObject({
      result: {
        application: "failed",
        row: { state: { kind: "failed", error: expect.stringContaining("first-row") } },
      },
    })
    expect(await skillEntries(stub)).toContainEqual({
      name: "research",
      description: "First.",
      body: "BODY-FIRST",
      source: { kind: "row", row: "first-row" },
    })
  })

  it("fails the row on malformed markdown", async () => {
    const stub = fresh()
    const inserted = await insert(stub, "broken-row", "no frontmatter")
    expect(inserted.result).toMatchObject({
      application: "failed",
      row: { state: { kind: "failed", error: expect.stringContaining("frontmatter") } },
    })
  })

  it("rejects markdown longer than 64 KiB at insert", async () => {
    const stub = fresh()
    const reply = await insert(stub, "too-big", "x".repeat(65_537))
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("65536") },
    })
  })
})
