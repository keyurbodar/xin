import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it, vi } from "vitest"
import { respond } from "../../test/plugins/m8.ts"
import { cmd, eventually, fresh, rowOf, setRow, type Stub, toolTexts, turn } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"
import { BrowserDoc, type BrowserState, createSessions } from "./session.ts"

const TOOLS = ["browser_act", "browser_close", "browser_open", "browser_screenshot", "browser_snapshot"]
const PAGE = '- heading "Example Domain" [level=1]\n- link "Learn more" [ref=e1]'
const KEY = /^ingle-browser:[0-9a-f-]{36}:(\d+):(create|delete)$/

type Call = {
  readonly method: string
  readonly path: string
  readonly key: string | null
  readonly confirm: string | null
  readonly authorized: boolean
  readonly body: Record<string, unknown> | undefined
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const failure = (status: number, code: string) => json({ error: { code, message: code, retryable: false } }, status)

const unused = (): never => {
  throw new Error("the backend is not called to claim an action")
}

const ok = (stdout: string) => json({ stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false })

function fakeInstabox(options: { snapshot?: string; failInstalls?: number } = {}) {
  const calls: Call[] = []
  const machines = new Set<string>()
  const replies = new Map<string, unknown>()
  const operations = new Map<string, unknown>()
  let failInstalls = options.failInstalls ?? 0
  let next = 0
  const operation = (key: string | null, type: string, machineId: string, act: () => void): Response => {
    if (key === null) return failure(400, "bad_request")
    const known = replies.get(key)
    if (known !== undefined) return json(known, 202)
    act()
    const id = `op_${++next}`
    const reply = { id, machineId, type, state: "queued", error: null }
    replies.set(key, reply)
    operations.set(id, { ...reply, state: "succeeded" })
    return json(reply, 202)
  }
  const exec = (body: Record<string, unknown>): Response => {
    if (typeof body.cmd === "string") {
      if (failInstalls > 0) {
        failInstalls -= 1
        return failure(503, "host_unavailable")
      }
      return ok("")
    }
    const argv = Array.isArray(body.argv) ? body.argv.map(String) : []
    const [program, verb, ...rest] = argv
    if (program === "base64") return ok("/9j/4AAQ")
    if (program !== "agent-browser") return failure(400, "bad_request")
    switch (verb) {
      case "open":
        return ok(`✓ Example Domain\n  ${rest[0] ?? ""}`)
      case "snapshot":
        return ok(options.snapshot ?? PAGE)
      case "click":
        return rest[0] === "@e1"
          ? ok("✓ Done")
          : json({
              stdout: "",
              stderr: `✗ Unknown ref: ${rest[0] ?? ""}`,
              exitCode: 1,
              timedOut: false,
              truncated: false,
            })
      case "fill":
      case "screenshot":
        return ok("✓ Done")
      default:
        return failure(400, "bad_request")
    }
  }
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== "https://api.instabox.sh") return new Response("not found", { status: 404 })
    const text = await request.text()
    const body = text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>)
    const key = request.headers.get("idempotency-key")
    calls.push({
      method: request.method,
      path: url.pathname,
      key,
      confirm: request.headers.get("x-confirm-delete"),
      authorized: request.headers.get("x-api-key") === env.INSTABOX_API_KEY,
      body,
    })
    const parts = url.pathname.split("/").filter((part) => part !== "")
    const [, resource, id, verb] = parts
    if (resource === "operations" && id !== undefined) {
      const found = operations.get(id)
      return found === undefined ? failure(404, "not_found") : json(found)
    }
    if (resource !== "machines") return failure(404, "not_found")
    if (id === undefined && request.method === "POST") {
      const machineId = `m_${next + 1}`
      return operation(key, "create", machineId, () => machines.add(machineId))
    }
    if (id === undefined) return failure(404, "not_found")
    const known = machines.has(id)
    if (request.method === "DELETE") {
      if (request.headers.get("x-confirm-delete") !== id) return failure(409, "delete_confirmation_required")
      if (!known && !replies.has(key ?? "")) return failure(404, "not_found")
      return operation(key, "delete", id, () => machines.delete(id))
    }
    if (!known || verb !== "exec") return failure(404, "not_found")
    return exec(body ?? {})
  }) as typeof fetch
  return { calls, machines, fetch: fetcher }
}

type Fake = ReturnType<typeof fakeInstabox>

async function withFake<T>(fake: Fake, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fake.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const call =
  (name: string, args: JsonObject = {}) =>
  () =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })

const done = () => fauxAssistantMessage("done")

async function browserHome(): Promise<{ readonly stub: Stub; readonly root: ConversationId }> {
  const stub = fresh()
  await setRow(stub, "tool-browser", true)
  const root = await runInDurableObject(stub, async (home: Home) => {
    const conversation = await home.root()
    const agent = await conversation.agent(BACKGROUND_CONTEXT)
    const add = agent.deferred.filter((tool) => TOOLS.includes(tool.name))
    expect(add.map((tool) => tool.name).toSorted()).toEqual(TOOLS)
    await conversation.configure({ modelTools: { add } }, BACKGROUND_CONTEXT)
    return conversation.id
  })
  return { stub, root }
}

const stateOf = (stub: Stub, root: ConversationId): Promise<BrowserState | undefined> =>
  runInDurableObject(stub, (home: Home) => home.harness.snapshot(BrowserDoc, root, BACKGROUND_CONTEXT))

const lifecycle = (fake: Fake) =>
  fake.calls
    .filter((entry) => entry.key !== null)
    .map((entry) => {
      const match = KEY.exec(entry.key ?? "")
      return match === null ? `bad key ${entry.key ?? ""}` : `${match[2] ?? ""} ${match[1] ?? ""}`
    })

describe("browser tools", () => {
  it("ships the browser row disabled and mounts it when enabled", async () => {
    const stub = fresh()
    expect(await rowOf(stub, "tool-browser")).toMatchObject({ disabled: true, state: { kind: "disabled" } })
    await setRow(stub, "tool-browser", true)
    expect(await rowOf(stub, "tool-browser")).toMatchObject({ disabled: false })
  })

  it("opens, snapshots, acts, screenshots and closes one machine per conversation", async () => {
    const fake = fakeInstabox()
    await withFake(fake, async () => {
      const { stub, root } = await browserHome()
      respond([
        call("browser_open", { url: "https://example.com" }),
        call("browser_snapshot"),
        call("browser_act", { action: "click", ref: "e1" }),
        call("browser_act", { action: "click", ref: "e9" }),
        call("browser_screenshot"),
        done,
      ])
      await turn(stub, "browser-flow", { text: "browse" })
      const texts = await toolTexts(stub)
      expect(texts[0]).toBe(`✓ Example Domain\n  https://example.com/\n\n${PAGE}`)
      expect(texts[1]).toBe(PAGE)
      expect(texts[2]).toBe(`✓ Done\n\n${PAGE}`)
      expect(texts[3]).toBe("browser_act failed: ✗ Unknown ref: @e9")
      expect(fake.machines.size).toBe(1)
      expect(lifecycle(fake)).toEqual(["create 1"])
      expect(fake.calls.every((entry) => entry.authorized)).toBe(true)
      const state = await stateOf(stub, root)
      expect(state?.session).toMatchObject({ generation: 1, state: "running", machine: { id: "m_1" } })

      respond([call("browser_close"), call("browser_snapshot"), done])
      await turn(stub, "browser-close", { text: "close it" })
      const after = await toolTexts(stub)
      expect(after.slice(-2)).toEqual([
        "Closed the browser.",
        "browser_snapshot failed: No browser is open in this conversation. Call browser_open first.",
      ])
      expect(fake.machines.size).toBe(0)
      const deleted = fake.calls.find((entry) => entry.method === "DELETE")
      expect(deleted?.confirm).toBe("m_1")
      expect((await stateOf(stub, root))?.session).toBeUndefined()

      respond([call("browser_open", { url: "https://example.com/again" }), done])
      await turn(stub, "browser-reopen", { text: "open again" })
      expect(lifecycle(fake)).toEqual(["create 1", "delete 1", "create 2"])
    })
  }, 30_000)

  it("returns an image from browser_screenshot", async () => {
    const fake = fakeInstabox()
    await withFake(fake, async () => {
      const { stub, root } = await browserHome()
      respond([call("browser_open", { url: "https://example.com" }), call("browser_screenshot"), done])
      await turn(stub, "browser-shot", { text: "look" })
      const images = await runInDurableObject(stub, async (home: Home) => {
        const conversation = await home.harness.conversation(root, BACKGROUND_CONTEXT)
        const page = await conversation?.entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT)
        return (page?.items ?? []).flatMap((entry) =>
          (entry.model ?? []).flatMap((message) =>
            message.role === "toolResult" ? message.content.filter((part) => part.type === "image") : [],
          ),
        )
      })
      expect(images).toEqual([{ type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" }])
    })
  }, 30_000)

  it("reuses the same create key after a start that failed part way", async () => {
    const fake = fakeInstabox({ failInstalls: 1 })
    await withFake(fake, async () => {
      const { stub, root } = await browserHome()
      respond([
        call("browser_open", { url: "https://example.com" }),
        call("browser_open", { url: "https://example.com" }),
        done,
      ])
      await turn(stub, "browser-retry", { text: "browse" })
      const texts = await toolTexts(stub)
      expect(texts[0]).toContain("browser_open failed: Instabox answered 503 host_unavailable")
      expect(texts[1]).toContain("✓ Example Domain")
      expect(lifecycle(fake)).toEqual(["create 1", "create 1"])
      expect(fake.machines.size).toBe(1)
      expect((await stateOf(stub, root))?.session).toMatchObject({ state: "running", machine: { id: "m_1" } })
    })
  }, 30_000)

  it("deletes an idle machine once, even when the alarm runs again, and creates a new one on the next open", async () => {
    const fake = fakeInstabox()
    vi.useFakeTimers({ toFake: ["Date"] })
    await withFake(fake, async () => {
      try {
        const { stub, root } = await browserHome()
        respond([call("browser_open", { url: "https://example.com" }), done])
        await turn(stub, "browser-idle", { text: "browse" })
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await runDurableObjectAlarm(stub)
        await eventually(stub, async (home) => {
          const state = await home.harness.snapshot(BrowserDoc, root, BACKGROUND_CONTEXT)
          return state?.session?.state === "closed"
        })
        await runDurableObjectAlarm(stub)
        expect(lifecycle(fake)).toEqual(["create 1", "delete 1"])
        expect(fake.machines.size).toBe(0)
        expect((await stateOf(stub, root))?.session).toEqual({
          generation: 1,
          key: expect.stringMatching(/^ingle-browser:[0-9a-f-]{36}:1$/),
          usedAt: expect.any(Number),
          state: "closed",
        })

        respond([
          call("browser_snapshot"),
          call("browser_open", { url: "https://example.com" }),
          call("browser_snapshot"),
          done,
        ])
        await turn(stub, "browser-wake", { text: "again" })
        const texts = await toolTexts(stub)
        expect(texts.at(-3)).toBe(
          "browser_snapshot failed: The browser was closed after 10 idle minutes. Call browser_open to start a new one.",
        )
        expect(texts.at(-1)).toBe(PAGE)
        expect(lifecycle(fake)).toEqual(["create 1", "delete 1", "create 2"])
        expect([...fake.machines.keys()]).toEqual(["m_3"])
        expect((await stateOf(stub, root))?.session).toMatchObject({ generation: 2, state: "running" })
      } finally {
        vi.useRealTimers()
      }
    })
  }, 30_000)

  it("pages a long snapshot 8,000 characters at a time", async () => {
    const long = "abcdefghij".repeat(1_800)
    const fake = fakeInstabox({ snapshot: long })
    await withFake(fake, async () => {
      const { stub } = await browserHome()
      respond([
        call("browser_open", { url: "https://example.com" }),
        call("browser_snapshot", { offset: 16_000 }),
        call("browser_snapshot", { offset: 20_000 }),
        done,
      ])
      await turn(stub, "browser-paging", { text: "read" })
      const [first, last, past] = await toolTexts(stub)
      expect(first).toContain(
        `${long.slice(0, 8_000)}\n\n[Showing characters 0–8000 of 18,000. Call browser_snapshot with offset 8000 for more.]`,
      )
      expect(last).toBe(long.slice(16_000))
      expect(past).toBe("[Offset 20000 is past the end: the snapshot has 18,000 characters.]")
    })
  }, 30_000)

  it("refuses a non-web URL without starting a machine", async () => {
    const fake = fakeInstabox()
    await withFake(fake, async () => {
      const { stub } = await browserHome()
      respond([call("browser_open", { url: "file:///etc/passwd" }), done])
      await turn(stub, "browser-file", { text: "read" })
      expect(await toolTexts(stub)).toEqual(["browser_open failed: only http and https URLs are supported"])
      expect(fake.calls).toEqual([])
    })
  })

  it("does not repeat an action whose job reruns after a crash", async () => {
    const { stub, root } = await browserHome()
    const outcomes = await runInDurableObject(stub, async (home: Home) => {
      await home.harness.commit(async (tx) => {
        const doc = await tx.doc(BrowserDoc, root)
        doc.generation = 1
        const key = "ingle-browser:test:1"
        doc.session = { generation: 1, key, usedAt: Date.now(), state: "running", machine: { id: "m_1", key } }
      }, BACKGROUND_CONTEXT)
      const sessions = createSessions({ start: unused, run: unused, close: unused }, 600_000)
      const scope = {
        docs: home.harness,
        conversationId: root,
        signal: AbortSignal.timeout(10_000),
        context: BACKGROUND_CONTEXT,
      }
      const first = await sessions.act(scope, 41)
      const rerun = await sessions.act(scope, 41)
      const next = await sessions.act(scope, 42)
      return [first.replayed, rerun.replayed, next.replayed]
    })
    expect(outcomes).toEqual([false, true, false])
  })

  it("deletes after the configured idle time and not before", async () => {
    const fake = fakeInstabox()
    vi.useFakeTimers({ toFake: ["Date"] })
    await withFake(fake, async () => {
      try {
        const { stub, root } = await browserHome()
        const configured = await cmd(stub, `browser-config-${crypto.randomUUID()}`, "plugin.configure", {
          id: "tool-browser",
          config: { idleMinutes: 3 },
        })
        expect(configured.ok, JSON.stringify(configured)).toBe(true)
        respond([call("browser_open", { url: "https://example.com" }), done])
        await turn(stub, "browser-configured", { text: "browse" })
        const opened = Date.now()
        vi.setSystemTime(opened + 2 * 60_000)
        await runDurableObjectAlarm(stub)
        expect((await stateOf(stub, root))?.session?.state).toBe("running")
        vi.setSystemTime(opened + 4 * 60_000)
        await runDurableObjectAlarm(stub)
        await eventually(stub, async (home) => {
          const state = await home.harness.snapshot(BrowserDoc, root, BACKGROUND_CONTEXT)
          return state?.session?.state === "closed"
        })
        expect(lifecycle(fake)).toEqual(["create 1", "delete 1"])
      } finally {
        vi.useRealTimers()
      }
    })
  }, 30_000)
})
