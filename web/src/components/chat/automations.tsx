import { For, Show, createResource, type JSX } from "solid-js"
import { firstLoad } from "../../lib/loading.ts"
import { cmd } from "../../lib/api.ts"
import { type Automation, type AutomationList, type AutomationRun, describeTriggers, nextRun } from "../../lib/automations.ts"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import type { ProjectSummary } from "../../state/home.ts"
import { Icon } from "../ui/icon.tsx"
import { Signal } from "../ui/signal.tsx"
import { Loading, RowSkeleton } from "../ui/skeleton.tsx"
import { Toggle } from "../extensions/chrome.tsx"
import { createPaneAction, EmptyState, ResourceError } from "./ui.tsx"

function outcome(run: AutomationRun): "done" | "failed" | "running" {
  if (run.status === "completed" || run.status === "delivered") return "done"
  if (run.status === "failed" || run.status === "cancelled") return "failed"
  return "running"
}

export function AutomationsTab(props: { project: ProjectSummary }): JSX.Element {
  const [automations, { refetch }] = createResource(async () => {
    const list = await cmd<AutomationList>("automation.list", {})
    return list.automations.filter((automation) => automation.project === props.project.id)
  })
  const action = createPaneAction()
  const toggle = (automation: Automation): Promise<void> =>
    action.run(automation.id, async () => {
      await cmd("automation.update", { id: automation.id, enabled: !automation.enabled })
      await refetch()
    })
  const open = (run: AutomationRun): void => {
    if (run.threadId !== null) navigate(`/p/${props.project.slug}/run/${run.threadId}`)
  }

  return (
    <Loading when={firstLoad(automations)} skeleton={<RowSkeleton rows={4} />} label="Loading automations">
      <Show when={automations.error} fallback={null}>
        <ResourceError what="automations" error={automations.error} onRetry={() => void refetch()} />
      </Show>
      <div class="flex items-center gap-2 border-b border-line-1 px-3 py-2.5">
        <span class="min-w-0 flex-1 text-sm leading-[1.5] text-ink-3">
          Starts a thread on a schedule or a webhook. Results land in this chat.
        </span>
        <button
          type="button"
          class="shrink-0 rounded-sm border border-line-1 px-2 py-1 text-sm text-ink-2 hover:border-line-3 hover:text-ink"
          onClick={() => navigate("/automations")}
        >
          New
        </button>
      </div>
      <Show when={action.failed()}>
        {(message) => <div class="border-b border-line-1 px-3 py-2 text-sm text-failed">{message()}</div>}
      </Show>
      <Show when={automations()}>
        {(data) => (
          <Show
            when={data().length > 0}
            fallback={
              <EmptyState
                pictogram="schedules"
                title="No automations"
                detail="An automation starts a thread on a schedule or a webhook; its results land in this chat."
              />
            }
          >
            <div class="flex flex-col">
              <For each={data()}>
                {(automation) => (
                  <div
                    class="flex flex-col gap-1.5 border-b border-line-1 px-3 py-3"
                    classList={{ "opacity-60": !automation.enabled }}
                  >
                    <div class="flex items-center gap-2">
                      <Signal state={automation.enabled ? "queued" : "idle"} size={16} />
                      <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{automation.title}</span>
                      <Toggle
                        on={automation.enabled}
                        label={automation.enabled ? `Pause ${automation.title}` : `Resume ${automation.title}`}
                        disabled={action.busy() === automation.id}
                        onChange={() => void toggle(automation)}
                      />
                    </div>
                    <div class="flex items-center gap-1.5 text-sm text-ink-3">
                      <Icon name="refresh" size={12} />
                      <span class="truncate">{describeTriggers(automation)}</span>
                    </div>
                    <div class="flex items-center gap-2 font-mono text-2xs text-icon">
                      <span>next {nextRun(automation.nextAt)}</span>
                      <Show when={automation.lastRun}>
                        {(run) => (
                          <>
                            <span>· last ran {ago(Date.parse(run().createdAt))}</span>
                            <button
                              type="button"
                              aria-label={`Run ${run().createdAt}: ${outcome(run())}`}
                              title={`${new Date(run().createdAt).toLocaleString()} · ${outcome(run())}`}
                              disabled={run().threadId === null}
                              class="ml-auto h-2 w-2 shrink-0 rounded-2xs hover:opacity-75"
                              classList={{
                                "bg-done": outcome(run()) === "done",
                                "bg-failed": outcome(run()) === "failed",
                                "bg-line-2": outcome(run()) === "running",
                              }}
                              onClick={() => open(run())}
                            />
                          </>
                        )}
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </Loading>
  )
}
