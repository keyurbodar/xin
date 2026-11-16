import { For } from "solid-js"
import { render } from "solid-js/web"
import { registerBlock, renderBlock } from "../../src/components/chat/blocks.tsx"
import { CARD_TOOLS, PolicyApprovalCard, PolicyApprovals } from "../../src/components/chat/interactive-cards.tsx"
import { BUILT_IN_THEMES, DEFAULT_THEME, setTheme } from "../../src/lib/theme.ts"
import type { RequestRow } from "../../src/state/conversation.ts"
import { refreshRequests } from "../../src/state/requests.ts"

const ARGS: Record<keyof typeof CARD_TOOLS, Record<string, unknown>> = {
  ask_user: { question: "Which region should the bucket live in?", options: ["eu-west", "us-east"] },
  request_approval: { action: "Delete the staging bucket", detail: "It holds 1,204 objects from last week's load test." },
  request_connection: { service: "Linear", reason: "To file the issue this thread found." },
  request_secret: { name: "GITHUB_TOKEN", label: "GitHub token", reason: "To open the pull request." },
}

export const STATES = ["open", "answered", "declined"] as const

const params = new URLSearchParams(location.search)
setTheme(BUILT_IN_THEMES.find((entry) => entry.id === params.get("theme")) ?? DEFAULT_THEME)
for (const [tool, Card] of Object.entries(CARD_TOOLS)) registerBlock(`tool:${tool}`, (call) => <Card {...call} />)

const tools = Object.keys(CARD_TOOLS) as (keyof typeof CARD_TOOLS)[]

const policyRow = (state: string): RequestRow => ({
  id: `approval:${state}`,
  kind: "approval",
  conversationId: 7,
  projectId: "prj_1",
  projectName: "Demo",
  threadTitle: "Cards",
  question: "Fetch the pricing page",
  options: ["Approve", "Always allow", "Deny"],
  call: { tool: "web_fetch", arguments: '{"url":"https://example.com/pricing"}' },
  askedAt: 1,
})

render(
  () => (
    <main class="mx-auto flex max-w-[720px] flex-col gap-6 p-6">
      <For each={tools}>
        {(tool) => (
          <section class="flex flex-col gap-3" data-tool={tool}>
            <For each={STATES}>
              {(state) => (
                <div data-state={state}>
                  {renderBlock("tool", {
                    name: tool,
                    callId: `${tool}-${state}`,
                    args: ARGS[tool],
                    output: "Asked the owner.",
                    details: { kind: "asked", requestId: `${tool}-${state}` },
                    status: "done",
                  })}
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <section class="flex flex-col gap-3" data-tool="approval">
        <div data-state="open">
          <PolicyApprovals conversationId={7} />
        </div>
        <div data-state="root">
          <PolicyApprovals conversationId={1} />
        </div>
        <For each={["answered", "declined"]}>
          {(state) => (
            <div data-state={state}>
              <PolicyApprovalCard request={policyRow(state)} />
            </div>
          )}
        </For>
      </section>
    </main>
  ),
  document.getElementById("root") ?? document.body,
)
void refreshRequests()
