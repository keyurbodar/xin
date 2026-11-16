import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { THINKING_MODEL, WIDE_MODEL } from "../../test/plugins/m3.ts"
import { cmd, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Captain = { readonly id: string; readonly coordinatorId: number; readonly spaceId: string }
type Choice = {
  readonly model?: { provider: string; modelId: string }
  readonly query?: string
  readonly thinking?: "off" | "low" | "high"
}

async function captain(stub: Stub, slug: string, args: object): Promise<Captain> {
  const project = await cmd(stub, `project-${slug}`, "project.create", { slug, name: slug })
  expect(project.ok, JSON.stringify(project)).toBe(true)
  const projectId = (project.result as { id: string }).id
  const created = await cmd(stub, `captain-${slug}`, "captain.create", { projectId, name: `Captain ${slug}`, ...args })
  expect(created.ok, JSON.stringify(created)).toBe(true)
  return created.result as Captain
}

const delegate = (stub: Stub, coordinatorId: number, key: string, choice?: Choice) =>
  runInDurableObject(stub, (home: Home) =>
    home.loader.ctx.threads.delegate(
      { conversationId: coordinatorId as ConversationId, taskId: `task-${key}` },
      { task: "say hi", title: key, mode: "async", clientRequestId: key, ...(choice === undefined ? {} : { choice }) },
      context,
    ),
  )

const agentOf = (stub: Stub, conversationId: number) =>
  runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) throw new Error(`no conversation ${conversationId}`)
    const agent = await conversation.agent(context)
    return { model: agent.model, thinking: agent.thinkingLevel }
  })

const threadIdOf = (outcome: unknown): number => {
  expect(outcome).toMatchObject({ kind: "started" })
  return (outcome as { threadId: number }).threadId
}

describe("models for what a Captain starts", () => {
  it("runs a crew thread on the Captain's model and thinking level, ahead of the owner's thread default", async () => {
    const stub = fresh()
    expect((await cmd(stub, "thread-default", "owner.defaults", { role: "thread", model: WIDE_MODEL })).ok).toBe(true)
    const lead = await captain(stub, "inherit", { model: THINKING_MODEL, thinking: "high" })
    expect(await agentOf(stub, lead.coordinatorId)).toEqual({ model: THINKING_MODEL, thinking: "high" })
    const threadId = threadIdOf(await delegate(stub, lead.coordinatorId, "inherit"))
    expect(await agentOf(stub, threadId)).toEqual({ model: THINKING_MODEL, thinking: "high" })
    const got = await cmd(stub, "get-inherit", "captain.get", { id: lead.id })
    expect(got.result).toMatchObject({
      thinking: "high",
      crew: [{ threadId, model: `${THINKING_MODEL.provider}/${THINKING_MODEL.modelId} · high` }],
    })
  })

  it("takes an override by name or id, and its thinking level, for one thread", async () => {
    const stub = fresh()
    const lead = await captain(stub, "override", { model: THINKING_MODEL, thinking: "high" })
    const byName = threadIdOf(await delegate(stub, lead.coordinatorId, "by-name", { query: "alt wide" }))
    expect(await agentOf(stub, byName)).toMatchObject({ model: WIDE_MODEL })
    const lower = threadIdOf(
      await delegate(stub, lead.coordinatorId, "lower", { model: THINKING_MODEL, thinking: "low" }),
    )
    expect(await agentOf(stub, lower)).toEqual({ model: THINKING_MODEL, thinking: "low" })
    expect(await agentOf(stub, lead.coordinatorId)).toEqual({ model: THINKING_MODEL, thinking: "high" })
    const created = await cmd(stub, "create-override", "thread.create", {
      title: "direct",
      task: "say hi",
      spaceId: lead.spaceId,
      target: { query: "alt wide" },
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    expect(await agentOf(stub, (created.result as { threadId: number }).threadId)).toMatchObject({ model: WIDE_MODEL })
  })

  it("refuses a model with no key or a disabled one, naming usable models, and drops thinking on a model without it", async () => {
    const stub = fresh()
    const lead = await captain(stub, "refuse", { model: THINKING_MODEL })
    const catalog = await cmd(stub, "anthropic", "models.catalog", { provider: "anthropic" })
    const unkeyed = (catalog.result as { models: { provider: string; modelId: string; keyed: boolean }[] }).models.find(
      (model) => !model.keyed,
    )
    if (unkeyed === undefined) throw new Error("no unkeyed anthropic model")
    const noKey = await delegate(stub, lead.coordinatorId, "no-key", {
      model: { provider: unkeyed.provider, modelId: unkeyed.modelId },
    })
    expect(noKey).toMatchObject({ kind: "no_model" })
    expect((noKey as { reason: string }).reason).toMatch(/has no key.*Usable: /)
    expect(
      await cmd(stub, "configure-no-key", "conv.configure", {
        conv: lead.coordinatorId,
        model: { provider: unkeyed.provider, modelId: unkeyed.modelId },
      }),
    ).toMatchObject({ ok: false, error: { code: "bad_args" } })
    expect((await cmd(stub, "disable", "models.enable", { model: WIDE_MODEL, enabled: false })).ok).toBe(true)
    expect(await delegate(stub, lead.coordinatorId, "disabled", { model: WIDE_MODEL })).toMatchObject({
      kind: "no_model",
    })
    const unsupported = await delegate(stub, lead.coordinatorId, "unsupported", {
      model: { provider: "faux-alt", modelId: "alt-narrow" },
      thinking: "high",
    })
    expect(unsupported).toMatchObject({ kind: "started" })
    expect(await agentOf(stub, threadIdOf(unsupported))).toMatchObject({ thinking: "off" })
  })

  it("refuses a tied name with the candidates and names why a keyless model was refused by name", async () => {
    const stub = fresh()
    const lead = await captain(stub, "names", { model: THINKING_MODEL })
    const tied = await delegate(stub, lead.coordinatorId, "tied", { query: "alt" })
    expect(tied).toMatchObject({ kind: "no_model" })
    expect((tied as { reason: string }).reason).toMatch(/Several models match "alt": .*faux-alt\/alt-/)
    const catalog = await cmd(stub, "anthropic-names", "models.catalog", { provider: "anthropic" })
    const unkeyed = (catalog.result as { models: { provider: string; modelId: string; keyed: boolean }[] }).models.find(
      (model) => !model.keyed,
    )
    if (unkeyed === undefined) throw new Error("no unkeyed anthropic model")
    const named = await delegate(stub, lead.coordinatorId, "named", { query: `${unkeyed.provider}/${unkeyed.modelId}` })
    expect((named as { reason: string }).reason).toMatch(/has no key.*Usable: /)
    const bare = await delegate(stub, lead.coordinatorId, "bare", { query: unkeyed.modelId })
    expect(bare).toMatchObject({ kind: "no_model" })
    expect((bare as { reason: string }).reason).toMatch(/No usable model matches .*has no key.*Usable: /)
  })

  it("forks a side thread on the Captain's model and thinking level", async () => {
    const stub = fresh()
    const lead = await captain(stub, "side", { model: THINKING_MODEL, thinking: "high" })
    const side = await cmd(stub, "side", "thread.side", { conv: lead.coordinatorId, title: "side", task: "say hi" })
    expect(side.ok, JSON.stringify(side)).toBe(true)
    expect(await agentOf(stub, (side.result as { threadId: number }).threadId)).toEqual({
      model: THINKING_MODEL,
      thinking: "high",
    })
  })

  it("starts a Captain created without a model on its project coordinator's model and thinking level", async () => {
    const stub = fresh()
    const project = await cmd(stub, "project-coord", "project.create", { slug: "coord", name: "coord" })
    const { id: projectId, coordinatorId } = project.result as { id: string; coordinatorId: number }
    const configured = await cmd(stub, "coord-model", "conv.configure", {
      conv: coordinatorId,
      model: THINKING_MODEL,
      thinking: "high",
    })
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    const created = await cmd(stub, "captain-coord", "captain.create", { projectId, name: "Inherits" })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    expect(await agentOf(stub, (created.result as Captain).coordinatorId)).toEqual({
      model: THINKING_MODEL,
      thinking: "high",
    })
  })
})
