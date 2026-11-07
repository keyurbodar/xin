/**
 * A local OpenAI-compatible model for verifying the client without a paid key.
 *
 * It is a transport, not a model: the same requests pi-ai sends to a real provider arrive
 * here, and the replies are scripted from the tools in the request. A coordinator (its
 * tools carry delegate_task) delegates once; a thread (its tools carry ask_user) asks one
 * question, then answers the resumed turn with prose. That is enough to drive threads,
 * waiting questions, reports and usage through the running Worker.
 *
 *   bun .claude/skills/verify-xin/stub-model.ts 8790
 */

const port = Number(process.argv[2] ?? 8790)
const model = "stub-1"

type Body = {
  readonly messages?: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: readonly { readonly function?: { readonly name?: string } }[]
}

function toolNames(body: Body): readonly string[] {
  return (body.tools ?? []).flatMap((tool) => (tool.function?.name === undefined ? [] : [tool.function.name]))
}

function lastText(body: Body): string {
  const last = (body.messages ?? []).toReversed().find((message) => message.role === "user")
  return typeof last?.content === "string" ? last.content : ""
}

/** A coordinator delegates; a thread asks, then answers once it has the answer in hand. */
function reply(body: Body): { readonly name: string; readonly args: Record<string, unknown> } | undefined {
  const tools = toolNames(body)
  const messages = body.messages ?? []
  const answered = messages.at(-1)?.role === "tool"
  if (answered) return undefined
  if (tools.includes("delegate_task")) {
    return {
      name: "delegate_task",
      args: {
        title: "Vendor research",
        task: "Pick a hiring vendor and report back with a recommendation.",
        mode: "async",
        clientRequestId: `stub-${Date.now()}`,
      },
    }
  }
  if (!tools.includes("ask_user")) return undefined
  return {
    name: "ask_user",
    args: {
      question: "Which hiring vendor should I go with?",
      options: ["Gusto", "Rippling", "Deel"],
    },
  }
}

const answer = "I went with **Rippling**. It keeps payroll and benefits in one place, and the price lands about 12% under Gusto at this headcount."

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function stream(body: Body): string {
  const call = reply(body)
  if (call !== undefined) {
    return [
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: call.name, arguments: "" } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call.args) } }] }, null),
      chunk({}, "tool_calls"),
    ].join("")
  }
  return [
    chunk({ role: "assistant", content: answer }, null),
    chunk({}, "stop"),
    `data: ${JSON.stringify({
      id: "stub",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    })}\n\n`,
  ].join("")
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    console.log(`${request.method} ${url.pathname}`)
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "local" }] })
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 })
    }
    const body = (await request.json().catch(() => ({}))) as Body
    return new Response(stream(body), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  },
})

console.log(`stub model on http://127.0.0.1:${port}/v1`)
