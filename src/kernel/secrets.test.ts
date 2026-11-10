import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { cmd, fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
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

const stored = (stub: Stub): Promise<{ value: string } | undefined> =>
  runInDurableObject(stub, (home: Home) =>
    home.db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", "secret.TOKEN"),
  )

describe("credentials", () => {
  it("sets, reads and redacts a credential, keeps it sealed at rest and across eviction", async () => {
    const stub = fresh()
    const secret = "s3cr3t-value"

    expect(await cmd(stub, "s1", "secret.set", { ref: "TOKEN", value: secret })).toMatchObject({
      ok: true,
      result: { application: "applied", ref: "TOKEN" },
    })

    expect(await turn(stub, "s_echo_secret", "e1")).toBe("token=[redacted]")
    expect(await turn(stub, "s_echo_len", "l1")).toBe(`len=${secret.length}`)

    const row = await stored(stub)
    expect(row?.value).not.toContain(secret)
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({
      iv: expect.any(String),
      data: expect.any(String),
    })

    const entries = await runInDurableObject(stub, async (home: Home) =>
      (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT),
    )
    expect(JSON.stringify(entries.items)).not.toContain(secret)

    await evictDurableObject(stub)
    expect(await turn(stub, "s_echo_secret", "e2")).toBe("token=[redacted]")
    expect(await turn(stub, "s_echo_len", "l2")).toBe(`len=${secret.length}`)
  })

  it("redacts the details and structured output channels", async () => {
    const stub = fresh()
    const secret = "s3cr3t-value"
    expect(await cmd(stub, "s4", "secret.set", { ref: "TOKEN", value: secret })).toMatchObject({ ok: true })

    expect(await turn(stub, "s_echo_details", "d1")).toBe("details")
    const entries = await runInDurableObject(stub, async (home: Home) =>
      (await home.root()).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT),
    )
    expect(JSON.stringify(entries.items)).not.toContain(secret)

    expect(await turn(stub, "s_echo_nested", "n1")).toBe("structured=redacted")
  })

  it("denies a plugin row every credential value", async () => {
    const stub = fresh()
    expect(await cmd(stub, "s3", "secret.set", { ref: "TOKEN", value: "s3cr3t-value" })).toMatchObject({ ok: true })
    expect(await turn(stub, "s_echo_values", "v1")).toBe("denied")
  })

  it("writes through the service and deletes with an empty value", async () => {
    const stub = fresh()

    expect(await turn(stub, "s_echo_write", "w1")).toBe("written")
    expect(await turn(stub, "s_echo_secret", "e1")).toBe("token=[redacted]")

    expect(await cmd(stub, "d1", "secret.set", { ref: "TOKEN", value: "" })).toMatchObject({
      ok: true,
      result: { application: "applied", ref: "TOKEN" },
    })
    expect(await stored(stub)).toBeUndefined()
    expect(await turn(stub, "s_echo_secret", "e2")).toBe("token=undefined")
  })

  it("rejects a credential reference that breaks the ref grammar", async () => {
    const stub = fresh()
    expect(await cmd(stub, "s2", "secret.set", { ref: "Bad Ref", value: "x" })).toMatchObject({
      ok: false,
      error: { code: "bad_args" },
    })
  })
})
