import { expect, test } from "bun:test"
import {
  createComponent,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  type Component,
  type JSX,
} from "solid-js"
import { insert, root, textOf } from "../../test/universal.ts"
import type { Host } from "../plugins/sdk.ts"
import { PluginPage } from "./plugin-page.tsx"

const unused = (): never => {
  throw new Error("the page under test does not call its host")
}
const host: Host = {
  cmd: unused,
  navigate: unused,
  conversation: unused,
  composer: { insert: unused, submit: unused },
  toast: unused,
}

async function shown(page: Component<{ host: Host }>, after: () => unknown = () => undefined): Promise<string> {
  const error = console.error
  console.error = () => undefined
  try {
    const tree = root()
    createRoot(() =>
      insert(tree, createComponent(PluginPage, { plugin: "probe", title: "Probe settings", component: page, host })),
    )
    await after()
    await Bun.sleep(5)
    return textOf(tree)
  } finally {
    console.error = error
  }
}

const FAILED = "Probe settingsprobe failed to render"

test("a plugin Settings page renders under its title", async () => {
  expect(await shown(() => "page body")).toBe("Probe settingspage body")
})

test("a plugin Settings page that throws while rendering shows the fallback and keeps its title", async () => {
  expect(
    await shown(() => {
      throw new Error("render")
    }),
  ).toBe(FAILED)
})

test("a plugin Settings page that throws on a later update shows the fallback", async () => {
  const [broken, setBroken] = createSignal(false)
  const page = (): JSX.Element =>
    createMemo(() => {
      if (broken()) throw new Error("later")
      return "page body"
    }) as unknown as JSX.Element
  expect(await shown(page, () => setBroken(true))).toBe(FAILED)
})

test("a plugin Settings page whose resource rejects shows the fallback", async () => {
  let reject: (error: Error) => void = () => undefined
  const page = () => {
    const [value] = createResource(() => new Promise<string>((_, fail) => (reject = fail)))
    return createMemo(() => value()) as unknown as JSX.Element
  }
  expect(await shown(page, () => reject(new Error("rejected")))).toBe(FAILED)
})
