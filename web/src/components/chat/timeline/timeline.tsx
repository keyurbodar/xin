import { ArrowDown } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { count } from "../../../lib/format.ts"
import { OwnerBubble } from "../entries.tsx"
import { Markdown, renderBlock } from "./blocks-port.ts"
import { DateDivider, plainLink, TurnSummary, WaitingLine, type RenderLink } from "./dividers.tsx"
import type { PassItem, TimelineItem, WaitTarget } from "./model.ts"
import { ToolGroup } from "./tool-group.tsx"

const PINNED_WITHIN = 32
const MESSAGE_KINDS: ReadonlySet<TimelineItem["kind"]> = new Set(["owner", "pass", "text"])

type Kind = TimelineItem["kind"]
type ItemOf<K extends Kind> = Extract<TimelineItem, { readonly kind: K }>

function follow<K extends Kind>(item: () => TimelineItem | undefined, first: ItemOf<K>): () => ItemOf<K> {
  const same = (candidate: TimelineItem | undefined): candidate is ItemOf<K> => candidate?.kind === first.kind
  return () => {
    const now = item()
    return same(now) ? now : first
  }
}

function ItemView(props: {
  item: () => TimelineItem | undefined
  open: (key: string, live: boolean) => boolean
  onOpenChange: (key: string, open: boolean) => void
  renderPass: (item: PassItem) => JSX.Element
  renderLink: RenderLink
}): JSX.Element {
  const first = untrack(props.item)
  if (first === undefined) return undefined
  switch (first.kind) {
    case "date": {
      const item = follow(props.item, first)
      return <DateDivider label={item().label} />
    }
    case "owner": {
      const item = follow(props.item, first)
      return <OwnerBubble text={item().text} attachments={item().attachments} density="chat" />
    }
    case "pass": {
      const item = follow(props.item, first)
      return <>{props.renderPass(item().item)}</>
    }
    case "text": {
      const item = follow(props.item, first)
      return (
        <div class="flex min-w-0 items-start gap-1" data-text={item().key}>
          <div class="min-w-0 flex-1">
            <Markdown text={item().text} streaming={item().streaming} />
          </div>
          <Show when={item().streaming}>
            <span class="im-caret mt-1.5 shrink-0" aria-hidden="true" />
          </Show>
        </div>
      )
    }
    case "tools": {
      const item = follow(props.item, first)
      return (
        <ToolGroup
          calls={item().calls}
          open={props.open(item().key, item().live)}
          onOpenChange={(open) => props.onOpenChange(item().key, open)}
        />
      )
    }
    case "block": {
      const item = follow(props.item, first)
      const block = (): JSX.Element => {
        const { name, callId, args, output, status } = item().call
        return renderBlock("tool", { name, callId, args: { ...args }, ...(output === undefined ? {} : { output }), status })
      }
      return <div data-block={item().call.callId}>{block()}</div>
    }
    case "summary": {
      const item = follow(props.item, first)
      return <TurnSummary phrase={item().phrase} renderLink={props.renderLink} />
    }
    default: {
      const _exhaustive: never = first
      return _exhaustive
    }
  }
}

function JumpPill(props: { messages: number; onJump: () => void }): JSX.Element {
  const label = (): string => (props.messages === 0 ? "Jump to latest" : count(props.messages, "message"))
  return (
    <button
      type="button"
      data-jump=""
      aria-label={props.messages === 0 ? "Jump to latest" : `Jump to latest, ${count(props.messages, "new message")}`}
      onClick={() => props.onJump()}
      class="im-event im-press im-hover im-focus pointer-events-auto flex h-[var(--h-control-sm)] items-center gap-1.5 rounded-full bg-popover px-3 text-small text-ink-2 shadow-[var(--shadow-popover)] outline-none hover:text-ink"
    >
      <ArrowDown size={14} stroke-width={1.75} aria-hidden="true" />
      <span>{label()}</span>
    </button>
  )
}

export function Timeline(props: {
  items: readonly TimelineItem[]
  waiting?: WaitTarget | undefined
  renderPass: (item: PassItem) => JSX.Element
  renderLink?: RenderLink | undefined
}): JSX.Element {
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  const [choice, setChoice] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [pinned, setPinned] = createSignal(true)
  const [seen, setSeen] = createSignal<{ readonly keys: ReadonlySet<string>; readonly revision: number }>()

  const byKey = createMemo(() => new Map(props.items.map((item) => [item.key, item])))
  const keys = createMemo(() => props.items.map((item) => item.key), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  })
  const liveGroups = createMemo(() => props.items.flatMap((item) => (item.kind === "tools" && item.live ? [item.key] : [])))
  const owners = createMemo(() => props.items.filter((item) => item.kind === "owner").length)
  const revision = createMemo(() =>
    props.items.reduce(
      (total, item) => total + 1 + (item.kind === "text" ? item.text.length : item.kind === "tools" ? item.calls.length : 0),
      0,
    ),
  )

  createEffect(
    on(liveGroups, (now, before) => {
      if (before !== undefined && before.some((key) => !now.includes(key))) setChoice(new Map())
    }),
  )
  createEffect(
    on(owners, (now, before) => {
      if (before === undefined || now <= before) return
      const groups = untrack(() => props.items.flatMap((item) => (item.kind === "tools" ? [item.key] : [])))
      setChoice(new Map(groups.map((key) => [key, false])))
    }),
  )

  const fresh = createMemo(() => {
    const since = seen()
    if (since === undefined || pinned()) return undefined
    const added = props.items.filter((item) => !since.keys.has(item.key))
    if (added.length === 0 && revision() === since.revision) return undefined
    return { messages: added.filter((item) => MESSAGE_KINDS.has(item.kind)).length }
  })

  const atEnd = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_WITHIN
  let lastTop = 0
  const settle = (): void => {
    const top = scroller.scrollTop
    const now = atEnd() || (pinned() && top >= lastTop)
    lastTop = top
    if (now === pinned()) return
    setPinned(now)
    setSeen(now ? undefined : { keys: new Set(keys()), revision: revision() })
  }
  const toEnd = (): void => {
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
  }
  const jump = (): void => {
    toEnd()
    setPinned(true)
    setSeen(undefined)
    scroller.focus({ preventScroll: true })
  }

  onMount(() => {
    toEnd()
    const observer = new ResizeObserver(() => {
      if (pinned()) toEnd()
    })
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        tabindex="-1"
        data-timeline=""
        onScroll={settle}
        class="min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:auto]"
      >
        <div ref={content} class="mx-auto flex w-full max-w-[var(--w-column)] flex-col gap-4 px-6 pb-6 pt-7 text-reading">
          <For each={keys()}>
            {(key) => (
              <ItemView
                item={() => byKey().get(key)}
                open={(group, live) => choice().get(group) ?? live}
                onOpenChange={(group, open) => setChoice((current) => new Map(current).set(group, open))}
                renderPass={props.renderPass}
                renderLink={props.renderLink ?? plainLink}
              />
            )}
          </For>
          <Show when={props.waiting}>
            {(target) => <WaitingLine target={target()} renderLink={props.renderLink ?? plainLink} />}
          </Show>
        </div>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <Show when={fresh()}>{(news) => <JumpPill messages={news().messages} onJump={jump} />}</Show>
      </div>
    </div>
  )
}
