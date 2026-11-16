import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot, createSignal } from "solid-js"
import { insert, root, textOf, type TestNode } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: { readonly name?: string } }

const PIN = `sha512-ABCDEFGH${"x".repeat(72)}stuvwx==`

const realFetch = globalThis.fetch
if (Reflect.get(globalThis, "window") === undefined)
  Object.defineProperty(globalThis, "window", {
    value: { location: { hash: "" }, addEventListener: () => undefined },
    configurable: true,
  })
void mock.module("../extensions/install-sheet.tsx", () => ({ InstallSheet: (props: { name: string }) => `Install sheet for ${props.name}` }))
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
const { PluginDetail } = await import("./plugin-detail.tsx")

beforeEach(() => {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const result = (frame: Frame) =>
      frame.op === "market.entry"
        ? {
            name: frame.args.name,
            kind: frame.args.name?.endsWith("-code") === true ? "code" : "bundle",
            status: "not-installed",
            versions: [],
            rows: [],
            readme: `Readme of ${frame.args.name}`,
            integrity: PIN,
          }
        : { entries: [] }
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: result(frame) }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test("moving from one plugin's page to another shows the second plugin's entry", async () => {
  const [name, setName] = createSignal("ingle-plugin-alpha")
  const tree = root()
  createRoot(() => insert(tree, createComponent(PluginDetail, { get name() { return name() } })))
  await Bun.sleep(20)
  expect(textOf(tree)).toContain("Readme of ingle-plugin-alpha")

  setName("ingle-plugin-beta")
  await Bun.sleep(20)
  expect(textOf(tree)).toContain("Readme of ingle-plugin-beta")
  expect(textOf(tree)).not.toContain("Readme of ingle-plugin-alpha")
})

const find = (node: TestNode, match: (node: TestNode) => boolean): TestNode | undefined =>
  match(node) ? node : node.children.map((child) => find(child, match)).find((found) => found !== undefined)

test("an install sheet opened on one plugin closes when the owner moves to another", async () => {
  const [name, setName] = createSignal("ingle-plugin-alpha")
  const tree = root()
  createRoot(() => insert(tree, createComponent(PluginDetail, { get name() { return name() } })))
  await Bun.sleep(20)
  const add = find(tree, (node) => typeof node.props["onClick"] === "function" && textOf(node).includes("Add"))
  const click = add?.props["onClick"]
  if (typeof click !== "function") throw new Error("no Add button")
  click()
  expect(textOf(tree)).toContain("Install sheet for ingle-plugin-alpha")

  setName("ingle-plugin-beta")
  await Bun.sleep(20)
  expect(textOf(tree)).not.toContain("Install sheet for")
})

test("a registry code plugin shows its integrity pin and a bundle shows none", async () => {
  const [name, setName] = createSignal("ingle-plugin-code")
  const tree = root()
  createRoot(() => insert(tree, createComponent(PluginDetail, { get name() { return name() } })))
  await Bun.sleep(20)
  expect(textOf(tree)).toContain("Integritysha512ABCDEFGH…stuvwx==")
  expect(find(tree, (node) => node.tag === "code" && node.props["title"] === PIN)).toBeDefined()

  setName("ingle-plugin-bundle")
  await Bun.sleep(20)
  expect(textOf(tree)).toContain("Readme of ingle-plugin-bundle")
  expect(textOf(tree)).not.toContain("Integrity")
  expect(textOf(tree)).not.toContain("sha512")
})
