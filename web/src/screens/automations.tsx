import { createMemo, For, Show, type JSX } from "solid-js"
import { Plus } from "lucide-solid"
import { firstLoad } from "../lib/loading.ts"
import { describeTriggers, nextLabel, TARGET_WORD, type Automation } from "../lib/automations.ts"
import { firstFocusable, neighbourAfter } from "../lib/focus.ts"
import { createAutomationList } from "../state/automations.ts"
import { homeProjects } from "../state/home.ts"
import { route } from "../lib/router.ts"
import { AutomationHistoryView } from "../components/automations/history.tsx"
import { createAutomationActions, createRowDialogs, EnabledToggle, LastRun, RowMenu, type RowAction } from "../components/automations/parts.tsx"
import { Loading, RowSkeleton } from "../components/ui/skeleton.tsx"
import { EmptyState, ResourceError } from "../components/chat/ui.tsx"


export function AutomationsScreen(): JSX.Element {
  const id = (): string | undefined => {
    const part = route().parts[1]
    return part === undefined ? undefined : decodeURIComponent(part)
  }
  return (
    <Show when={id()} keyed fallback={<AutomationList />}>
      {(current) => <AutomationHistoryView id={current} />}
    </Show>
  )
}

function AutomationList(): JSX.Element {
  const { list, value, retry } = createAutomationList()
  const actions = createAutomationActions(() => value())
  const shown = createMemo(() => (value() ?? []).filter((automation) => !actions.removed(automation)))
  let heading!: HTMLHeadingElement
  let rowList: HTMLDivElement | undefined
  const rows = createRowDialogs(actions, {
    focusAfter: (automation) => {
      const next = neighbourAfter(
        shown().map((item) => item.id),
        automation.id,
      )
      return next === undefined ? heading : firstFocusable(rowList?.querySelector(`[data-automation="${CSS.escape(next)}"]`))
    },
  })

  return (
    <>
      <header class="flex h-[var(--h-topbar)] shrink-0 items-center gap-2 border-b border-line-1 px-4">
        <h1 ref={heading} tabindex={-1} class="text-body font-title text-ink outline-none">Automations</h1>
        <Show when={value() !== undefined}>
          <span class="font-mono text-mini tabular-nums text-ink-3">{shown().length}</span>
        </Show>
        <button
          type="button"
          onClick={rows.create}
          class="im-press ml-auto flex h-7 items-center gap-1.5 rounded-sm bg-primary pl-2 pr-2.5 text-sm font-title text-on-primary hover:opacity-90"
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
                <Show when={value() !== undefined}>
                  <div class="pt-14">
                    <EmptyState
                      pictogram="schedules"
                      title="No automations yet"
                      detail="An automation runs a prompt on a schedule and posts the result to a project thread. Ask the agent to set one up, or make one here."
                      action={
                        <button
                          type="button"
                          onClick={rows.create}
                          class="im-press flex h-8 items-center gap-1.5 rounded-sm border border-line-2 bg-card px-3 text-sm font-title text-ink hover:border-line-3"
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
                <div ref={rowList} class="im-stagger">
                  <For each={shown()}>
                    {(automation, index) => (
                      <Row
                        automation={automation}
                        index={index()}
                        enabled={actions.enabled(automation)}
                        busy={actions.busy() === automation.id}
                        onAction={(action) => rows.handle(automation, action)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Loading>
        </div>
      </div>
      {rows.dialogs()}
    </>
  )
}

function Row(props: {
  automation: Automation
  index: number
  enabled: boolean
  busy: boolean
  onAction: (action: RowAction) => void
}): JSX.Element {
  const project = (): string | undefined => homeProjects().find((item) => item.id === props.automation.project)?.name
  const view = (): Automation => ({ ...props.automation, enabled: props.enabled })
  return (
    <div
      data-automation={props.automation.id}
      class="flex h-[var(--h-list-row)] items-center gap-3 border-b border-line-1 px-4 last:border-0 hover:bg-hover"
      style={{ "--i": props.index }}
    >
      <div class="min-w-0 flex-1 md:flex md:items-baseline md:gap-2">
        <button
          type="button"
          onClick={() => props.onAction("open")}
          class="block max-w-full shrink-0 truncate text-left text-small font-title hover:underline hover:decoration-line-3 hover:underline-offset-4 md:max-w-[60%]"
          classList={{ "text-ink": props.enabled, "text-ink-3": !props.enabled }}
        >
          {props.automation.title}
        </button>
        <div class="min-w-0 truncate text-mini text-ink-3">
          {TARGET_WORD[props.automation.target]}
          <Show when={project()}>{(name) => <> · {name()}</>}</Show>
          <span data-fold="triggers" class="lg:hidden">
            {" "}
            · {describeTriggers(props.automation)}
          </span>
          <span class="md:hidden"> · {nextLabel(view())}</span>
        </div>
      </div>
      <span data-column="triggers" class="hidden w-[220px] shrink-0 truncate text-small text-ink-2 lg:block" title={describeTriggers(props.automation)}>
        {describeTriggers(props.automation)}
      </span>
      <span
        class="hidden w-24 shrink-0 font-mono text-mini tabular-nums md:block"
        classList={{ "text-ink-2": props.enabled, "text-ink-3": !props.enabled }}
      >
        {nextLabel(view())}
      </span>
      <span class="hidden w-[72px] shrink-0 md:flex">
        <LastRun automation={props.automation} />
      </span>
      <span class="flex shrink-0 items-center justify-end gap-1">
        <EnabledToggle automation={props.automation} on={props.enabled} busy={props.busy} onToggle={() => props.onAction("toggle")} />
        <RowMenu automation={props.automation} enabled={props.enabled} busy={props.busy} onAction={props.onAction} />
      </span>
    </div>
  )
}
