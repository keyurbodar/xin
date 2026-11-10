import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import helloModule from "../plugins/hello/index.ts?raw"
import helloTest from "../plugins/hello/hello.test.ts?raw"
import helloManifest from "../plugins/hello/package.json?raw"
import { readManifest } from "../src/kernel/manifest.ts"
import { scaffold, TEMPLATE, type Template } from "../scripts/scaffold.ts"
import { answer, respond } from "./plugins/m8.ts"
import { cmd, field, fresh, rowState, toolTexts, turn } from "./support.ts"

const SOURCE: Template = { manifest: helloManifest, module: helloModule, test: helloTest }

const fileOf = (name: string, path: string): string => {
  const file = scaffold(name, SOURCE).find((candidate) => candidate.path === path)
  if (file === undefined) throw new Error(`the scaffold wrote no ${path}`)
  return file.content
}

describe("plugin authoring", () => {
  it("scaffolds the template package as it stands", () => {
    const files = scaffold(TEMPLATE, SOURCE)
    expect(files.map((file) => file.path)).toEqual(["package.json", "index.ts", "hello.test.ts"])
    expect(files.map((file) => file.content)).toEqual([helloManifest, helloModule, helloTest])
  })

  it("writes a package this build accepts, under the new name", () => {
    const manifest: unknown = JSON.parse(fileOf("greeting", "package.json"))
    const xin = field(manifest, "xin")
    const plugins = field(xin, "plugins")
    const declared = field(plugins, "greeting")

    expect(field(manifest, "name")).toBe("xin-plugin-greeting")
    expect(field(declared, "module")).toBe("./index.ts")
    expect(field(declared, "title")).toBe("Greeting")
    expect(
      readManifest(
        { api: field(declared, "api"), requires: field(declared, "requires") },
        "xin-plugin-greeting: xin.plugins.greeting",
      ),
    ).toEqual({ api: 1, requires: [] })
    expect(field(xin, "bundle")).toEqual([{ id: "greeting", plugin: "greeting" }])

    expect(fileOf("greeting", "index.ts")).toContain('export const name = "greeting"')
    expect(fileOf("greeting", "index.ts")).toContain('name: "greeting"')
    expect(fileOf("greeting", "greeting.test.ts")).toContain('describe("greeting"')
  })

  it("refuses a name that is not kebab-case and says what one looks like", () => {
    expect(() => scaffold("Weather", SOURCE)).toThrow(
      'plugin name "Weather" must be lowercase letters, digits and hyphens, starting with a letter, like "hello-world"',
    )
  })

  it("turns the plugin on, calls its tool and lists its prompt", async () => {
    const stub = fresh()
    const on = await cmd(stub, "authoring-on", "plugin.enable", { id: "hello", enabled: true })
    expect(on.result).toMatchObject({ application: "applied" })
    expect(await rowState(stub, "hello")).toEqual({ kind: "active" })

    respond([
      fauxAssistantMessage([fauxToolCall("hello", { who: "world" })], { stopReason: "toolUse" }),
      answer("done"),
    ])
    await turn(stub, `authoring-${crypto.randomUUID()}`)
    expect(await toolTexts(stub)).toEqual(["Hi, world!"])

    const prompts = await cmd(stub, "authoring-prompts", "prompt.list")
    expect(prompts.result).toContainEqual({
      name: "hello",
      description: "Greet me with the hello tool.",
      text: "Greet me with the hello tool, then tell me which greeting the plugin is configured with.",
      source: { kind: "row", row: "hello" },
    })
  })
})
