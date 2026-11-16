import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"

const location = { hash: "" }
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
Object.defineProperty(globalThis, "window", {
  value: {
    location,
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  },
  configurable: true,
  writable: true,
})
const { invalidateReads } = await import("../lib/api.ts")
const { createFirstCaptain, loadProgress, onboardingCaptain, skipStep } = await import("./onboarding.ts")

type Sent = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> }

const sent: Sent[] = []
const realFetch = globalThis.fetch

function serve(results: Record<string, () => unknown>, failing: readonly string[] = []): void {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Sent[]
    const acks = frames.map((frame) => {
      sent.push(frame)
      if (failing.includes(frame.op)) return { t: "ack", id: frame.id, ok: false, error: { code: "unavailable", message: "down" } }
      const handler = results[frame.op]
      if (handler === undefined) throw new Error(`unexpected op ${frame.op}`)
      return { t: "ack", id: frame.id, ok: true, result: handler() }
    })
    return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]))
  }) as typeof fetch
}

beforeEach(async () => {
  serve({ "models.list": () => ({ models: [] }), "captain.list": () => [] })
  await loadProgress()
  sent.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  sent.length = 0
  location.hash = ""
})

afterAll(() => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window")
  else Object.defineProperty(globalThis, "window", previousWindow)
})

const bosun = {
  id: "cpt_bosun",
  name: "Bosun",
  alias: "bosun",
  description: "",
  coordinatorId: 7,
  archived: false,
  crew: { total: 0, working: 0, waiting: 0, failed: 0 },
}

const input = {
  name: "Bosun",
  goal: "Keep the build green.",
  repository: "",
  model: { provider: "anthropic", modelId: "m1" },
  suggestions: [],
}

const flagWrites = () => sent.filter((frame) => frame.op === "owner.set").map((frame) => frame.args)

test("skipping to the shell writes the onboarding flag, and a failed write still leaves for the shell", async () => {
  serve({ "owner.set": () => ({}) })
  await skipStep(2)
  expect(flagWrites()).toEqual([{ onboarded: true }])
  expect(location.hash).toBe("/")

  location.hash = ""
  sent.length = 0
  serve({}, ["owner.set"])
  await skipStep(2)
  expect(flagWrites()).toEqual([{ onboarded: true }])
  expect(location.hash).toBe("/")
})

test("creating the first Captain writes the flag, and a failed write never undoes the create", async () => {
  serve({ "captain.list": () => [bosun], "owner.set": () => ({}) })
  await createFirstCaptain(input, "cmd-1")
  expect(flagWrites()).toEqual([{ onboarded: true }])

  sent.length = 0
  serve({ "captain.list": () => [bosun] }, ["owner.set"])
  const result = await createFirstCaptain(input, "cmd-2")
  expect(result.id).toBe("cpt_bosun")
  expect(onboardingCaptain()?.id).toBe("cpt_bosun")
  expect(flagWrites()).toEqual([{ onboarded: true }])
})
