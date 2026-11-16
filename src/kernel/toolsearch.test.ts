import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { fresh, recordOffers, type Stub, toolTexts, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

const removeFromRoot = (stub: Stub, names: readonly string[]): Promise<void> =>
  runInDurableObject(stub, async (home: Home) => {
    const root = await home.root()
    await root.configure({ modelTools: { remove: home.loader.ctx.pi.toolsNamed(names) } }, BACKGROUND_CONTEXT)
  })

describe("tool_search over the deferred tools", () => {
  it("loads exactly the tool a query names, which the model then calls", async () => {
    const stub = fresh()
    const offers = recordOffers()
    respond([
      offers.wrap(() => call("tool_search", { query: "create_goal" })),
      offers.wrap(() => call("create_goal", { objective: "ship it", max_goal_rounds: 2 })),
      offers.step("done"),
    ])
    await turn(stub, "search-named", { text: "set a goal" })

    expect(offers.at(0).tools).not.toContain("create_goal")
    expect(offers.at(0).available).toContain("create_goal")
    const loaded = offers.at(1).tools.filter((name) => !offers.at(0).tools.includes(name))
    expect(loaded).toEqual(["create_goal"])
    const [search, created] = await toolTexts(stub)
    expect(search).toContain("Loaded 1 tool")
    expect(created).toContain("ship it")
    expect(offers.at(2).system).toBe(offers.at(0).system)
  })

  it("loads at most three tools for a query that names none", async () => {
    const stub = fresh()
    const offers = recordOffers()
    respond([offers.wrap(() => call("tool_search", { query: "goal automation run" })), offers.step("done")])
    await turn(stub, "search-ranked", { text: "find tools" })

    const loaded = offers.at(1).tools.filter((name) => !offers.at(0).tools.includes(name))
    expect(loaded.length).toBeGreaterThan(0)
    expect(loaded.length).toBeLessThanOrEqual(3)
  })

  it("neither lists nor loads a tool the conversation's modelTools removes", async () => {
    const stub = fresh()
    await removeFromRoot(stub, ["set_model"])
    const offers = recordOffers()
    respond([offers.wrap(() => call("tool_search", { query: "set_model" })), offers.step("done")])
    await turn(stub, "search-removed", { text: "switch model" })

    expect(offers.at(0).available).not.toContain("set_model")
    expect(offers.at(1).tools).not.toContain("set_model")
    const [search] = await toolTexts(stub)
    expect(search).not.toContain("set_model")
  })

  it("keeps an explicit limit at three", async () => {
    const stub = fresh()
    const offers = recordOffers()
    respond([offers.wrap(() => call("tool_search", { query: "goal automation run", limit: 8 })), offers.step("done")])
    await turn(stub, "search-limit", { text: "find tools" })

    const loaded = offers.at(1).tools.filter((name) => !offers.at(0).tools.includes(name))
    expect(loaded.length).toBeLessThanOrEqual(3)
  })
})
