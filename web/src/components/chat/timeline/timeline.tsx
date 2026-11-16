import { ArrowDown } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { count } from "../../../lib/format.ts"
import { OwnerBubble } from "../entries.tsx"
import { Markdown } from "../markdown.tsx"
import { DateDivider, plainLink, TurnSummary, WaitingLine, type RenderLink } from "./dividers.tsx"
import { reuseItems, type PassItem, type TimelineItem, type ToolCall, type WaitTarget } from "./model.ts"
import { ToolGroup } from "./tool-group.tsx"

const PINNED_WITHIN = 32
const MESSAGE_KINDS: ReadonlySet<TimelineItem["kind"]> = new Set(["owner", "pass", "text"])

type Kind = TimelineItem["kind"]
type ItemOf<K extends Kind> = Extract<TimelineItem, { readonly kind: K }>

function follow<K extends Kind>(item: () => TimelineItem | undefined, first: ItemOf<K>): () => ItemOf<K> {
  const same = (candidate: TimelineItem | undefined): candidate is ItemOf<K> => candidate?.kind === first.kind
  return createMemo(() => {
    const now = item()
    return same(now) ? now : first
  })
}

function ItemView(props: {
  item: () => TimelineItem | undefined
  open: (key: string, live: boolean) => boolean
  onOpenChange: (key: string, open: boolean) => void
  renderPass: (item: PassItem) => JSX.Element
  renderTool: (call: ToolCall) => JSX.Element
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
      return <div data-block={item().call.callId}>{props.renderTool(item().call)}</div>
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
  renderTool: (call: ToolCall) => JSX.Element
  renderLink?: RenderLink | undefined
  header?: JSX.Element
  footer?: JSX.Element
  hasOlder?: boolean | undefined
  onLoadOlder?: (() => Promise<void>) | undefined
}): JSX.Element {
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [choice, setChoice] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [pinned, setPinned] = createSignal(true)
  const [seen, setSeen] = createSignal<{ readonly keys: ReadonlySet<string>; readonly revision: number }>()

  const items = createMemo<readonly TimelineItem[]>((previous) => reuseItems(previous, props.items), [])
  const byKey = createMemo(() => new Map(items().map((item) => [item.key, item])))
  const keys = createMemo(() => items().map((item) => item.key), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  })
  const owners = createMemo(() => items().filter((item) => item.kind === "owner").length)
  const revision = createMemo(() =>
    items().reduce(
      (total, item) => total + 1 + (item.kind === "text" ? item.text.length : item.kind === "tools" ? item.calls.length : 0),
      0,
    ),
  )

  createEffect(
    on(owners, (now, before) => {
      if (before === undefined || now <= before) return
      const groups = untrack(() => items().flatMap((item) => (item.kind === "tools" ? [item.key] : [])))
      setChoice(new Map(groups.map((key) => [key, false])))
    }),
  )

  const fresh = createMemo(() => {
    const since = seen()
    if (since === undefined || pinned()) return undefined
    const added = items().filter((item) => !since.keys.has(item.key))
    if (added.length === 0 && revision() === since.revision) return undefined
    return { messages: added.filter((item) => MESSAGE_KINDS.has(item.kind)).length }
  })

  const atEnd = (): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_WITHIN
  let lastTop = 0
  let anchor: { readonly element: Element; readonly offset: number } | undefined
  const offsetOf = (element: Element): number => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const markAnchor = (): void => {
    const top = scroller.getBoundingClientRect().top
    const element = [...content.querySelectorAll(":scope > [data-item]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > top,
    )
    anchor = element === undefined ? undefined : { element, offset: offsetOf(element) }
  }
  const holdAnchor = (): void => {
    if (anchor === undefined || !anchor.element.isConnected) return markAnchor()
    const shift = offsetOf(anchor.element) - anchor.offset
    if (Math.abs(shift) >= 0.5) {
      scroller.scrollTop = Math.round(scroller.scrollTop + shift)
      lastTop = scroller.scrollTop
    }
    markAnchor()
  }
  const settle = (): void => {
    markAnchor()
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

  const loadOlder = async (): Promise<void> => {
    const load = props.onLoadOlder
    if (load === undefined || loadingOlder()) return
    setLoadingOlder(true)
    const fromEnd = scroller.scrollHeight - scroller.scrollTop
    try {
      await load()
      requestAnimationFrame(() => {
        scroller.scrollTop = Math.round(scroller.scrollHeight - fromEnd)
        lastTop = scroller.scrollTop
        markAnchor()
      })
    } finally {
      setLoadingOlder(false)
    }
  }

  onMount(() => {
    toEnd()
    const observer = new ResizeObserver(() => {
      if (pinned()) toEnd()
      else holdAnchor()
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
        class="min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none]"
      >
        <div ref={content} class="mx-auto flex w-full max-w-[var(--w-column)] flex-col gap-4 px-6 pb-6 pt-7 text-reading">
          <Show when={props.hasOlder === true}>
            <div class="flex justify-center pb-1">
              <button
                type="button"
                data-load-older=""
                disabled={loadingOlder()}
                onClick={() => void loadOlder()}
                class="im-press im-hover im-focus h-[var(--h-control-sm)] rounded-sm px-2.5 text-small text-ink-2 shadow-[var(--shadow-ring)] outline-none hover:bg-hover disabled:text-icon"
              >
                {loadingOlder() ? "Loading" : "Load older messages"}
              </button>
            </div>
          </Show>
          {props.header}
          <For each={keys()}>
            {(key) => (
              <div data-item={key} class="min-w-0">
                <ItemView
                  item={() => byKey().get(key)}
                  open={(group, live) => choice().get(group) ?? live}
                  onOpenChange={(group, open) => setChoice((current) => new Map(current).set(group, open))}
                  renderPass={props.renderPass}
                  renderTool={props.renderTool}
                  renderLink={props.renderLink ?? plainLink}
                />
              </div>
            )}
          </For>
          {props.footer}
          <Show when={props.waiting}>
            {(target) => <WaitingLine target={target()} renderLink={props.renderLink ?? plainLink} />}
          </Show>
        </div>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <p role="status" aria-live="polite" data-jump-status="" class="sr-only">
          {(fresh()?.messages ?? 0) > 0 ? count(fresh()?.messages ?? 0, "new message") : ""}
        </p>
        <Show when={fresh()}>{(news) => <JumpPill messages={news().messages} onJump={jump} />}</Show>
      </div>
    </div>
  )
}
