import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { answer, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh, rowState, toolTexts, turn } from "../../test/support.ts"

const CHART = `local data = { 3, 1, 4, 1, 5 }
return function()
  return ui.column { ui.text { "Values", size = "lg" }, ui.chart { type = "bar", height = 200, series = { { name = "v", values = data } } } }
end`

const show = (script: string) =>
  fauxAssistantMessage([fauxToolCall("show_visual", { title: "Values", script })], { stopReason: "toolUse" })

describe("visual", () => {
  it("ships off, and once on checks a script before the reader sees it", async () => {
    const stub = fresh()
    expect(await rowState(stub, "visual")).not.toEqual({ kind: "active" })
    const on = await cmd(stub, "visual-on", "plugin.enable", { id: "visual", enabled: true })
    expect(on.result).toMatchObject({ application: "applied" })
    expect(await rowState(stub, "visual")).toEqual({ kind: "active" })
    respond([show(CHART), show(`return ui.text { "x", color = "red" }`), answer("done")])
    await turn(stub, `visual-${crypto.randomUUID()}`)
    const [shown, failed] = await toolTexts(stub)
    expect(shown).toMatch(/^Shown\. \d+ nodes; 0 interactions checked\./u)
    expect(failed).toContain("visual script failed: ui.text unknown color 'red'")
  })
})
