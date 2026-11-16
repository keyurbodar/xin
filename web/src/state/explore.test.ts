import { afterEach, beforeEach, expect, test } from "bun:test"
import { invalidateReads } from "../lib/api.ts"
import { exploreSkills, exploreThemes, skillEntry } from "./explore.ts"

type Frame = { readonly id: string; readonly op: string; readonly args: unknown }

const SKILL = { name: "release-notes", title: "Release notes", description: "d", author: "Ingle", category: "Writing", version: "1.0.0", markdown: "---\nname: release-notes\n---\nBody" }

let posts: Frame[][] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  posts = []
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    posts.push(frames)
    const result = (frame: Frame) =>
      frame.op === "explore.entry" ? { kind: "skill", entry: SKILL } : { kind: "skill", entries: [] }
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: result(frame) }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const ops = () => posts.flat().map((frame) => frame.op)

test("switching between Explore's tabs reads each list from the home once", async () => {
  for (let round = 0; round < 3; round += 1) await Promise.all([exploreSkills.reload(), exploreThemes.reload()])
  expect(ops().toSorted()).toEqual(["explore.search", "explore.search"])
})

test("reopening a skill's page reads its entry once", async () => {
  const first = await skillEntry("release-notes")
  await skillEntry("release-notes")
  expect(first).toMatchObject({ name: "release-notes", markdown: SKILL.markdown })
  expect(ops()).toEqual(["explore.entry"])
})
