import { afterEach, expect, test } from "bun:test"
import { invalidateReads } from "./api.ts"
import {
  captainModel,
  ensureCaptain,
  firstOpenStep,
  needsOnboarding,
  projectPlan,
  readProgress,
  sendKeyFor,
  showsOnboarding,
  skipTarget,
   type CaptainInput,
  type SendKey,
} from "./onboarding.ts"

type Sent = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> }

const sent: Sent[] = []
const realFetch = globalThis.fetch

/** A home in a new state, which a real tab hears of through a `changed` frame that drops its cached reads. */
function serve(results: Record<string, (args: Record<string, unknown>) => unknown>): void {
  invalidateReads()
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body))
    const frames = (Array.isArray(body) ? body : [body]) as Sent[]
    const acks = frames.map((frame) => {
      sent.push(frame)
      const handler = results[frame.op]
      if (handler === undefined) throw new Error(`unexpected op ${frame.op}`)
      return { t: "ack", id: frame.id, ok: true, result: handler(frame.args) }
    })
    return new Response(JSON.stringify(Array.isArray(body) ? acks : acks[0]))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  sent.length = 0
})

const profile = (name: string, alias: string, archived = false) => ({
  id: `cpt_${alias}`,
  name,
  alias,
  description: "",
  coordinatorId: 7,
  archived,
  crew: { total: 0, working: 0, waiting: 0, failed: 0 },
})

const input: CaptainInput = {
  name: "Bosun",
  goal: "Keep the build green.",
  repository: "",
  model: { provider: "anthropic", modelId: "m1" },
  suggestions: [],
}

test("progress comes from the instance: a keyed provider, the oldest live Captain and a completed crew report", async () => {
  serve({
    "models.list": () => ({ models: [{ provider: "anthropic", modelId: "m1" }], omittedModels: 0 }),
    "captain.list": () => [profile("Old", "old", true), profile("Bosun", "bosun")],
    "captain.get": () => ({
      ...profile("Bosun", "bosun"),
      model: { provider: "anthropic", modelId: "m1" },
      crew: [{ threadId: 3, title: "Fix", status: "completed", run: 1, idleMs: 0 }],
    }),
  })
  const progress = await readProgress()
  expect(progress.provider).toBe("anthropic")
  expect(progress.captain?.id).toBe("cpt_bosun")
  expect(progress.captain?.model).toEqual({ provider: "anthropic", modelId: "m1" })
  expect(progress.reported).toBe(true)
  expect(firstOpenStep(progress)).toBe(3)
})

test("an empty instance opens the key step, and a keyed one without a Captain opens the Captain step", async () => {
  serve({ "models.list": () => ({ models: [] }), "captain.list": () => [] })
  const empty = await readProgress()
  expect(empty).toEqual({ provider: undefined, captain: undefined, reported: false })
  expect(firstOpenStep(empty)).toBe(1)
  expect(firstOpenStep({ ...empty, provider: "openai" })).toBe(2)
})

test("creating a Captain whose alias already lives reuses it instead of failing as taken", async () => {
  serve({ "captain.list": () => [profile("Bosun", "bosun")] })
  const captain = await ensureCaptain(input, "cmd-1")
  expect(captain.id).toBe("cpt_bosun")
  expect(sent.map((entry) => entry.op)).toEqual(["captain.list"])
})

test("the first project is created under a command id derived from its slug, so a retry replays it", async () => {
  serve({
    "captain.list": () => [],
    "workspace.read": () => ({ projects: [], spaces: [] }),
    "project.create": () => ({ id: "prj_onboarding-bosun", slug: "bosun", name: "Bosun" }),
    "captain.create": (args) => ({ ...profile("Bosun", "bosun"), projectId: args["projectId"] }),
  })
  await ensureCaptain(input, "cmd-1")
  await ensureCaptain(input, "cmd-1")
  const projects = sent.filter((entry) => entry.op === "project.create").map((entry) => entry.id)
  const captains = sent.filter((entry) => entry.op === "captain.create")
  expect(projects).toEqual(["onboarding-bosun", "onboarding-bosun"])
  expect(captains.map((entry) => entry.id)).toEqual(["cmd-1", "cmd-1"])
  expect(captains[0]?.args["projectId"]).toBe("prj_onboarding-bosun")
  expect(captains[0]?.args["model"]).toEqual({ provider: "anthropic", modelId: "m1" })
})

test("a live project is reused for the Captain", async () => {
  serve({
    "captain.list": () => [],
    "workspace.read": () => ({ projects: [{ id: "prj_old", slug: "old", archived: true }, { id: "prj_live", slug: "live", archived: false }] }),
    "captain.create": (args) => ({ ...profile("Bosun", "bosun"), projectId: args["projectId"] }),
  })
  await ensureCaptain(input, "cmd-1")
  expect(sent.find((entry) => entry.op === "captain.create")?.args["projectId"]).toBe("prj_live")
  expect(sent.some((entry) => entry.op === "project.create")).toBe(false)
})

test("a retried send of the same draft keeps its command id, and an edited draft gets a new one", () => {
  let minted = 0
  const mint = (text: string) => (): SendKey => ({ text, id: `id-${++minted}`, at: minted })
  const first = sendKeyFor(undefined, "Plan my week", mint("Plan my week"))
  expect(sendKeyFor(first, "Plan my week", mint("Plan my week"))).toBe(first)
  expect(sendKeyFor(first, "Plan my month", mint("Plan my month")).id).toBe("id-2")
})

test("a new Captain gets an explicit model: the picked one, else the first keyed model, never none when a key exists", () => {
  const keyed = [
    { provider: "anthropic", modelId: "m1" },
    { provider: "anthropic", modelId: "m2" },
  ]
  expect(captainModel(keyed, "")).toEqual({ provider: "anthropic", modelId: "m1" })
  expect(captainModel(keyed, "anthropic/m2")).toEqual({ provider: "anthropic", modelId: "m2" })
  expect(captainModel(keyed, "openai/gone")).toEqual({ provider: "anthropic", modelId: "m1" })
  expect(captainModel([], "")).toBeUndefined()
})

test("an archived onboarding project is not revived: the Captain gets a new project under a free slug", async () => {
  serve({
    "captain.list": () => [],
    "workspace.read": () => ({ projects: [{ id: "prj_onboarding-bosun", slug: "bosun", archived: true }] }),
    "project.create": (args) => ({ id: `prj_onboarding-${String(args["slug"])}`, slug: args["slug"], archived: false }),
    "captain.create": (args) => ({ ...profile("Bosun", "bosun"), projectId: args["projectId"] }),
  })
  await ensureCaptain(input, "cmd-1")
  const created = sent.filter((entry) => entry.op === "project.create")
  expect(created.map((entry) => [entry.id, entry.args["slug"]])).toEqual([["onboarding-bosun-2", "bosun-2"]])
  expect(sent.find((entry) => entry.op === "captain.create")?.args["projectId"]).toBe("prj_onboarding-bosun-2")
})

test("a create that replays an archived project moves on to the next free slug", async () => {
  serve({
    "captain.list": () => [],
    "workspace.read": () => ({ projects: [] }),
    "project.create": (args) =>
      args["slug"] === "bosun"
        ? { id: "prj_onboarding-bosun", slug: "bosun", archived: true }
        : { id: `prj_onboarding-${String(args["slug"])}`, slug: args["slug"], archived: false },
    "captain.create": (args) => ({ ...profile("Bosun", "bosun"), projectId: args["projectId"] }),
  })
  await ensureCaptain(input, "cmd-1")
  expect(sent.filter((entry) => entry.op === "project.create").map((entry) => entry.id)).toEqual([
    "onboarding-bosun",
    "onboarding-bosun-2",
  ])
  expect(sent.find((entry) => entry.op === "captain.create")?.args["projectId"]).toBe("prj_onboarding-bosun-2")
})

test("the project plan reuses a live project, else picks the first slug no project holds", () => {
  const archived = { id: "prj_a", slug: "bosun", archived: true }
  expect(projectPlan([archived, { id: "prj_b", slug: "x", archived: false }], "Bosun")).toEqual({ kind: "reuse", id: "prj_b" })
  expect(projectPlan([], "Bosun")).toEqual({ kind: "create", slug: "bosun", commandId: "onboarding-bosun" })
  expect(projectPlan([archived, { id: "prj_c", slug: "bosun-2", archived: true }], "Bosun")).toEqual({
    kind: "create",
    slug: "bosun-3",
    commandId: "onboarding-bosun-3",
  })
})

test("Skip moves past the key step, leaves for the shell from the Captain and thread steps, and hides once a Captain exists", () => {
  expect(skipTarget(1, false)).toEqual({ kind: "next" })
  expect(skipTarget(1, true)).toEqual({ kind: "next" })
  expect(skipTarget(2, false)).toEqual({ kind: "shell" })
  expect(skipTarget(3, false)).toEqual({ kind: "shell" })
  expect(skipTarget(2, true)).toBeUndefined()
  expect(skipTarget(3, true)).toBeUndefined()
})

test("onboarding shows only while the owner flag is unset and no Captain lives", () => {
  expect(showsOnboarding({ onboarded: false, hasCaptain: false })).toBe(true)
  expect(showsOnboarding({ onboarded: true, hasCaptain: false })).toBe(false)
  expect(showsOnboarding({ onboarded: false, hasCaptain: true })).toBe(false)
  expect(showsOnboarding({ onboarded: true, hasCaptain: true })).toBe(false)
})

test("needsOnboarding reads the stored flag and falls back to a live Captain", async () => {
  serve({ "owner.read": () => ({ name: "", instructions: "" }), "captain.list": () => [] })
  expect(await needsOnboarding()).toBe(true)
  serve({ "owner.read": () => ({ name: "", instructions: "", onboardedAt: "2026-11-16T00:00:00.000Z" }), "captain.list": () => [] })
  expect(await needsOnboarding()).toBe(false)
  serve({ "owner.read": () => ({ name: "", instructions: "" }), "captain.list": () => [profile("Bosun", "bosun")] })
  expect(await needsOnboarding()).toBe(false)
  serve({ "owner.read": () => ({ name: "", instructions: "" }), "captain.list": () => [profile("Old", "old", true)] })
  expect(await needsOnboarding()).toBe(true)
})
