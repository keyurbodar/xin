import { expect, test } from "bun:test"
import { mermaidConfig } from "./mermaid-config.ts"

test("mermaid runs strict, with SVG text labels that a diagram cannot switch back on", () => {
  const config = mermaidConfig({ primaryColor: "#000000" })
  expect(config.securityLevel).toBe("strict")
  expect(config.htmlLabels).toBe(false)
  expect(config.flowchart?.htmlLabels).toBe(false)
  expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "flowchart", "themeCSS"]))
  expect(config.themeVariables).toEqual({ primaryColor: "#000000" })
})
