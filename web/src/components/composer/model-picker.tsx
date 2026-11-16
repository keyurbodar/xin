import { ariaKeyshortcuts, formatShortcut } from "@ui-sdk/core"
import { Check, ChevronDown, Star } from "lucide-solid"
import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js"
import { isFavorite, missingFavorites, toggleFavorite, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { POPUP, POPUP_ITEM, POPUP_LABEL } from "../ui/surface.ts"
import { loadOnIntent } from "../../lib/ui-sdk-lazy.ts"
import { TOOL } from "./styles.ts"

const FAVORITES = "favorites"

const FAVORITE_SHORTCUT = "mod+d"

type Entry = { readonly value: string; readonly model: ModelInfo }

const refKey = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`

function providerLabel(provider: string): string {
  return provider
    .split(/[-_]/u)
    .map((word) => (word === "" ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`))
    .join(" ")
}

function providerInitials(provider: string): string {
  const words = provider.split(/[-_\s]/u).filter((word) => word !== "")
  const [first = "", second = ""] = words
  if (second !== "") return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase()
  return `${first.slice(0, 1).toUpperCase()}${first.slice(1, 2)}`
}

function ProviderMark(props: { provider: string; class?: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class={`grid h-4 min-w-4 shrink-0 place-items-center rounded-xs bg-muted px-0.5 text-[9px] font-semibold leading-none text-ink-2 ${props.class ?? ""}`}
    >
      {providerInitials(props.provider)}
    </span>
  )
}

/**
 * The model picker: a Combobox whose popup holds the search, favourites first and then the catalog by provider.
 * The parent filters the catalog as the query changes, so the combobox keeps every item it is given.
 * mod+D on the search toggles the highlighted model's favourite.
 */
export function ModelPicker(props: {
  label: string
  current: ModelRef | undefined
  models: readonly ModelInfo[]
  omitted: number
  query: string
  onSearch: (query: string) => void
  onPick: (model: ModelInfo) => void
}): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [extra, setExtra] = createSignal<readonly ModelInfo[]>([])
  const { mounted, settle } = createOverlayMount(open)
  let content: HTMLElement | undefined
  let trigger: HTMLButtonElement | undefined
  const triggerId = `model-picker-${createUniqueId()}`

  const providers = createMemo(() => [...new Set(props.models.map((model) => model.provider))])
  const favorites = createMemo<readonly Entry[]>(() =>
    [...props.models, ...(props.query.trim() === "" ? extra() : [])]
      .filter((model, index, all) => isFavorite(model) && all.findIndex((other) => refKey(other) === refKey(model)) === index)
      .map((model) => ({ value: `${FAVORITES}:${refKey(model)}`, model })),
  )
  const groups = createMemo<readonly (readonly [string, readonly Entry[]])[]>(() => [
    ...(favorites().length > 0 ? [[FAVORITES, favorites()] as const] : []),
    ...providers().map(
      (provider) =>
        [
          provider,
          props.models.filter((model) => model.provider === provider).map((model) => ({ value: refKey(model), model })),
        ] as const,
    ),
  ])
  const entry = (value: string): Entry | undefined =>
    groups()
      .flatMap(([, entries]) => entries)
      .find((candidate) => candidate.value === value)

  const highlighted = (): Entry | undefined => {
    const value = content?.querySelector("[data-slot=combobox-item][data-highlighted]")?.getAttribute("value")
    return value === null || value === undefined ? undefined : entry(value)
  }

  return (
    <ui-combobox
      filter="false"
      auto-highlight="always"
      prop:open={open()}
      prop:value={props.current === undefined ? null : refKey(props.current)}
      prop:query={props.query}
      on:openchange={(event) => {
        event.preventDefault()
        const next = event.detail.value
        if (next) {
          props.onSearch("")
          void missingFavorites(props.models).then(setExtra)
        }
        queueMicrotask(() => setOpen(next))
      }}
      on:openchangecomplete={(event) => {
        settle(event)
        const active = document.activeElement
        if (event.detail.value && active === trigger) content?.querySelector<HTMLInputElement>("input")?.focus()
        if (!event.detail.value && (active === document.body || content?.contains(active) === true)) trigger?.focus()
      }}
      on:querychange={(event) => props.onSearch(event.detail.value)}
      on:valuechange={(event) => {
        event.preventDefault()
        const value = event.detail.value
        const picked = typeof value === "string" ? entry(value) : undefined
        if (picked === undefined) return
        props.onPick(picked.model)
        props.onSearch("")
        queueMicrotask(() => setOpen(false))
      }}
    >
      <ui-combobox-trigger>
        <button
          ref={trigger}
          id={triggerId}
          type="button"
          aria-label={`Model: ${props.label}`}
          class={TOOL}
          {...loadOnIntent("combobox")}
        >
          <Show when={props.current}>{(ref) => <ProviderMark provider={ref().provider} />}</Show>
          <span class="max-w-[220px] truncate">{props.label}</span>
          <ChevronDown size={14} stroke-width={1.5} class="text-icon" />
        </button>
      </ui-combobox-trigger>
      <ui-combobox-content
        ref={(element: HTMLElement) => (content = element)}
        anchor={`#${triggerId}`}
        side="top"
        align="start"
        side-offset="8"
        class={`${POPUP} flex w-[min(400px,calc(100vw-16px))] flex-col p-0`}
      >
        <Show when={mounted()}>
          <div class="flex h-9 shrink-0 items-center border-b border-line-1 px-3">
            <ui-combobox-input class="contents">
              <input
                autofocus
                aria-label="Search models"
                placeholder="Search models"
                aria-keyshortcuts={ariaKeyshortcuts(FAVORITE_SHORTCUT)}
                onKeyDown={(event) => {
                  if (event.key.toLowerCase() !== "d" || !(event.metaKey || event.ctrlKey) || event.altKey) return
                  const target = highlighted()
                  if (target === undefined) return
                  event.preventDefault()
                  toggleFavorite(target.model)
                }}
                class="h-full w-full bg-transparent text-small text-ink outline-none placeholder:text-placeholder"
              />
            </ui-combobox-input>
          </div>
          <ui-combobox-list class="flex max-h-[min(var(--available-height,400px),400px)] min-h-0 flex-col overflow-y-auto p-1">
            <For each={groups()}>
              {([group, entries]) => (
                <ui-combobox-group class="flex flex-col">
                  <ui-combobox-group-label class={POPUP_LABEL}>
                    {group === FAVORITES ? "Favourites" : providerLabel(group)}
                  </ui-combobox-group-label>
                  <For each={entries}>{(item) => <ModelRow entry={item} current={props.current} />}</For>
                </ui-combobox-group>
              )}
            </For>
          </ui-combobox-list>
          <Show when={props.models.length === 0}>
            <div class="px-3 py-2 text-small text-ink-3">
              {props.query.trim() === "" ? "No models yet. Add a provider key in Settings." : "No model matches that."}
            </div>
          </Show>
          <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-line-1 px-3 text-mini text-ink-3">
            <span>{props.omitted > 0 && props.query.trim() === "" ? `${props.omitted} more · search to narrow` : ""}</span>
            <span class="flex items-center gap-1.5">
              <kbd class="inline-flex h-[var(--h-badge)] items-center rounded-xs bg-secondary px-1.5 font-mono text-micro text-ink-2">
                {formatShortcut(FAVORITE_SHORTCUT)}
              </kbd>
              Favourite
            </span>
          </div>
        </Show>
      </ui-combobox-content>
    </ui-combobox>
  )
}

function ModelRow(props: { entry: Entry; current: ModelRef | undefined }): JSX.Element {
  const model = (): ModelInfo => props.entry.model
  const favorite = (): boolean => isFavorite(model())
  const selected = (): boolean => props.current !== undefined && refKey(props.current) === refKey(model())
  return (
    <ui-combobox-item
      value={props.entry.value}
      label={model().name}
      disabled={model().keyed ? undefined : ""}
      class={`${POPUP_ITEM} group/model pr-1`}
    >
      <ProviderMark provider={model().provider} />
      <span class="min-w-0 flex-1 truncate" classList={{ "text-ink-3": !model().keyed }}>
        {model().name}
      </span>
      <Show when={!model().keyed}>
        <span class="shrink-0 text-mini text-ink-3">no key</span>
      </Show>
      <button
        type="button"
        aria-label={favorite() ? `Remove ${model().name} from favourites` : `Add ${model().name} to favourites`}
        aria-pressed={favorite()}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          toggleFavorite(model())
        }}
        class="grid h-6 w-6 shrink-0 place-items-center rounded-xs text-icon opacity-0 hover:text-ink group-hover/model:opacity-100 group-data-[highlighted]/model:opacity-100"
        classList={{ "!opacity-100 text-working": favorite() }}
      >
        <Star size={14} stroke-width={1.5} fill={favorite() ? "currentColor" : "none"} />
      </button>
      <span class="grid w-5 shrink-0 place-items-center">
        <Show when={selected()}>
          <Check size={14} stroke-width={1.5} class="text-ink" />
        </Show>
      </span>
    </ui-combobox-item>
  )
}
