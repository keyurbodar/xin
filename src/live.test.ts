import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable"
import { beforeAll, describe, expect, it } from "vitest"
import { answeringModels, LIVE_PROVIDER, liveEnabled, liveModels, type LiveModel } from "../test/live.ts"
import { fresh } from "../test/support.ts"
import type { Home } from "../test/worker.ts"
import { ThreadDoc } from "./contracts/threaddoc.ts"
import { threadIdsOfProject, WorkspaceDoc } from "./contracts/workspace.ts"

const context = BACKGROUND_CONTEXT

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly result?: unknown; readonly error?: unknown }

const cmd = async (stub: Stub, id: string, op: string, args: unknown): Promise<Ack> => {
  const reply = await stub.fetch(
    new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }),
  )
  const ack = await reply.json<Ack>()
  expect(ack.ok, `${op}: ${JSON.stringify(ack)}`).toBe(true)
  return ack
}

async function entries(stub: Stub, conversationId: number): Promise<readonly EntryRecord[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.harness.conversation(conversationId as ConversationId, context)
    if (conversation === undefined) return []
    return (await conversation.entries({ order: "ascending" }, 500, undefined, context)).items
  })
}

const replies = (records: readonly EntryRecord[]): readonly AssistantMessage[] =>
  records.flatMap((entry) =>
    (entry.model ?? []).filter((message): message is AssistantMessage => message.role === "assistant"),
  )

const spoke = (message: AssistantMessage): boolean =>
  message.content.some((part) => part.type === "text" && part.text.trim().length > 0)

const calledDelegate = (message: AssistantMessage): boolean =>
  message.content.some((part) => part.type === "toolCall" && part.name === "delegate_task")

async function threadsOf(stub: Stub, projectId: string): Promise<readonly { id: number; status: string }[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const workspace = await home.harness.snapshot(WorkspaceDoc, context)
    const found: { id: number; status: string }[] = []
    for (const id of threadIdsOfProject(workspace, projectId)) {
      const doc = await home.harness.snapshot(ThreadDoc, id as ConversationId, context)
      if (doc !== undefined) found.push({ id, status: doc.status })
    }
    return found
  })
}

async function until<T>(stub: Stub, label: string, check: () => Promise<T | undefined>, ms = 240_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const found = await check()
    if (found !== undefined) return found
    await runInDurableObject(stub, (home: Home) => home.fireIntake())
    await runDurableObjectAlarm(stub)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`live: timed out waiting for ${label}`)
}

const apiKey = (): string => {
  const key: unknown = Reflect.get(env, "OPENCODE_API_KEY")
  if (typeof key !== "string" || key.length === 0) throw new Error("XIN_LIVE=1 needs OPENCODE_API_KEY")
  return key
}

describe.skipIf(!liveEnabled())("live model", () => {
  let first: LiveModel
  let second: LiveModel

  beforeAll(async () => {
    const answering = await answeringModels(liveModels())
    const [a, b] = answering
    if (a === undefined || b === undefined)
      throw new Error(`the mid-run switch needs two answering models, got ${answering.map((m) => m.modelId).join(",")}`)
    first = a
    second = b
  }, 180_000)

  it(
    "coordinator replies, delegates a thread that reports back, and switches model mid-run",
    { timeout: 600_000 },
    async () => {
      const stub = fresh()
      await cmd(stub, "live-cred", "credential.set", { provider: LIVE_PROVIDER, key: apiKey() })
      const project = (await cmd(stub, "live-project", "project.create", { slug: "live", name: "Live" })).result as {
        id: string
        coordinatorId: number
      }
      const coordinator = project.coordinatorId
      await cmd(stub, "live-model-1", "conv.configure", { conv: coordinator, model: first })

      await cmd(stub, "live-send-1", "message.send", {
        conv: coordinator,
        text: "Call delegate_task exactly once now with mode async, title 'haiku', clientRequestId 'live-1', and task 'Write a three-line haiku about rain and reply with only the haiku.'. After the tool returns, tell me in one short sentence that you delegated it.",
      })

      const opening = await until(stub, "the coordinator's delegating reply", async () => {
        const said = replies(await entries(stub, coordinator))
        return said.some(calledDelegate) && said.some(spoke) ? said : undefined
      })
      expect(opening.filter(calledDelegate).every((m) => m.model === first.modelId)).toBe(true)

      await cmd(stub, "live-model-2", "conv.configure", { conv: coordinator, model: second })

      const thread = await until(stub, "the delegated thread to finish", async () => {
        const found = await threadsOf(stub, project.id)
        return found.find((t) => t.status === "completed")
      })
      const threadReplies = replies(await entries(stub, thread.id))
      expect(threadReplies.some(spoke)).toBe(true)

      const answered = await until(stub, "the coordinator's turn on the report", async () => {
        const records = await entries(stub, coordinator)
        const reportAt = records.findIndex(
          (entry) => entry.kind === "xin.batch" && JSON.stringify(entry.data ?? null).includes('"kind":"report"'),
        )
        if (reportAt === -1) return undefined
        const after = replies(records.slice(reportAt + 1)).filter(spoke)
        return after.length > 0 ? { report: JSON.stringify(records[reportAt]?.data ?? null), after } : undefined
      })
      expect(answered.report).not.toContain("(no text)")
      expect(answered.report.length).toBeGreaterThan(60)
      expect(answered.after.every((m) => m.provider === LIVE_PROVIDER && m.model === second.modelId)).toBe(true)
    },
  )
})
