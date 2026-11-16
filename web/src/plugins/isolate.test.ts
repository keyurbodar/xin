import { expect, test } from "bun:test"
import { createComponent, createMemo, createResource, createRoot, createSignal, type JSX } from "solid-js"
import { contain, loadEach, themeChoice } from "./isolate.ts"
import type { ClientEntry, PluginDef } from "./sdk.ts"

const FAILED = "probe failed"

function mount(component: () => JSX.Element): () => unknown {
  let view: JSX.Element
  createRoot(() => {
    view = contain("probe", () => createComponent(component, {}), () => FAILED)
  })
  return () => {
    let shown: unknown = view
    while (typeof shown === "function") shown = shown()
    return shown
  }
}

const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => {
  const error = console.error
  console.error = () => undefined
  try {
    return await run()
  } finally {
    console.error = error
  }
}

test("a plugin component that throws while rendering shows the fallback in its place", async () => {
  const view = await quietly(() =>
    mount(() => {
      throw new Error("render")
    }),
  )
  expect(await quietly(view)).toBe(FAILED)
})

test("a plugin component that throws on a later update shows the fallback", async () => {
  const [broken, setBroken] = createSignal(false)
  const view = mount(() =>
    createMemo(() => {
      if (broken()) throw new Error("later")
      return "ok"
    }) as unknown as JSX.Element,
  )
  expect(view()).toBe("ok")
  await quietly(() => setBroken(true))
  expect(await quietly(view)).toBe(FAILED)
})

test("a plugin component whose resource rejects shows the fallback", async () => {
  let reject: (error: Error) => void = () => undefined
  const view = mount(() => {
    const [value] = createResource(() => new Promise<string>((_, fail) => (reject = fail)))
    return createMemo(() => value()) as unknown as JSX.Element
  })
  await quietly(async () => {
    reject(new Error("rejected"))
    await Bun.sleep(5)
  })
  expect(await quietly(view)).toBe(FAILED)
})

const plugin = { slots: {} } as unknown as PluginDef
const entry = (name: string, load: ClientEntry["load"]): ClientEntry => ({ name, rows: [name], load })

test("a client module that fails to load is left out and the others still load", async () => {
  const loaded: string[] = []
  await quietly(() =>
    loadEach(
      [
        entry("broken", () => Promise.reject(new Error("import failed"))),
        entry("good", () => Promise.resolve({ default: plugin })),
      ],
      (name) => loaded.push(name),
    ),
  )
  expect(loaded).toEqual(["good"])
})

test("a malformed plugin theme is skipped and a valid one keeps only known string tokens", async () => {
  const bad = await quietly(() => [
    themeChoice("probe", { id: "x", label: "X", scheme: "dark", tokens: null }),
    themeChoice("probe", { id: "x", label: "X", scheme: "sepia", tokens: {} }),
    themeChoice("probe", { id: 1, label: "X", scheme: "dark", tokens: {} }),
    themeChoice("probe", null),
  ])
  expect(bad).toEqual([undefined, undefined, undefined, undefined])
  expect(themeChoice("probe", { id: "x", label: "X", scheme: "light", tokens: { bg: "#fff", nope: "#000", ink: 3 } })).toEqual(
    { id: "x", label: "X", scheme: "light", tokens: { bg: "#fff" } },
  )
})
