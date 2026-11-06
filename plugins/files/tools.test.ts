import { runInDurableObject } from "cloudflare:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { M8_MODEL, respond } from "../../test/plugins/m8.ts"
import { fresh } from "../../test/support.ts"
import type { Home } from "../../test/worker.ts"

type Stub = ReturnType<typeof fresh>
type Ack = { readonly ok: boolean; readonly result?: unknown }

const FILE_TOOLS = ["edit", "read", "write"]

const cmd = (stub: Stub, id: string, op: string, args: unknown = {}): Promise<Ack> =>
  stub
    .fetch(new Request("https://xin.test/v1/cmd", { method: "POST", body: JSON.stringify({ id, op, args }) }))
    .then((reply) => reply.json<Ack>())

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

const seen: string[][] = []

const offered = (context: TranscriptContext): string[] => {
  const tools = new Set<string>()
  for (const message of context.messages) {
    if (message.role !== "system") continue
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name)
    for (const added of message.toolsAdded ?? []) tools.add(added.name)
  }
  return [...tools].toSorted()
}

const recordTools = () => (context: TranscriptContext) => {
  seen.push(offered(context))
  return fauxAssistantMessage("noted")
}

async function turn(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, async (home: Home) => {
    const index = seen.length
    await home.chooseModel(M8_MODEL)
    await home.submit("go", `turn-${crypto.randomUUID()}`)
    await home.harness.waitForIdle(BACKGROUND_CONTEXT)
    const tools = seen[index]
    if (tools === undefined) throw new Error("the faux model was not called")
    return tools
  })
}

const rowState = async (stub: Stub, id: string): Promise<unknown> => {
  const listed = await cmd(stub, `list-${id}-${crypto.randomUUID()}`, "plugin.list")
  const row = Array.isArray(listed.result) ? listed.result.find((entry) => field(entry, "id") === id) : undefined
  return field(row, "state")
}

describe("files tool row", () => {
  it("offers the text tools only while tool-files is enabled, and the files service keeps serving", async () => {
    const stub = fresh()

    respond([recordTools()])
    expect(await turn(stub)).toEqual(expect.arrayContaining(FILE_TOOLS))

    const disabled = await cmd(stub, "off", "plugin.enable", { id: "tool-files", enabled: false })
    expect(disabled.result).toMatchObject({ application: "applied", row: { state: { kind: "disabled" } } })

    respond([recordTools()])
    const hidden = await turn(stub)
    for (const name of FILE_TOOLS) expect(hidden).not.toContain(name)
    expect(hidden).toContain("plugin_manager")

    const path = `/projects/m4/tool-row-${crypto.randomUUID()}.txt`
    const put = await cmd(stub, "put", "file.put", { path, text: "still here" })
    expect(put).toMatchObject({ ok: true, result: { path, size: 10 } })
    const listed = await cmd(stub, "ls", "file.list", { prefix: "/projects/m4" })
    expect(Array.isArray(listed.result) ? listed.result.map((entry) => field(entry, "path")) : []).toContain(path)
    expect(await rowState(stub, "files")).toEqual({ kind: "active" })

    const enabled = await cmd(stub, "on", "plugin.enable", { id: "tool-files", enabled: true })
    expect(enabled.result).toMatchObject({ application: "applied", row: { state: { kind: "active" } } })

    respond([recordTools()])
    expect(await turn(stub)).toEqual(expect.arrayContaining(FILE_TOOLS))
    expect(await rowState(stub, "files")).toEqual({ kind: "active" })
  })
})
