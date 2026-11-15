import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { firstLoad } from "../lib/loading.ts"
import { cmd, OpError } from "../lib/api.ts"
import { type Automation, type AutomationList, describeTriggers, nextRun } from "../lib/automations.ts"
import { TopBar, TopButton } from "../components/shell/topbar.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { MorphIcon } from "../components/ui/morph-icon.tsx"
import { ago } from "../lib/format.ts"
import { Loading, RowSkeleton } from "../components/ui/skeleton.tsx"
import { CreateAutomation } from "../components/automations/create.tsx"
import { EmptyState } from "../components/chat/ui.tsx"

const TARGET_WORD: Readonly<Record<Automation["target"], string>> = {
  fresh: "New thread each run",
  same: "One standing thread",
}

export function AutomationsScreen(): JSX.Element {
  const [version, setVersion] = createSignal(0)
  const [creating, setCreating] = createSignal(false)
  const [page] = createResource(version, () => cmd<AutomationList>("automation.list", {}))
  const automations = createMemo(() => page()?.automations ?? [])

  const reload = (): void => {
    setVersion((value) => value + 1)
  }

  return (
    <>
      <TopBar
        title="Automations"
        subtitle="Tasks the agent runs on a schedule or a webhook"
        actions={<TopButton icon={<Icon name="plus" size={14} />} label="New automation" onClick={() => setCreating(true)} />}
      />
      <div class="min-h-0 flex-1 overflow-y-auto px-10 pb-12 pt-7">
        <Loading when={firstLoad(page)} skeleton={<RowSkeleton rows={3} />} label="Loading automations">
          <Show
            when={automations().length > 0}
            fallback={
              <EmptyState
                pictogram="schedules"
                title="No automations yet"
                detail="Ask the agent to automate something in a project, or create one here."
              />
            }
          >
            <AutomationRows items={automations()} onChanged={reload} />
          </Show>
        </Loading>
      </div>
      <CreateAutomation open={creating()} onClose={() => setCreating(false)} onCreated={reload} />
    </>
  )
}

function AutomationRows(props: { items: readonly Automation[]; onChanged?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex flex-col overflow-hidden rounded-md border border-line-1">
      <For each={props.items}>{(item) => <AutomationRow item={item} onChanged={props.onChanged} />}</For>
    </div>
  )
}

function AutomationRow(props: { item: Automation; onChanged?: (() => void) | undefined }): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const send = async (op: string, args: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await cmd(op, { id: props.item.id, ...args })
      props.onChanged?.()
    } catch (problem) {
      setError(problem instanceof OpError ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex items-center gap-3 border-b border-line-1 bg-card px-3.5 py-3 last:border-0">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-line-2 bg-panel text-ink-2">
        <Icon name="clock" size={16} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <span class="truncate text-base font-medium">{props.item.title}</span>
          <Show when={!props.item.enabled}>
            <span class="label text-working">Paused</span>
          </Show>
        </span>
        <span class="mt-0.5 block truncate text-sm text-ink-3">
          {describeTriggers(props.item)} · {TARGET_WORD[props.item.target]} · next {nextRun(props.item.nextAt)}
        </span>
        <Show when={error() !== undefined}>
          <span class="mt-0.5 block text-sm text-failed">{error()}</span>
        </Show>
      </span>
      <span class="mono-meta shrink-0">{ago(Date.parse(props.item.updatedAt))}</span>
      <button
        type="button"
        disabled={busy()}
        onClick={() => void send("automation.update", { enabled: !props.item.enabled })}
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-2 px-2.5 text-sm text-ink-2 hover:border-line-3 hover:text-ink disabled:opacity-50"
      >
        <MorphIcon kind="pause" on={!props.item.enabled} size={13} />
        {props.item.enabled ? "Pause" : "Resume"}
      </button>
      <button
        type="button"
        disabled={busy()}
        onClick={() => void send("automation.delete", {})}
        class="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-ink-3 hover:bg-secondary hover:text-ink disabled:opacity-50"
        aria-label={`Delete ${props.item.title}`}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  )
}
