import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createComponent, insert, root, textOf, type TestNode } from "../../../test/universal.ts"

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
  expect(text).toContain("What Notes will be allowed to do")
  expect(text).toContain("Reads the keys and passwords you have saved")
  expect(text).toContain("Asked for because notes declares it")
  expect(text).toContain("Connects to websites and services on the internet")
  expect(text).toContain("“calendar”")
  expect(text).not.toContain("Read your stored credentials")
  expect(find(tree, (node) => node.tag === "code")).toBeUndefined()

  const allow = find(tree, (node) => typeof node.props["onClick"] === "function" && textOf(node).includes("Allow and install"))
  const click = allow?.props["onClick"]
  if (typeof click !== "function") throw new Error("no Allow button")
  click()
  expect(granted).toEqual([["secrets", "network", "calendar"]])
})
