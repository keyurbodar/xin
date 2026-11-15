import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Plus } from "lucide-solid"
import { firstLoad } from "../lib/loading.ts"
import { describeTriggers, nextLabel, TARGET_WORD, type Automation } from "../lib/automations.ts"
import { createAutomationList } from "../state/automations.ts"
import { homeProjects } from "../state/home.ts"
import { AutomationDialog } from "../components/automations/dialog.tsx"
import { createAutomationActions, DeleteAutomationDialog, EnabledToggle, LastRun, RowMenu } from "../components/automations/parts.tsx"
import { Loading, RowSkeleton } from "../components/ui/skeleton.tsx"
import { EmptyState, ResourceError } from "../components/chat/ui.tsx"

const GRID = "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,240px)_96px_72px_76px] md:items-center md:gap-4"

export function AutomationsScreen(): JSX.Element {
  const [list, retry] = createAutomationList()
  const actions = createAutomationActions(() => list.latest)
  const [creating, setCreating] = createSignal(false)
  const [deleting, setDeleting] = createSignal<Automation>()
  const shown = createMemo(() => (list.latest ?? []).filter((automation) => !actions.removed(automation)))

  return (
    <>
      <header class="flex h-[var(--h-topbar)] shrink-0 items-center gap-2 border-b border-line-1 px-4">
        <h1 class="text-base font-medium text-ink">Automations</h1>
        <Show when={list.latest !== undefined}>
          <span class="font-mono text-xs tabular-nums text-ink-3">{shown().length}</span>
        </Show>
        <button
          type="button"
          onClick={() => setCreating(true)}
          class="im-press ml-auto flex h-7 items-center gap-1.5 rounded-sm bg-primary pl-2 pr-2.5 text-sm font-medium text-on-primary hover:opacity-90"
        >
          <Plus size={14} stroke-width={1.75} />
          New automation
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[1040px] px-4 pb-12 pt-5 md:px-6">
          <Show when={list.error}>
            <div class="mb-4 overflow-hidden rounded-md border border-line-1">
              <ResourceError what="automations" error={list.error} onRetry={retry} />
            </div>
          </Show>
          <Show when={actions.failed()}>
            {(message) => (
              <div role="alert" class="im-event mb-3 rounded-md border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">
                {message()}
              </div>
            )}
          </Show>
          <Loading when={firstLoad(list)} skeleton={<RowSkeleton rows={4} />} label="Loading automations">
            <Show
              when={shown().length > 0}
              fallback={
                <Show when={list.latest !== undefined}>
                  <div class="pt-14">
                    <EmptyState
                      pictogram="schedules"
                      title="No automations yet"
                      detail="An automation runs a prompt on a schedule and posts the result to a project thread. Ask the agent to set one up, or make one here."
                      action={
                        <button
                          type="button"
                          onClick={() => setCreating(true)}
                          class="im-press flex h-8 items-center gap-1.5 rounded-sm border border-line-2 bg-card px-3 text-sm font-medium text-ink hover:border-line-3"
                        >
                          <Plus size={14} stroke-width={1.75} />
                          New automation
                        </button>
                      }
                    />
                  </div>
                </Show>
              }
            >
              <div class="overflow-hidden rounded-lg border border-line-1 bg-card">
                <div class={`hidden h-8 border-b border-line-1 px-4 text-xs text-ink-3 ${GRID}`}>
                  <span>Name</span>
                  <span>Trigger</span>
                  <span>Next run</span>
                  <span>Last run</span>
                  <span class="text-right">On</span>
                </div>
                <div class="im-stagger">
                  <For each={shown()}>
                    {(automation, index) => (
                      <Row
                        automation={automation}
                        index={index()}
                        enabled={actions.enabled(automation)}
                        busy={actions.busy() === automation.id}
                        onToggle={() => void actions.toggle(automation)}
                        onDelete={() => setDeleting(automation)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Loading>
        </div>
      </div>
      <AutomationDialog open={creating()} onClose={() => setCreating(false)} />
      <DeleteAutomationDialog automation={deleting()} onClose={() => setDeleting(undefined)} onDelete={actions.remove} />
    </>
  )
}

function Row(props: {
  automation: Automation
  index: number
  enabled: boolean
  busy: boolean
  onToggle: () => void
  onDelete: () => void
}): JSX.Element {
  const project = (): string | undefined => homeProjects().find((item) => item.id === props.automation.project)?.name
  const view = (): Automation => ({ ...props.automation, enabled: props.enabled })
  return (
    <div
      class={`flex items-start gap-3 border-b border-line-1 px-4 py-3 last:border-0 ${GRID}`}
      style={{ "--i": props.index }}
    >
      <div class="min-w-0 flex-1">
        <div class="truncate text-base font-medium" classList={{ "text-ink": props.enabled, "text-ink-2": !props.enabled }}>
          {props.automation.title}
        </div>
        <div class="mt-0.5 truncate text-sm text-ink-3">
          {TARGET_WORD[props.automation.target]}
          <Show when={project()}>{(name) => <> · {name()}</>}</Show>
        </div>
        <div class="mt-0.5 truncate text-sm text-ink-2 md:hidden">
          {describeTriggers(props.automation)} · {nextLabel(view())}
        </div>
      </div>
      <div class="hidden min-w-0 md:block">
        <div class="truncate text-sm text-ink-2" title={describeTriggers(props.automation)}>
          {describeTriggers(props.automation)}
        </div>
      </div>
      <span class="hidden font-mono text-xs tabular-nums md:block" classList={{ "text-ink-2": props.enabled, "text-ink-3": !props.enabled }}>
        {nextLabel(view())}
      </span>
      <span class="hidden md:flex">
        <LastRun automation={props.automation} />
      </span>
      <span class="flex shrink-0 items-center justify-end gap-1">
        <EnabledToggle automation={props.automation} on={props.enabled} busy={props.busy} onToggle={props.onToggle} />
        <RowMenu
          automation={props.automation}
          enabled={props.enabled}
          busy={props.busy}
          onAction={(action) => (action === "delete" ? props.onDelete() : props.onToggle())}
        />
      </span>
    </div>
  )
}
