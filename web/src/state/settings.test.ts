import { afterEach, beforeEach, expect, test } from "bun:test"
import { cmd, invalidateReads } from "../lib/api.ts"
import { catalog, rows } from "./extensions.ts"
import {
  models,
  notifyPrefs,
  owner,
  pushDevices,
  quietHours,
  sessions,
  systemMetrics,
  systemVersion,
  usage,
} from "./settings.ts"

type Frame = { readonly id: string; readonly op: string }

let posts: Frame[][] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  posts = []
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Frame[]
    posts.push(frames)
    const acks = frames.map((frame) => ({ t: "ack", id: frame.id, ok: true, result: {} }))
    return Response.json(Array.isArray(body) ? acks : acks[0])
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** What each Settings tab loads in its `onMount`, through the same state handles the components call. */
const TABS: Readonly<Record<string, () => readonly Promise<unknown>[]>> = {
  general: () => [models.reload(), owner.reload()],
  members: () => [owner.reload(), sessions.reload()],
  models: () => [models.reload()],
  notifications: () => [notifyPrefs.reload(), quietHours.reload(), pushDevices.reload(), usage.reload()],
  plugins: () => [rows.reload(), catalog.reload()],
  profile: () => [cmd("memory.profile", {}), owner.reload()],
  system: () => [systemVersion.reload(), systemMetrics.reload()],
  usage: () => [usage.reload(), models.reload()],
}

const LIVE = new Set(["session.list", "system.metrics", "usage.summary"])

const sent = (): string[] => posts.flat().map((frame) => frame.op)

test("reopening any Settings tab within the TTL sends only its live reads", async () => {
  const away = (): Promise<unknown> => Promise.all([cmd("automation.list"), cmd("workspace.read"), cmd("captain.list")])
  for (const [tab, load] of Object.entries(TABS)) {
    await Promise.all(load())
    await away()
    posts = []
    await Promise.all(load())
    expect({ tab, ops: sent().filter((op) => !LIVE.has(op)) }).toEqual({ tab, ops: [] })
  }
})

test("walking every Settings tab twice fetches each cached read once", async () => {
  for (let pass = 0; pass < 2; pass += 1) for (const load of Object.values(TABS)) await Promise.all(load())
  const cachedOps = sent().filter((op) => !LIVE.has(op))
  expect(cachedOps.toSorted()).toEqual([...new Set(cachedOps)].toSorted())
})
