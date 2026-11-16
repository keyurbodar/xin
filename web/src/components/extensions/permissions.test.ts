import { expect, test } from "bun:test"
import { packageLines, permissionSentence } from "./permissions.ts"

const manifest = await Bun.file(new URL("../../../../src/kernel/manifest.ts", import.meta.url)).text()
const block = /export const PERMISSIONS = \{([\s\S]*?)\n\} as const/u.exec(manifest)?.[1] ?? ""
const kinds = [...block.matchAll(/^ {2}(\w+): \{/gmu)].map((match) => match[1] ?? "")

test("the backend's permission list is read from the manifest", () => {
  expect(kinds).toEqual(["secrets", "files", "storage", "routes", "models", "conversations", "plugins", "network", "runtime", "owner"])
})

test("every permission the backend can ask consent for reads as its own plain sentence", () => {
  const sentences = kinds.map(permissionSentence)
  for (const sentence of sentences) {
    expect(sentence).not.toContain("does not describe")
    expect(sentence).toMatch(/^[A-Z][a-z]+[ ,]/u)
  }
  expect(new Set(sentences).size).toBe(kinds.length)
  expect(permissionSentence("files")).toBe("Reads and changes your files, including those in your Drive")
  expect(permissionSentence("owner")).toBe("Acts as you, such as starting threads on your behalf")
})

test("an unknown permission still gets a sentence that names it", () => {
  expect(permissionSentence("calendar")).toBe("Uses a permission this app does not describe yet: “calendar”")
  expect(permissionSentence("constructor")).toContain("“constructor”")
})

test("Explore's package lines describe what a bundle or code plugin brings", () => {
  expect(packageLines({ kind: "bundle", rows: [], requires: [] })).toEqual([
    "Configures plugins already in this build; adds no code",
    "Mounts no plugin rows of its own",
    "Asks before it uses anything that needs your consent",
  ])
  const row = { id: "a", plugin: "p", config: {}, disabled: false }
  expect(packageLines({ kind: "code", rows: [row, { ...row, id: "b" }], requires: ["x@1"] })).toEqual([
    "Runs its own code in your Home, with your authority",
    "Mounts 2 plugin rows, which you can switch off",
    "Also records x@1",
    "Asks before it uses anything that needs your consent",
  ])
})
