import "@ui-sdk/web/collapsible"
import { Check, ChevronRight, X } from "lucide-solid"
import { createSignal, Index, Match, Show, Switch, type JSX } from "solid-js"
import { createOverlayMount } from "../../shell/presence.ts"
import { Signal } from "../../ui/signal.tsx"
import { groupStatus, groupSummary, stepTarget, type ToolCall, type ToolStatus } from "./model.ts"

const ICON = { size: 14, "stroke-width": 1.75 } as const

const TRIGGER =
  "im-hover im-focus -mx-1.5 flex h-7 min-w-0 max-w-full items-center gap-2 rounded-sm px-1.5 text-left outline-none hover:bg-hover"

function StatusMark(props: { status: ToolStatus; size: 12 | 14 }): JSX.Element {
  return (
    <span class="flex shrink-0 items-center justify-center" style={{ width: `${props.size}px`, height: `${props.size}px` }}>
      <Switch>
        <Match when={props.status === "running" || props.status === "streaming"}>
          <Signal state="working" size={props.size} />
        </Match>
        <Match when={props.status === "error"}>
          <X {...ICON} size={props.size} class="text-failed" aria-label="Failed" role="img" />
        </Match>
        <Match when={props.status === "done"}>
          <Check {...ICON} size={props.size} class="text-ink-3" aria-label="Done" role="img" />
        </Match>
      </Switch>
    </span>
  )
}

function Chevron(props: { open: boolean }): JSX.Element {
  return (
    <span class="im-chevron flex shrink-0 text-icon" data-open={props.open ? "" : undefined} aria-hidden="true">
      <ChevronRight {...ICON} size={12} />
    </span>
  )
}

function Detail(props: { label: string; text: string }): JSX.Element {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <span class="text-micro font-title text-ink-3">{props.label}</span>
      <pre class="max-h-60 overflow-auto whitespace-pre-wrap rounded-sm bg-secondary px-2.5 py-2 font-mono text-mini text-ink-2 [overflow-wrap:anywhere]">
        {props.text}
      </pre>
    </div>
  )
}

function ToolStep(props: { call: ToolCall }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const overlay = createOverlayMount(open)
  const args = (): string => JSON.stringify(props.call.args, null, 2)
  return (
    <ui-collapsible
      class="im-event block"
      attr:data-step={props.call.callId}
      attr:data-status={props.call.status}
      on:openchange={(event) => setOpen(event.detail.value)}
      on:openchangecomplete={overlay.settle}
    >
      <ui-collapsible-trigger>
        <button type="button" class={`${TRIGGER} w-full`}>
          <Chevron open={open()} />
          <span class="shrink-0 font-mono text-mini text-ink-2">{props.call.name}</span>
          <span class="min-w-0 flex-1 truncate text-small text-ink-3">{stepTarget(props.call)}</span>
          <Show when={props.call.status !== "done"}>
            <StatusMark status={props.call.status} size={12} />
          </Show>
        </button>
      </ui-collapsible-trigger>
      <ui-collapsible-panel class="im-grow">
        <div>
          <div class="flex flex-col gap-2 pb-2 pl-5 pt-1">
            <Show when={overlay.mounted()}>
              <Detail label="Arguments" text={args()} />
              <Show when={props.call.output}>{(output) => <Detail label="Output" text={output()} />}</Show>
            </Show>
          </div>
        </div>
      </ui-collapsible-panel>
    </ui-collapsible>
  )
}

export function ToolGroup(props: {
  calls: readonly ToolCall[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const status = (): ToolStatus => groupStatus(props.calls)
  return (
    <ui-collapsible
      class="block"
      data-tool-group=""
      attr:data-status={status()}
      prop:open={props.open}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        queueMicrotask(() => props.onOpenChange(next))
      }}
    >
      <ui-collapsible-trigger>
        <button type="button" class={TRIGGER}>
          <StatusMark status={status()} size={14} />
          <span class="truncate text-small text-ink-3" classList={{ "im-shimmer": status() === "running" }}>
            {groupSummary(props.calls)}
          </span>
          <Chevron open={props.open} />
        </button>
      </ui-collapsible-trigger>
      <ui-collapsible-panel class="im-grow">
        <div>
          <div class="ml-[6.5px] mt-1 flex flex-col border-l border-line-2 pl-3">
            <Index each={props.calls}>{(call) => <ToolStep call={call()} />}</Index>
          </div>
        </div>
      </ui-collapsible-panel>
    </ui-collapsible>
  )
}
