import "@ui-sdk/web/popover"
import "@ui-sdk/web/radio"
import "@ui-sdk/web/select"
import { createSignal, For, Show, type JSX } from "solid-js"
import { Check, ChevronDown, X } from "lucide-solid"
import { createCommandIds, newIssueArgs, PRIORITIES, PRIORITY_LABEL, stateTone, type Priority } from "../../lib/issues.ts"
import { createIssue } from "../../state/issues.ts"
import { createPaneAction } from "../chat/ui.tsx"
import { Button } from "../ui/button.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM } from "../ui/surface.ts"
import { PriorityMark, StateMark } from "./issue-marks.tsx"
import { mintCommandId, provideNewIssuePopover, type NewIssueProps } from "./issues.tsx"

const SEGMENT =
  "im-press im-hover flex h-7 cursor-default items-center gap-1.5 rounded-sm border border-line-1 px-2 text-xs text-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-primary-soft data-[checked]:border-line-3 data-[checked]:bg-hover data-[checked]:text-ink"

const FIELD_LABEL = "text-mini font-title text-ink-3"

const radioValue = (event: Event): string | undefined =>
  (event.target instanceof Element ? event.target.closest("ui-radio")?.getAttribute("value") : undefined) ?? undefined

/** Title first; priority and state are optional and fall back to the contract's defaults (Normal, the default open state). */
export function NewIssuePopover(props: NewIssueProps & { id: string }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const content = createOverlayMount(open)
  let popover: (HTMLElement & { open: boolean }) | undefined
  const [title, setTitle] = createSignal("")
  const [priority, setPriority] = createSignal<Priority>()
  let pressedFrom: Priority | undefined
  const [state, setState] = createSignal<string>()
  const action = createPaneAction()
  const openStates = () => props.states.filter((entry) => !entry.closed)
  const args = () =>
    newIssueArgs({
      title: title(),
      project: props.projectId,
      priority: priority(),
      state: state(),
    })
  const reset = (): void => {
    setTitle("")
    setPriority(undefined)
    setState(undefined)
  }
  const ids = createCommandIds(mintCommandId)
  const submit = (): void => {
    const body = args()
    if (body === undefined || action.busy() !== undefined) return
    void action.run("create", async () => {
      try {
        await createIssue(body, ids.idFor(body))
      } catch (problem) {
        ids.settle(problem)
        throw problem
      }
      ids.settle(undefined)
      reset()
      if (popover !== undefined) popover.open = false
    })
  }

  return (
    <ui-popover
      id={props.id}
      ref={popover}
      on:openchange={(event) => setOpen(event.detail.value)}
      on:openchangecomplete={content.settle}
    >
      <ui-popover-content side="bottom" align="end" side-offset="6" class={`${POPUP} w-[320px] p-0`}>
        <Show when={content.mounted()}>
          <ui-popover-title class="sr-only">New issue</ui-popover-title>
          <form
            class="flex flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <div class="border-b border-line-1 px-3 pb-2 pt-2.5">
              <span class="text-mini text-ink-3">New issue in {props.project.name}</span>
              <input
                autofocus
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                placeholder="Issue title"
                aria-label="Issue title"
                maxLength={300}
                class="mt-1 h-6 w-full bg-transparent text-body font-title text-ink outline-none placeholder:font-normal placeholder:text-placeholder"
              />
            </div>
            <div class="flex flex-col gap-2 px-3 py-2.5">
              <span id="new-issue-priority" class={FIELD_LABEL}>
                Priority
              </span>
              <ui-radio-group
                aria-labelledby="new-issue-priority"
                prop:value={priority() ?? null}
                on:valuechange={(event) => {
                  const level = PRIORITIES.find((entry) => entry === event.detail.value)
                  if (level !== undefined) setPriority(level)
                }}
                oncapture:click={() => {
                  pressedFrom = priority()
                }}
                on:click={(event) => {
                  if (radioValue(event) === pressedFrom) setPriority(undefined)
                }}
                oncapture:keyup={(event: KeyboardEvent) => {
                  if (event.key !== " " || radioValue(event) !== priority()) return
                  event.preventDefault()
                  event.stopPropagation()
                  setPriority(undefined)
                }}
                class="flex flex-wrap gap-1"
              >
                <For each={PRIORITIES}>
                  {(level) => (
                    <ui-radio value={level} class={SEGMENT}>
                      <PriorityMark priority={level} decorative />
                      {PRIORITY_LABEL[level]}
                    </ui-radio>
                  )}
                </For>
              </ui-radio-group>
              <Show when={openStates().length > 0}>
                <ui-select
                  class="flex flex-col gap-2 pt-1"
                  placeholder="Default"
                  prop:value={state() ?? null}
                  on:valuechange={(event) => {
                    const value = event.detail.value
                    setState(typeof value === "string" ? value : undefined)
                  }}
                >
                  <ui-select-label class={FIELD_LABEL}>State</ui-select-label>
                  <div class="flex items-center gap-1">
                    <ui-select-trigger class="block min-w-0 flex-1">
                      <button
                        type="button"
                        class="im-hover flex h-7 w-full items-center gap-2 rounded-sm border border-line-1 px-2 text-left text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-soft aria-expanded:bg-hover"
                      >
                        <Show when={openStates().find((entry) => entry.id === state())}>
                          {(chosen) => <StateMark tone={stateTone(chosen())} />}
                        </Show>
                        <ui-select-value class="min-w-0 flex-1 truncate data-[placeholder]:text-ink-3" />
                        <ChevronDown size={12} stroke-width={1.5} class="shrink-0 text-icon" />
                      </button>
                    </ui-select-trigger>
                    <ui-select-clear>
                      <button type="button" class={ICON_BUTTON} aria-label="Use the default state" title="Use the default state">
                        <X size={14} stroke-width={1.5} />
                      </button>
                    </ui-select-clear>
                  </div>
                  <ui-select-content side-offset="4" class={`${POPUP} w-[var(--anchor-width)]`}>
                    <For each={openStates()}>
                      {(entry) => (
                        <ui-select-item value={entry.id} label={entry.name} class={POPUP_ITEM}>
                          <StateMark tone={stateTone(entry)} />
                          <ui-select-item-text class="min-w-0 flex-1 truncate">{entry.name}</ui-select-item-text>
                          <ui-select-item-indicator class="text-ink-2">
                            <Check size={14} stroke-width={1.5} />
                          </ui-select-item-indicator>
                        </ui-select-item>
                      )}
                    </For>
                  </ui-select-content>
                </ui-select>
              </Show>
            </div>
            <div class="flex items-center gap-2 border-t border-line-1 px-3 py-2">
              <span class="min-w-0 flex-1 truncate text-xs text-failed">{action.failed()}</span>
              <Button type="submit" variant="primary" size="sm" disabled={args() === undefined || action.busy() !== undefined}>
                {action.busy() === undefined ? "Create" : "Creating"}
              </Button>
            </div>
          </form>
        </Show>
      </ui-popover-content>
    </ui-popover>
  )
}

provideNewIssuePopover(NewIssuePopover)
