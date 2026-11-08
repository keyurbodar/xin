import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { TopBar, TopButton } from "../components/shell/topbar.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { ago, describeRule } from "../lib/format.ts"
import { Skullet } from "../components/ui/skeleton.tsx"
import { CreateSchedule } from "../components/schedules/create.tsx"
import { EmptyState } from "../components/chat/ui.tsx"

type Target = "this_session" | "new_once" | "new"

type Schedule = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly rrule?: string
  readonly at?: string
  readonly target: Target
  readonly active: boolean
  readonly nextAt: string | null
  readonly updatedAt: string
}

type Page = { readonly schedules: readonly Schedule[] }

const TARGET_WORD: Readonly<Record<Target, string>> = {
  this_session: "This session",
  new_once: "New thread, once",
  new: "New thread each time",
}

function when(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
}

export function SchedulesScreen(): JSX.Element {
  const [version, setVersion] = createSignal(0)
  const [creating, setCreating] = createSignal(false)
  const [page] = createResource(version, () => cmd<Page>("schedule.list", { limit: 100 }))
  const schedules = createMemo(() => page()?.schedules ?? [])

  const reload = (): void => {
    setVersion((value) => value + 1)
  }

  return (
    <>
      <TopBar
        title="Schedules"
        subtitle="Tasks the agent runs on a clock"
        actions={<TopButton icon={<Icon name="plus" size={14} />} label="New schedule" onClick={() => setCreating(true)} />}
      />
      <div class="min-h-0 flex-1 overflow-y-auto px-10 pb-12 pt-7">
        <Skullet loading={page.loading} sample={() => <ScheduleRows items={[]} />} label="Loading schedules">
          <Show
            when={schedules().length > 0}
            fallback={
              <EmptyState
                pictogram="schedules"
                title="No schedules yet"
                detail="Ask the agent to schedule something in a project, or create one here. Delivery targets the conversation that created it."
              />
            }
          >
            <ScheduleRows items={schedules()} onChanged={reload} />
          </Show>
        </Skullet>
      </div>
      <CreateSchedule open={creating()} onClose={() => setCreating(false)} onCreated={reload} />
    </>
  )
}

function ScheduleRows(props: { items: readonly Schedule[]; onChanged?: (() => void) | undefined }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.items}>{(item) => <ScheduleRow item={item} onChanged={props.onChanged} />}</For>
    </div>
  )
}

function ScheduleRow(props: { item: Schedule; onChanged?: (() => void) | undefined }): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const edit = async (args: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await cmd("schedule.edit", { id: props.item.id, expectedUpdatedAt: props.item.updatedAt, ...args })
      props.onChanged?.()
    } catch (problem) {
      setError(problem instanceof OpError ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-3.5 py-3 hover:bg-hover">
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        classList={{ "bg-ok": props.item.active, "bg-warn": !props.item.active }}
      />
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2">
          <span class="truncate text-[13.5px] font-medium">{props.item.title}</span>
          <Show when={!props.item.active}>
            <span class="label text-warn">Paused</span>
          </Show>
        </span>
        <span class="mt-0.5 block truncate text-[11.5px] text-fg-3">
          {props.item.rrule === undefined ? when(props.item.at) : describeRule(props.item.rrule)} ·{" "}
          {TARGET_WORD[props.item.target]} · next {when(props.item.nextAt)}
        </span>
        <Show when={error() !== undefined}>
          <span class="mt-0.5 block text-[11.5px] text-bad">{error()}</span>
        </Show>
      </span>
      <span class="mono-meta shrink-0">{ago(Date.parse(props.item.updatedAt))}</span>
      <button
        type="button"
        disabled={busy()}
        onClick={() => void edit({ action: "update", active: !props.item.active })}
        class="h-8 shrink-0 rounded-[8px] border border-line-inner bg-fill px-2.5 text-[12.5px] text-fg-2 hover:bg-selected hover:text-fg disabled:opacity-50"
      >
        {props.item.active ? "Pause" : "Resume"}
      </button>
      <button
        type="button"
        disabled={busy()}
        onClick={() => void edit({ action: "delete" })}
        class="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-fg-3 hover:bg-fill-strong hover:text-fg disabled:opacity-50"
        aria-label={`Delete ${props.item.title}`}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  )
}
