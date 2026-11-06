import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, recordOffers, rowState, turn } from "../../test/support.ts"

const RESEARCH = "---\nname: research\ndescription: Research a topic from primary sources.\n---\nBODY-RESEARCH"
const RESEARCH_LINE = "- research: Research a topic from primary sources."

describe("skills tool row", () => {
  it("offers the skill tool and its section while the service and tool rows are active", async () => {
    const stub = fresh()
    await cmd(stub, "tool-skills-put-1", "skill.put", { name: "research", markdown: RESEARCH })
    const offers = recordOffers()

    respond([offers.step("ok")])
    await turn(stub, "tool-skills-turn-1")

    expect(offers.latest().tools).toContain("skill")
    expect(offers.latest().system).toContain(RESEARCH_LINE)
    expect(offers.latest().system).not.toContain("BODY-RESEARCH")
  })

  it("removes the skills tools when tool-skills is disabled, keeps the service, and restores them", async () => {
    const stub = fresh()
    await cmd(stub, "tool-skills-put-2", "skill.put", { name: "research", markdown: RESEARCH })
    const off = await cmd(stub, "tool-skills-off", "plugin.enable", { id: "tool-skills", enabled: false })
    expect(off.result).toMatchObject({ application: "applied", row: { disabled: true } })

    const offers = recordOffers()
    respond([offers.step("ok")])
    await turn(stub, "tool-skills-turn-2")
    expect(offers.latest().tools).not.toContain("skill")
    expect(offers.latest().tools).toContain("current_time")
    expect(offers.latest().system).not.toContain(RESEARCH_LINE)
    expect(await rowState(stub, "skills")).toEqual({ kind: "active" })
    expect(await rowState(stub, "tool-skills")).toEqual({ kind: "disabled" })
    expect((await cmd(stub, "tool-skills-list", "skill.list")).result).toEqual([
      { name: "research", description: "Research a topic from primary sources." },
    ])

    const on = await cmd(stub, "tool-skills-on", "plugin.enable", { id: "tool-skills", enabled: true })
    expect(on.result).toMatchObject({ application: "applied", row: { disabled: false } })

    respond([offers.step("ok")])
    await turn(stub, "tool-skills-turn-3")
    expect(offers.latest().tools).toContain("skill")
    expect(offers.latest().system).toContain(RESEARCH_LINE)
  })
})
