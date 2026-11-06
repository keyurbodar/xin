import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { requests, script, SKILL_MODEL } from "../../test/plugins/skills.ts"
import { cmd, fresh, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

const markdown = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

function promptAt(index: number): string {
  const request = requests[index]
  if (request === undefined) throw new Error(`no request ${index} recorded`)
  return getCurrentSystemPrompt(request.messages)
}

async function lastToolResult(stub: DurableObjectStub<Home>): Promise<{ isError: boolean; text: string } | undefined> {
  return runInDurableObject(stub, async (home: Home) => {
    const page = await (await home.root()).entries({ order: "ascending" }, 500, undefined, context)
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

describe("skills", () => {
  it("lists skill names and descriptions in one sorted section without their bodies", async () => {
    const stub = fresh()
    await cmd(stub, "skill-put-1", "skill.put", {
      name: "research",
      markdown: markdown("research", "Research a topic from primary sources.", "BODY-RESEARCH"),
    })
    await cmd(stub, "skill-put-2", "skill.put", {
      name: "alpha",
      markdown: markdown("alpha", "Start every task here.", "BODY-ALPHA"),
    })
    script([fauxAssistantMessage("ok")])

    await turn(stub, "skill-turn-1", { text: "hello", model: SKILL_MODEL })

    const prompt = promptAt(0)
    expect(prompt).toContain("- research: Research a topic from primary sources.")
    expect(prompt).toContain("- alpha: Start every task here.")
    expect(prompt.indexOf("- alpha:")).toBeLessThan(prompt.indexOf("- research:"))
    expect(prompt).not.toContain("BODY-RESEARCH")
    expect(prompt).not.toContain("BODY-ALPHA")
  })

  it("returns a skill's body when the model calls skill(name)", async () => {
    const stub = fresh()
    const body = "1. Read the primary source.\n2. Quote it."
    await cmd(stub, "skill-put-3", "skill.put", {
      name: "research",
      markdown: markdown("research", "Research a topic from primary sources.", body),
    })
    script([
      (request) =>
        request.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage([fauxToolCall("skill", { name: "research" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])

    await turn(stub, "skill-turn-2", { text: "please research this", model: SKILL_MODEL })

    expect(await lastToolResult(stub)).toEqual({ isError: false, text: body })
  })

  it("rejects malformed skills and bad names without storing anything", async () => {
    const stub = fresh()
    expect(
      await cmd(stub, "skill-put-4", "skill.put", { name: "broken", markdown: "---\nname: broken\n---\nbody" }),
    ).toMatchObject({ ok: false, error: { code: "bad_args", message: expect.stringContaining("description") } })
    expect(await cmd(stub, "skill-put-5", "skill.put", { name: "broken", markdown: "no frontmatter" })).toMatchObject({
      ok: false,
      error: { code: "bad_args", message: expect.stringContaining("frontmatter") },
    })
    expect(
      await cmd(stub, "skill-put-6", "skill.put", {
        name: "Bad Name",
        markdown: markdown("Bad Name", "nope", "body"),
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect((await cmd(stub, "skill-list-1", "skill.list")).result).toEqual([])
  })

  it("removes a deleted skill from the next request's section", async () => {
    const stub = fresh()
    await cmd(stub, "skill-put-7", "skill.put", {
      name: "temporary",
      markdown: markdown("temporary", "Only here for one turn.", "BODY-TEMPORARY"),
    })
    script([fauxAssistantMessage("first"), fauxAssistantMessage("second")])

    await turn(stub, "skill-turn-3", { text: "one", model: SKILL_MODEL })
    const before = promptAt(0)
    await cmd(stub, "skill-delete-1", "skill.delete", { name: "temporary" })
    await turn(stub, "skill-turn-4", { text: "two", model: SKILL_MODEL })
    const after = promptAt(1)

    expect(before).toContain("- temporary: Only here for one turn.")
    expect(after).not.toContain("temporary")
  })

  it("names close skills when asked for an unknown one", async () => {
    const stub = fresh()
    await cmd(stub, "skill-put-8", "skill.put", {
      name: "research",
      markdown: markdown("research", "Research a topic from primary sources.", "body"),
    })
    script([
      (request) =>
        request.messages.some((message) => message.role === "toolResult")
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage([fauxToolCall("skill", { name: "reserch" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ])

    await turn(stub, "skill-turn-5", { text: "unknown please", model: SKILL_MODEL })

    const result = await lastToolResult(stub)
    expect(result?.isError).toBe(true)
    expect(result?.text).toContain("research")
  })
})
