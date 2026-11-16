import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { insert, root, textOf } from "../../../test/universal.ts"
import { invalidateReads } from "../../lib/api.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: { readonly name?: string } }

const SKILL = {
  name: "release-notes",
  title: "Release notes",
  description: "Drafts release notes",
  author: "Ingle",
  category: "Writing",
  version: "1.0.0",
  markdown: "---\nname: release-notes\n---\nWrite the notes.",
}

if (Reflect.get(globalThis, "document") === undefined)
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { setAttribute: () => undefined }, addEventListener: () => undefined },
    configurable: true,
  })
void mock.module("../extensions/glyph.tsx", () => ({ Glyph: () => undefined }))
const { SkillDetail } = await import("./skill-detail.tsx")

const realFetch = globalThis.fetch

beforeEach(() => {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    const ack = (frame: Frame) => {
      if (frame.op !== "explore.entry") return { t: "ack", id: frame.id, ok: true, result: [] }
      return frame.args.name === SKILL.name
        ? { t: "ack", id: frame.id, ok: true, result: { kind: "skill", entry: SKILL } }
        : { t: "ack", id: frame.id, ok: false, error: { code: "bad_args", message: `no skill ${frame.args.name} in Explore` } }
    }
    return Response.json(Array.isArray(body) ? frames.map(ack) : ack(frames[0] as Frame))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function shown(name: string): Promise<string> {
  const tree = root()
  createRoot(() => insert(tree, createComponent(SkillDetail, { name })))
  await Bun.sleep(20)
  return textOf(tree)
}

test("a skill Explore does not have shows the error with a retry, inside the page", async () => {
  const text = await shown("nope")
  expect(text).toContain("Couldn't load nope")
  expect(text).toContain("no skill nope in Explore")
  expect(text).toContain("Try again")
})

test("a skill Explore has shows its title and its instructions", async () => {
  const text = await shown("release-notes")
  expect(text).toContain("Release notes")
  expect(text).toContain("Write the notes.")
  expect(text).not.toContain("Couldn't load")
})
