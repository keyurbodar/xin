import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { insert, root, type TestNode } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Frame = { readonly id: string }

const realFetch = globalThis.fetch
const realWindow: unknown = Reflect.get(globalThis, "window")
const realDocument: unknown = Reflect.get(globalThis, "document")
const setGlobal = (key: "window" | "document", value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
setGlobal("window", { location: { hash: "" }, addEventListener: () => undefined, removeEventListener: () => undefined })
if (realDocument === undefined)
  setGlobal("document", { documentElement: { setAttribute: () => undefined }, addEventListener: () => undefined })
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
void mock.module("@ark-ui/solid/menu", () => ({ Menu: new Proxy({}, { get: () => () => undefined }) }))
void mock.module("../../appearance/store.ts", () => ({ isCatalogThemeAdded: () => false }))
void mock.module("./theme-detail.tsx", () => ({ AddThemeButton: () => undefined, ThemeDetail: () => undefined }))
const { Explore } = await import("./explore.tsx")

beforeEach(() => {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: { entries: [] } }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(() => {
  setGlobal("window", realWindow)
  setGlobal("document", realDocument)
})

const find = (node: TestNode, match: (node: TestNode) => boolean): TestNode | undefined =>
  match(node) ? node : node.children.map((child) => find(child, match)).find((found) => found !== undefined)

const collect = (node: TestNode, tag: string): TestNode[] => [
  ...(node.tag === tag ? [node] : []),
  ...node.children.flatMap((child) => collect(child, tag)),
]

test("the Explore tabs follow the route, and selecting one navigates to its path", () => {
  window.location.hash = "#/explore"
  const tree = root()
  createRoot(() => insert(tree, createComponent(Explore, { view: { kind: "list", tab: "plugins" } })))

  const tabs = find(tree, (node) => node.tag === "ui-tabs")
  if (tabs === undefined) throw new Error("no ui-tabs")
  expect(tabs.props["prop:value"]).toBe("plugins")
  expect(collect(tree, "ui-tabs-tab").map((tab) => tab.props["value"])).toEqual(["plugins", "skills", "themes"])
  expect(collect(tree, "ui-tabs-panel").map((panel) => panel.props["value"])).toEqual(["plugins"])

  const change = tabs.props["on:valuechange"]
  if (typeof change !== "function") throw new Error("no valuechange handler")
  change({ detail: { value: "skills" } })
  expect(window.location.hash).toBe("/explore/skills")
  change({ detail: { value: "themes" } })
  expect(window.location.hash).toBe("/explore/themes")
})
