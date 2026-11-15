import { createMemo, For, Show, type JSX } from "solid-js"
import { Plus } from "lucide-solid"
import { firstLoad } from "../../lib/loading.ts"
import { describeTriggers, nextLabel } from "../../lib/automations.ts"
import { createAutomationList } from "../../state/automations.ts"
import type { ProjectSummary } from "../../state/home.ts"
import { createAutomationActions, createRowDialogs, EnabledToggle, LastRun, RowMenu } from "../automations/parts.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { PaneSkeleton, Loading } from "../ui/skeleton.tsx"
import { EmptyState, ResourceError } from "./ui.tsx"

export function AutomationsTab(props: { project: ProjectSummary }): JSX.Element {
  const { list, value, retry } = createAutomationList()
  const actions = createAutomationActions(() => value())
  const rows = createRowDialogs(actions, { project: props.project.id })
  const mine = createMemo(() =>
    (value() ?? []).filter((automation) => automation.project === props.project.id && !actions.removed(automation)),
  )

  return (
    <div class="flex flex-col">
      <div class="flex h-9 items-center gap-2 border-b border-line-1 pl-3 pr-1.5">
        <span class="min-w-0 flex-1 truncate text-sm text-ink-3">Runs land in this project's threads</span>
        <button type="button" class={ICON_BUTTON} aria-label="New automation" title="New automation" onClick={rows.create}>
          <Plus size={16} stroke-width={1.5} />
        </button>
      </div>
      <Show when={list.error}>
        <ResourceError what="automations" error={list.error} onRetry={retry} />
      </Show>
      <Show when={actions.failed()}>
        {(message) => <div class="im-event border-b border-line-1 px-3 py-2 text-sm text-failed">{message()}</div>}
      </Show>
      <Loading when={firstLoad(list)} skeleton={<PaneSkeleton rows={4} />} label="Loading automations">
        <Show
          when={mine().length > 0}
          fallback={
            <Show when={value() !== undefined}>
              <EmptyState
                pictogram="schedules"
                title="No automations"
                detail="An automation runs a prompt on a schedule; its results land in this project."
                action={
                  <button
                    type="button"
                    onClick={rows.create}
                    class="im-press h-7 rounded-sm border border-line-2 bg-card px-2.5 text-sm text-ink hover:border-line-3"
                  >
                    New automation
                  </button>
                }
              />
            </Show>
          }
        >
          <div class="im-stagger flex flex-col">
            <For each={mine()}>
              {(automation, index) => {
                const enabled = (): boolean => actions.enabled(automation)
                const busy = (): boolean => actions.busy() === automation.id
                return (
                  <div class="flex items-center gap-2.5 border-b border-line-1 py-2 pl-3 pr-1.5" style={{ "--i": index() }}>
                    <div class="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => rows.handle(automation, "open")}
                        class="block max-w-full truncate text-left text-base hover:underline hover:decoration-line-3 hover:underline-offset-4"
                        classList={{ "text-ink": enabled(), "text-ink-3": !enabled() }}
                      >
                        {automation.title}
                      </button>
                      <div class="flex min-w-0 items-center gap-1.5 text-sm text-ink-3">
                        <span class="shrink-0 font-mono text-xs tabular-nums">{nextLabel({ ...automation, enabled: enabled() })}</span>
                        <span class="shrink-0 text-icon">·</span>
                        <span class="truncate">{describeTriggers(automation)}</span>
                      </div>
                    </div>
                    <LastRun automation={automation} withAge={false} />
                    <EnabledToggle automation={automation} on={enabled()} busy={busy()} onToggle={() => void actions.toggle(automation)} />
                    <RowMenu
                      automation={automation}
                      enabled={enabled()}
                      busy={busy()}
                      onAction={(action) => rows.handle(automation, action)}
                    />
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Loading>
      {rows.dialogs()}
    </div>
  )
}
