import { afterEach, expect, test } from "bun:test"
import { captainModel, ensureCaptain, firstOpenStep, readProgress, sendKeyFor, type CaptainInput, type SendKey } from "./onboarding.ts"

type Sent = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> }

const sent: Sent[] = []
const realFetch = globalThis.fetch

function serve(results: Record<string, (args: Record<string, unknown>) => unknown>): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent
    sent.push(body)
    const handler = results[body.op]
    if (handler === undefined) throw new Error(`unexpected op ${body.op}`)
    return new Response(JSON.stringify({ t: "ack", id: body.id, ok: true, result: handler(body.args) }))
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
    "workspace.read": () => ({ projects: [{ id: "prj_old", archived: true }, { id: "prj_live", archived: false }] }),
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
