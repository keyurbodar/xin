import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot, createSignal } from "solid-js"
import { insert, root, textOf } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: { readonly name?: string } }

const realFetch = globalThis.fetch
if (!("window" in globalThis))
  Object.defineProperty(globalThis, "window", {
    value: { location: { hash: "" }, addEventListener: () => undefined },
    configurable: true,
  })
void mock.module("../extensions/install-sheet.tsx", () => ({ InstallSheet: () => undefined }))
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
const { PluginDetail } = await import("./plugin-detail.tsx")

beforeEach(() => {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const result = (frame: Frame) =>
      frame.op === "market.entry"
        ? { name: frame.args.name, kind: "bundle", status: "not-installed", versions: [], rows: [], readme: `Readme of ${frame.args.name}` }
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
