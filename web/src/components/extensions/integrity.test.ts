import { expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { insert, root, textOf, type TestNode } from "../../../test/universal.ts"

void mock.module("./glyph.tsx", () => ({ Glyph: () => undefined }))
const { IntegrityPin, shortPin } = await import("./integrity.tsx")

const HASH = `ABCDEFGH${"x".repeat(72)}stuvwx==`
const PIN = `sha512-${HASH}`

const find = (node: TestNode, match: (node: TestNode) => boolean): TestNode | undefined =>
  match(node) ? node : node.children.map((child) => find(child, match)).find((found) => found !== undefined)

test("a pin shows its algorithm and the first and last 8 characters of its hash", () => {
  expect(shortPin(PIN)).toEqual({ algorithm: "sha512", hash: "ABCDEFGH…stuvwx==" })
})

test("the pin keeps the full SRI in its title and copies it whole", async () => {
  const tree = root()
  createRoot(() => insert(tree, createComponent(IntegrityPin, { integrity: PIN })))
  expect(textOf(tree)).toBe("sha512ABCDEFGH…stuvwx==")
  expect(find(tree, (node) => node.tag === "code")?.props["title"]).toBe(PIN)

  const copied: string[] = []
  const navigator: unknown = Reflect.get(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
    configurable: true,
  })
  try {
    const click = find(tree, (node) => node.tag === "button")?.props["onClick"]
    if (typeof click !== "function") throw new Error("no copy button")
    click()
    await Bun.sleep(0)
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true })
  }
  expect(copied).toEqual([PIN])
  expect(find(tree, (node) => node.tag === "button")?.props["aria-label"]).toBe("Copied")
})
