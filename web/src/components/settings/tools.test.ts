import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot, createSignal } from "solid-js"
import { stubGlobals } from "../../../test/globals.ts"
import { insert, root, textOf, type TestNode } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Mode = "allow" | "ask" | "off"
type Frame = {
  readonly id: string
  readonly op: string
  readonly args: { readonly projectId?: string; readonly tool?: string; readonly mode?: Mode | "inherit" }
}

const TOOLS = [
  { name: "web_fetch", plugin: "tool-web", title: "Web fetch" },
  { name: "bash", plugin: "tool-shell", title: "Bash" },
  { name: "read_file", plugin: "tool-files", title: "Read file" },
] as const

const realFetch = globalThis.fetch
stubGlobals({ window: { location: { hash: "" }, addEventListener: () => undefined } })
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
void mock.module("../ui/icon.tsx", () => ({ Icon: () => undefined, isIconName: () => false }))
let ToolModes: (typeof import("./tools.tsx"))["ToolModes"]
beforeAll(async () => {
  ;({ ToolModes } = await import("./tools.tsx"))
})

let home: Record<string, Mode> = {}
let projects: Record<string, Record<string, Mode>> = {}
let sets: Frame["args"][] = []

const reply = (frame: Frame): unknown => {
  if (frame.op === "tool.policy.read") {
    const projectId = frame.args.projectId
    return {
      tools: TOOLS.map((tool) => {
        const project = projectId === undefined ? undefined : projects[projectId]?.[tool.name]
        return { ...tool, home: home[tool.name] ?? "allow", ...(project === undefined ? {} : { project }) }
      }).toSorted((left, right) => left.name.localeCompare(right.name)),
    }
  }
  if (frame.op === "tool.policy.set") {
    sets.push(frame.args)
    const { tool = "", mode, projectId } = frame.args
    if (projectId === undefined) {
      if (mode !== undefined && mode !== "inherit") home[tool] = mode
    } else {
      const rest = Object.fromEntries(Object.entries(projects[projectId] ?? {}).filter(([name]) => name !== tool))
      projects[projectId] = mode === undefined || mode === "inherit" ? rest : { ...rest, [tool]: mode }
    }
    return frame.args
  }
  return {}
}

beforeEach(() => {
  invalidateReads()
  home = { bash: "ask" }
  projects = { p1: { read_file: "off" } }
  sets = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: reply(frame) }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const find = (node: TestNode, match: (node: TestNode) => boolean): TestNode | undefined =>
  match(node) ? node : node.children.map((child) => find(child, match)).find((found) => found !== undefined)

const findAll = (node: TestNode, match: (node: TestNode) => boolean): TestNode[] => [
  ...(match(node) ? [node] : []),
  ...node.children.flatMap((child) => findAll(child, match)),
]

const control = (tree: TestNode, tool: string): TestNode => {
  const found = find(tree, (node) => node.tag === "ui-segmented-control" && node.props["attr:data-tool"] === tool)
  if (found === undefined) throw new Error(`no control for ${tool}`)
  return found
}

const row = (tree: TestNode, title: string): string => {
  const found = find(tree, (node) => node.props["data-settings-row"] === title)
  if (found === undefined) throw new Error(`no row ${title}`)
  return textOf(found)
}

const choices = (tree: TestNode, tool: string): string[] =>
  findAll(control(tree, tool), (node) => node.tag === "ui-segmented-control-item").map(textOf)

const fire = (node: TestNode, value: string): void => {
  const handler = node.props["on:valuechange"]
  if (typeof handler !== "function") throw new Error(`${node.tag} has no valuechange handler`)
  handler({ detail: { value } })
}

const [projectId, setProjectId] = createSignal<string | undefined>(undefined)

const mount = (): TestNode => {
  setProjectId(undefined)
  const tree = root()
  createRoot(() => insert(tree, createComponent(ToolModes, { get projectId() { return projectId() } })))
  return tree
}

const toProject = async (): Promise<void> => {
  setProjectId("p1")
  await Bun.sleep(20)
}

test("at Home every tool offers Allow, Ask and Off, set to Home's mode and grouped by plugin", async () => {
  const tree = mount()
  await Bun.sleep(20)
  const groups = findAll(tree, (node) => node.tag === "section").map((node) => node.props["aria-label"])
  expect(groups).toEqual(["tool-files", "tool-shell", "tool-web"])
  for (const tool of TOOLS) expect(choices(tree, tool.name)).toEqual(["Allow", "Ask", "Off"])
  expect(control(tree, "bash").props["prop:value"]).toBe("ask")
  expect(control(tree, "web_fetch").props["prop:value"]).toBe("allow")
  expect(row(tree, "Bash")).toContain("bash")
  expect(row(tree, "Bash")).not.toContain("Inherit")
})

test("a Home choice sends tool.policy.set without a project and shows the new mode", async () => {
  const tree = mount()
  await Bun.sleep(20)
  fire(control(tree, "web_fetch"), "off")
  expect(control(tree, "web_fetch").props["prop:value"]).toBe("off")
  await Bun.sleep(20)
  expect(sets).toEqual([{ tool: "web_fetch", mode: "off" }])
  expect(control(tree, "web_fetch").props["prop:value"]).toBe("off")
  expect(textOf(tree)).not.toContain("Saving")
})

test("in a project each tool adds Inherit, and an inheriting row shows Home's mode as the effective one", async () => {
  const tree = mount()
  await Bun.sleep(20)
  await toProject()
  for (const tool of TOOLS) expect(choices(tree, tool.name)).toEqual(["Allow", "Ask", "Off", "Inherit"])

  expect(control(tree, "bash").props["prop:value"]).toBe("inherit")
  expect(row(tree, "Bash")).toContain("Inherits Ask from Home")
  const inherited = findAll(control(tree, "bash"), (node) => node.props["attr:data-inherited"] === "").map(textOf)
  expect(inherited).toEqual(["Ask"])

  expect(control(tree, "read_file").props["prop:value"]).toBe("off")
  expect(row(tree, "Read file")).toContain("Home is Allow")
  expect(findAll(control(tree, "read_file"), (node) => node.props["attr:data-inherited"] === "")).toEqual([])
})

test("in a project a choice overrides Home, and Inherit clears the override", async () => {
  const tree = mount()
  await Bun.sleep(20)
  await toProject()

  fire(control(tree, "bash"), "allow")
  await Bun.sleep(20)
  expect(control(tree, "bash").props["prop:value"]).toBe("allow")
  expect(row(tree, "Bash")).toContain("Home is Ask")

  fire(control(tree, "read_file"), "inherit")
  await Bun.sleep(20)
  expect(sets).toEqual([
    { tool: "bash", mode: "allow", projectId: "p1" },
    { tool: "read_file", mode: "inherit", projectId: "p1" },
  ])
  expect(control(tree, "read_file").props["prop:value"]).toBe("inherit")
  expect(row(tree, "Read file")).toContain("Inherits Allow from Home")
  expect(home).toEqual({ bash: "ask" })
})

test("a refused write shows the reason and puts the row back", async () => {
  const tree = mount()
  await Bun.sleep(20)
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const frame = JSON.parse(String(init.body)) as Frame
    return Response.json({ t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: "no tool bash" } })
  }) as typeof fetch
  fire(control(tree, "bash"), "off")
  await Bun.sleep(20)
  expect(textOf(tree)).toContain("Bash: no tool bash")
  expect(control(tree, "bash").props["prop:value"]).toBe("ask")
})
