import { expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { insert, root, textOf, type TestNode } from "../../../test/universal.ts"

void mock.module("./glyph.tsx", () => ({ Glyph: () => undefined }))
const { ConsentPrompt } = await import("./consent.tsx")

const find = (node: TestNode, match: (node: TestNode) => boolean): TestNode | undefined =>
  match(node) ? node : node.children.map((child) => find(child, match)).find((found) => found !== undefined)

test("the consent prompt lists plain sentences and grants exactly the ids the backend asked for", () => {
  const granted: string[][] = []
  const tree = root()
  createRoot(() =>
    insert(
      tree,
      createComponent(ConsentPrompt, {
        subject: "Notes",
        permissions: [
          { id: "secrets", title: "Read your stored credentials", why: "notes declares it" },
          { id: "network", title: "Connect to the internet", why: "" },
          { id: "calendar", title: "calendar", why: "" },
        ],
        action: "Allow and install",
        busy: false,
        onAllow: (grant) => granted.push([...grant]),
        onCancel: () => undefined,
      }),
    ),
  )
  const text = textOf(tree)
  expect(text).toContain("Notes asks for")
  expect(text).toContain("Reads and changes the keys and passwords you have saved")
  expect(text).toContain("Asked for because notes declares it")
  expect(text).toContain("Says it connects to websites and services on the internet (Ingle can’t stop this)")
  expect(text).toContain("“calendar”")
  expect(text).not.toContain("Read your stored credentials")
  expect(find(tree, (node) => node.tag === "code")).toBeUndefined()

  const allow = find(tree, (node) => typeof node.props["onClick"] === "function" && textOf(node).includes("Allow and install"))
  const click = allow?.props["onClick"]
  if (typeof click !== "function") throw new Error("no Allow button")
  click()
  expect(granted).toEqual([["secrets", "network", "calendar"]])
})

const PIN = `sha512-ABCDEFGH${"x".repeat(72)}stuvwx==`

const consent = (integrity: string | undefined, changed = false): TestNode => {
  const tree = root()
  createRoot(() =>
    insert(
      tree,
      createComponent(ConsentPrompt, {
        subject: "@lahn/ingle-guarded",
        permissions: [{ id: "network", title: "Reach the network", why: "guarded declares it" }],
        integrity,
        changed,
        action: "Allow and install",
        busy: false,
        onAllow: () => undefined,
        onCancel: () => undefined,
      }),
    ),
  )
  return tree
}

test("the consent sheet shows the exact pin being consented to, and no row when there is none", () => {
  const pinned = consent(PIN)
  expect(textOf(pinned)).toContain("Integritysha512ABCDEFGH…stuvwx==")
  expect(find(pinned, (node) => node.tag === "code" && node.props["title"] === PIN)).toBeDefined()

  const unpinned = consent(undefined)
  expect(textOf(unpinned)).toContain("Says it connects to websites")
  expect(textOf(unpinned)).not.toContain("Integrity")
  expect(textOf(unpinned)).not.toContain("sha512")
})

test("a consent asked again because the package changed says so, and a first ask does not", () => {
  expect(textOf(consent(PIN, true))).toContain("This package changed since you last reviewed it.")
  expect(textOf(consent(PIN))).not.toContain("changed since")
})
