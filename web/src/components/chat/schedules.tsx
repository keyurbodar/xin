import { For, Show, createResource, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { ago, describeRule } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { Icon } from "../ui/icon.tsx"
import { Signal } from "../ui/signal.tsx"
import { Loading, RowSkeleton } from "../ui/skeleton.tsx"
import { Toggle } from "../extensions/chrome.tsx"
import { createPaneAction, EmptyState, ResourceError } from "./ui.tsx"

type ScheduleRun = {
  readonly slot: string
  readonly deliveredAt: string
  readonly conversationId: number
  readonly outcome: "done" | "failed" | "running"
}

type Schedule = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly rrule?: string
  readonly at?: string
  readonly target: string
  readonly active: boolean
  readonly nextAt: string | null
  readonly updatedAt: string
  readonly lastDelivery?: { readonly scheduledAt: string; readonly deliveredAt: string }
  readonly runs?: readonly ScheduleRun[]
}

function nextRun(value: string | null): string {
  if (value === null) return "not scheduled"
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function ruleOf(schedule: Schedule): string {
  if (schedule.rrule !== undefined) return describeRule(schedule.rrule)
  if (schedule.at !== undefined) {
    const at = Date.parse(schedule.at)
    if (!Number.isNaN(at)) return new Date(at).toLocaleString()
  }
  return "once"
}

export function SchedulesTab(props: { slug: string }): JSX.Element {
  const [schedules, { refetch }] = createResource(() =>
    cmd<{ readonly schedules: readonly Schedule[] }>("schedule.list", { outcomes: true }),
  )
  const action = createPaneAction()
  const toggle = (schedule: Schedule): Promise<void> =>
    action.run(schedule.id, async () => {
      await cmd("schedule.edit", { action: "update", id: schedule.id, active: !schedule.active })
      await refetch()
    })

  return (
    <Loading when={schedules.loading} skeleton={<RowSkeleton rows={4} />} label="Loading schedules">
      <Show when={schedules.error} fallback={null}>
        <ResourceError what="schedules" error={schedules.error} onRetry={() => void refetch()} />
      </Show>
      <div class="flex items-center gap-2 border-b border-line-1 px-3 py-2.5">
        <span class="min-w-0 flex-1 text-sm leading-[1.5] text-ink-3">
          Starts a thread on a timer. Results land in this chat.
        </span>
        <button
          type="button"
          class="shrink-0 rounded-sm border border-line-1 px-2 py-1 text-sm text-ink-2 hover:border-line-3 hover:text-ink"
          onClick={() => navigate("/schedules")}
        >
          New
        </button>
      </div>
      <Show when={action.failed()}>
        {(message) => <div class="border-b border-line-1 px-3 py-2 text-sm text-failed">{message()}</div>}
      </Show>
      <Show when={schedules()}>
        {(data) => (
          <Show
            when={data().schedules.length > 0}
            fallback={<EmptyState pictogram="schedules" title="No schedules" detail="A schedule starts a thread on a timer; its results land in this chat." />}
          >
            <div class="flex flex-col">
              <For each={data().schedules}>
                {(schedule) => (
                  <div class="flex flex-col gap-1.5 border-b border-line-1 px-3 py-3" classList={{ "opacity-60": !schedule.active }}>
                    <div class="flex items-center gap-2">
                      <Signal state={schedule.active ? "queued" : "idle"} size={16} />
                      <span class="min-w-0 flex-1 truncate text-base font-medium text-ink">{schedule.title}</span>
                      <Toggle
                        on={schedule.active}
                        label={schedule.active ? `Pause ${schedule.title}` : `Resume ${schedule.title}`}
                        disabled={action.busy() === schedule.id}
                        onChange={() => void toggle(schedule)}
                      />
                    </div>
                    <div class="flex items-center gap-1.5 text-sm text-ink-3">
                      <Icon name="refresh" size={12} />
                      <span class="truncate">{ruleOf(schedule)}</span>
                    </div>
                    <div class="flex items-center gap-2 font-mono text-2xs text-icon">
                      <span>next {nextRun(schedule.nextAt)}</span>
                      <Show when={schedule.lastDelivery}>
                        {(last) => <span>· last ran {ago(Date.parse(last().deliveredAt))}</span>}
                      </Show>
                      <Show when={schedule.runs && schedule.runs.length > 0}>
                        <span class="ml-auto flex items-center gap-[3px]">
                          <For each={schedule.runs}>
                            {(run) => (
                              <button
                                type="button"
                                aria-label={`Run ${run.deliveredAt}: ${run.outcome}`}
                                title={`${new Date(run.deliveredAt).toLocaleString()} · ${run.outcome}`}
                                class="h-2 w-2 shrink-0 rounded-2xs hover:opacity-75"
                                classList={{
                                  "bg-done": run.outcome === "done",
                                  "bg-failed": run.outcome === "failed",
                                  "bg-line-2": run.outcome === "running",
                                }}
                                onClick={() => navigate(`/p/${props.slug}/run/${run.conversationId}`)}
                              />
                            )}
                          </For>
                        </span>
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
