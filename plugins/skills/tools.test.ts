import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { answer, M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>

type Ack = {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const stateOf = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}-${crypto.randomUUID()}`, "plugin.list")
  const row = Array.isArray(listed.result) ? listed.result.find((value) => field(value, "id") === id) : undefined
  return field(row, "state")
}

const RESEARCH = "---\nname: research\ndescription: Research a topic from primary sources.\n---\nBODY-RESEARCH"
const RESEARCH_LINE = "- research: Research a topic from primary sources."

type Seen = { readonly tools: readonly string[]; readonly system: string }

function observe(): Seen[] {
  const seen: Seen[] = []
  respond([
    (context) => {
      seen.push({
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
        system: getCurrentSystemPrompt(context.messages),
      })
      return answer("ok")
    },
  ])
  return seen
}

async function turn(stub: Stub, id: string): Promise<void> {
  await runInDurableObject(stub, async (home: Home) => {
    await home.chooseModel(M8_MODEL)
    await home.submit("go", id)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
  })
}

describe("skills tool row", () => {
  it("offers the skill tool and its section while the service and tool rows are active", async () => {
    const stub = fresh()
    await cmd(stub, "tool-skills-put-1", "skill.put", { name: "research", markdown: RESEARCH })
    const seen = observe()

    await turn(stub, "tool-skills-turn-1")

    expect(seen[0]?.tools).toContain("skill")
    expect(seen[0]?.system).toContain(RESEARCH_LINE)
    expect(seen[0]?.system).not.toContain("BODY-RESEARCH")
  })

  it("removes the skills tools when tool-skills is disabled, keeps the service, and restores them", async () => {
    const stub = fresh()
    await cmd(stub, "tool-skills-put-2", "skill.put", { name: "research", markdown: RESEARCH })
    const off = await cmd(stub, "tool-skills-off", "plugin.enable", { id: "tool-skills", enabled: false })
    expect(off.result).toMatchObject({ application: "applied", row: { disabled: true } })

    const without = observe()
    await turn(stub, "tool-skills-turn-2")
    expect(without[0]?.tools).not.toContain("skill")
    expect(without[0]?.tools).toContain("current_time")
    expect(without[0]?.system).not.toContain(RESEARCH_LINE)
    expect(await stateOf(stub, "skills")).toEqual({ kind: "active" })
    expect(await stateOf(stub, "tool-skills")).toEqual({ kind: "disabled" })
    expect((await cmd(stub, "tool-skills-list", "skill.list")).result).toEqual([
      { name: "research", description: "Research a topic from primary sources." },
    ])

    const on = await cmd(stub, "tool-skills-on", "plugin.enable", { id: "tool-skills", enabled: true })
    expect(on.result).toMatchObject({ application: "applied", row: { disabled: false } })

    const withTools = observe()
    await turn(stub, "tool-skills-turn-3")
    expect(withTools[0]?.tools).toContain("skill")
    expect(withTools[0]?.system).toContain(RESEARCH_LINE)
  })
})
