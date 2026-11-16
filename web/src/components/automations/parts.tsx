import { createEffect, createSignal, Show, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Menu } from "@ark-ui/solid/menu"
import { Ellipsis, Pause, Play, Trash2 } from "lucide-solid"
import { runSignal, type Automation } from "../../lib/automations.ts"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { STATE_WORD } from "../../lib/status.ts"
import { deleteAutomation, setAutomationEnabled } from "../../state/automations.ts"
import { homeProjects } from "../../state/home.ts"
import { ICON_BUTTON, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from "../shell/menu.ts"
import { Toggle } from "../extensions/chrome.tsx"
import { Dialog } from "../ui/dialog.tsx"
import { Signal } from "../ui/signal.tsx"

const ICON = { size: 16, "stroke-width": 1.5 } as const

function failureText(problem: unknown): string {
  return problem instanceof Error ? problem.message : "That did not go through"
}

/**
 * Row actions for one list. An action's answer holds the row's new state until the revision-driven reload
 * brings the same list back, so a toggle never flips back for the length of a round trip.
 */
export function createAutomationActions(list: Accessor<readonly Automation[] | undefined>): {
  readonly busy: Accessor<string | undefined>
  readonly failed: Accessor<string | undefined>
  readonly enabled: (automation: Automation) => boolean
  readonly removed: (automation: Automation) => boolean
  readonly toggle: (automation: Automation) => Promise<void>
  readonly remove: (automation: Automation) => Promise<boolean>
} {
  const [busy, setBusy] = createSignal<string>()
  const [failed, setFailed] = createSignal<string>()
  const [enabledNow, setEnabledNow] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set())

  createEffect(() => {
    list()
    setEnabledNow(new Map<string, boolean>())
    setGone(new Set<string>())
  })

  const run = async (id: string, work: () => Promise<void>): Promise<boolean> => {
    setBusy(id)
    setFailed(undefined)
    try {
      await work()
      return true
    } catch (problem) {
      setFailed(failureText(problem))
      return false
    } finally {
      setBusy(undefined)
    }
  }

  const enabled = (automation: Automation): boolean => enabledNow().get(automation.id) ?? automation.enabled
  return {
    busy,
    failed,
    enabled,
    removed: (automation) => gone().has(automation.id),
    toggle: async (automation) => {
      const next = !enabled(automation)
      await run(automation.id, async () => {
        await setAutomationEnabled(automation.id, next)
        setEnabledNow((map) => new Map(map).set(automation.id, next))
      })
    },
    remove: (automation) =>
      run(automation.id, async () => {
        await deleteAutomation(automation.id)
        setGone((set) => new Set(set).add(automation.id))
      }),
  }
}

export function EnabledToggle(props: { automation: Automation; on: boolean; busy: boolean; onToggle: () => void }): JSX.Element {
  return (
    <Toggle
      on={props.on}
      label={props.on ? `Pause ${props.automation.title}` : `Resume ${props.automation.title}`}
      disabled={props.busy}
      onChange={props.onToggle}
    />
  )
}

/** The last run as a Signal; it opens the run's thread when the run has one. */
export function LastRun(props: { automation: Automation; withAge?: boolean }): JSX.Element {
  const slug = (): string | undefined => homeProjects().find((project) => project.id === props.automation.project)?.slug
  return (
    <Show when={props.automation.lastRun} fallback={<span class="text-sm text-icon">Never ran</span>}>
      {(run) => {
        const label = (): string => `Last run ${STATE_WORD[runSignal(run().status)].toLowerCase()}, ${new Date(run().createdAt).toLocaleString()}`
        const thread = (): string | undefined => {
          const id = run().threadId
          const project = slug()
          return id === null || project === undefined ? undefined : `/p/${project}/run/${id}`
        }
        return (
          <button
            type="button"
            title={label()}
            aria-label={label()}
            disabled={thread() === undefined}
            onClick={() => {
              const to = thread()
              if (to !== undefined) navigate(to)
            }}
            class="im-press -mx-1 flex h-6 items-center gap-1.5 rounded-sm px-1 text-sm text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink"
          >
            <Signal state={runSignal(run().status)} size={14} />
            <Show when={props.withAge !== false}>
              <span class="font-mono text-xs tabular-nums">{ago(Date.parse(run().createdAt))}</span>
            </Show>
          </button>
        )
      }}
    </Show>
  )
}

export type RowAction = "toggle" | "delete"

export function RowMenu(props: { automation: Automation; enabled: boolean; busy: boolean; onAction: (action: RowAction) => void }): JSX.Element {
  return (
    <Menu.Root
      positioning={{ placement: "bottom-end", gutter: 4 }}
      lazyMount
      unmountOnExit
      onSelect={(details) => {
        if (details.value === "toggle" || details.value === "delete") props.onAction(details.value)
      }}
    >
      <Menu.Trigger class={ICON_BUTTON} aria-label={`${props.automation.title} actions`} disabled={props.busy}>
        <Ellipsis {...ICON} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={MENU_CONTENT}>
            <Menu.Item value="toggle" class={MENU_ITEM}>
              <span class="text-ink-3">{props.enabled ? <Pause {...ICON} /> : <Play {...ICON} />}</span>
              {props.enabled ? "Pause" : "Resume"}
            </Menu.Item>
            <Menu.Separator class={MENU_SEPARATOR} />
            <Menu.Item value="delete" class={`${MENU_ITEM} data-[highlighted]:text-failed`}>
              <span class="text-ink-3">
                <Trash2 {...ICON} />
              </span>
              Delete…
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

/** Delete asks first: it takes the triggers, open batches and run history with it, and the threads it started stay. */
export function DeleteAutomationDialog(props: {
  automation: Automation | undefined
  onClose: () => void
  onDelete: (automation: Automation) => Promise<boolean>
  focusAfter: (automation: Automation) => HTMLElement | undefined
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [kept, setKept] = createSignal<Automation>()
  const [returnFocus, setReturnFocus] = createSignal<HTMLElement>()
  createEffect(() => {
    if (props.automation === undefined) return
    setKept(props.automation)
    setReturnFocus(undefined)
  })
  const confirm = async (): Promise<void> => {
    const target = props.automation
    if (target === undefined || busy()) return
    setBusy(true)
    const next = props.focusAfter(target)
    const done = await props.onDelete(target)
    setBusy(false)
    if (!done) return
    setReturnFocus(next)
    props.onClose()
  }
  return (
    <Dialog
      open={props.automation !== undefined}
      onClose={props.onClose}
      title="Delete automation"
      width="w-[440px]"
      busy={busy()}
      returnFocus={returnFocus()}
      onSubmit={() => void confirm()}
      footer={
        <>
          <span class="mr-auto" />
          <button
            type="button"
            autofocus
            disabled={busy()}
            onClick={props.onClose}
            class="im-press h-8 rounded-sm px-3 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Keep
          </button>
          <button
            type="submit"
            disabled={busy()}
            class="im-press h-8 rounded-sm border border-failed/40 bg-failed-soft px-3 text-sm font-medium text-failed hover:border-failed disabled:opacity-50"
          >
            {busy() ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p class="text-base text-ink-2">
        Delete <span class="font-medium text-ink">{kept()?.title}</span>? Its triggers, open batches and run history go with it. Threads it
        already started stay.
      </p>
    </Dialog>
  )
}
