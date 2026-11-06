import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string } }

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${crypto.randomUUID()}` })], { stopReason: "toolUse" })

const toolResults = async (home: Home): Promise<string[]> => {
  const page = await (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)
  return page.items.flatMap((entry: EntryRecord) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" && Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    ),
  )
}

async function turn(stub: Stub, tool: string, requestId: string): Promise<string> {
  return runInDurableObject(stub, async (home: Home) => {
    const before = (await toolResults(home)).length
    respond([call(tool, {}), fauxAssistantMessage("done")])
    await home.chooseModel(M8_MODEL)
    await home.submit("go", requestId)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    return (await toolResults(home)).slice(before)[0] ?? ""
  })
}

describe("plugin secrets", () => {
  it("reads only the calling row's secrets, keeps them across eviction, and redacts tool output", async () => {
    const stub = fresh()
    const secret = "s3cr3t-value"

    const applied = await cmd(stub, "s1", "plugin.secret.set", { id: "s-echo", key: "TOKEN", value: secret })
    expect(applied).toMatchObject({ ok: true, result: { application: "applied", id: "s-echo", key: "TOKEN" } })

    expect(await turn(stub, "s_echo_secret", "e1")).toBe("token=[redacted]")

    expect(await turn(stub, "s_other_secret", "o1")).toBe("token=undefined")
    expect(await turn(stub, "s_other_values", "v1")).toBe("denied")

    expect(await turn(stub, "s_other_write", "w1")).toBe("written")
    expect(await turn(stub, "s_other_secret", "o2")).toBe("token=[redacted]")
    expect(await turn(stub, "s_echo_len", "l1")).toBe(`len=${secret.length}`)
    expect(await turn(stub, "s_echo_secret", "e2")).toBe("token=[redacted]")

    await evictDurableObject(stub)
    expect(await turn(stub, "s_echo_secret", "e3")).toBe("token=[redacted]")
    expect(await turn(stub, "s_echo_len", "l2")).toBe(`len=${secret.length}`)

    const stored = await runInDurableObject(stub, async (home: Home) =>
      (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT),
    )
    expect(JSON.stringify(stored.items)).not.toContain(secret)
  })

  it("rejects a secret write with a row id that is not a plugin id", async () => {
    const stub = fresh()
    const refused = await cmd(stub, "s2", "plugin.secret.set", { id: "Bad Id", key: "TOKEN", value: "x" })
    expect(refused).toMatchObject({ ok: false, error: { code: "bad_args" } })
  })
})
