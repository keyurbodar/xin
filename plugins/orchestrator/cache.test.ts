import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { cmd, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { withShortCache } from "./cache.ts"

const context = BACKGROUND_CONTEXT
const ENDPOINT = { provider: "cache-endpoint", modelId: "stub-1" } as const
const THREAD_PROMPT = "You are a thread named"

const events = [
  {
    type: "message_start",
    message: {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "stub-1",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]

const answer = (): Response =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

type Body = { readonly system?: unknown; readonly tools?: unknown; readonly messages?: unknown }

const ttls = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(ttls)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) =>
    key === "cache_control" && typeof inner === "object" && inner !== null
      ? [String(Reflect.get(inner, "ttl") ?? "5m")]
      : ttls(inner),
  )
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition not reached")
}

describe("prompt cache retention", () => {
  it("drops only the ttl of Anthropic-format cache breakpoints", () => {
    const payload = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "ttl", cache_control: { type: "ephemeral" } }] }],
      metadata: { ttl: "kept" },
    }
    expect(withShortCache(payload)).toEqual({
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "ttl", cache_control: { type: "ephemeral" } }] }],
      metadata: { ttl: "kept" },
    })
    expect(payload.system[0]?.cache_control.ttl).toBe("1h")
  })

  it("caches a coordinator for an hour and a thread for five minutes", async () => {
    const stub = fresh()
    const bodies: Body[] = []
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "stub-1", object: "model" }] })
      const text = input instanceof Request ? await input.text() : String(init?.body ?? "")
      bodies.push(JSON.parse(text) as Body)
      return answer()
    }
    try {
      const set = await cmd(stub, "cache-cred", "credential.set", {
        provider: ENDPOINT.provider,
        key: "endpoint-key",
        custom: { baseUrl: "https://endpoint.test", key: "endpoint-key", api: "anthropic-messages" },
      })
      expect(set.ok, JSON.stringify(set)).toBe(true)
      for (const role of ["chat", "thread"])
        expect((await cmd(stub, `cache-${role}`, "owner.defaults", { role, model: ENDPOINT })).ok).toBe(true)
      const created = await cmd(stub, "cache-project", "project.create", { slug: "cache", name: "cache" })
      const project = created.result as { coordinatorId: number }

      await runInDurableObject(stub, async (home: Home) => {
        const coordinator = await home.harness.conversation(project.coordinatorId as ConversationId, context)
        if (coordinator === undefined) throw new Error("no coordinator")
        await coordinator.configure({ model: ENDPOINT }, context)
        await coordinator.submit({ type: "input", content: "hello", requestId: "cache-hello" }, context)
        await coordinator.waitForIdle(context)
        const outcome = await home.loader.ctx.threads.delegate(
          { conversationId: project.coordinatorId as ConversationId, taskId: "cache-test" },
          { task: "say ok", title: "Ok", mode: "async", clientRequestId: "cache-thread" },
          context,
        )
        expect(outcome.kind, JSON.stringify(outcome)).toBe("started")
      })
      await until(() => bodies.some((body) => JSON.stringify(body.system).includes(THREAD_PROMPT)))

      const coordinatorBody = bodies[0]
      const threadBody = bodies.find((body) => JSON.stringify(body.system).includes(THREAD_PROMPT))
      expect(ttls(coordinatorBody).length).toBeGreaterThan(0)
      expect(new Set(ttls(coordinatorBody))).toEqual(new Set(["1h"]))
      expect(ttls(threadBody).length).toBeGreaterThan(0)
      expect(new Set(ttls(threadBody))).toEqual(new Set(["5m"]))
    } finally {
      globalThis.fetch = original
    }
  }, 30_000)
})
