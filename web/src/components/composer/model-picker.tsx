import { createListCollection } from "@ark-ui/solid/collection"
import { Listbox } from "@ark-ui/solid/listbox"
import { Popover } from "@ark-ui/solid/popover"
import { Check, ChevronDown, Star } from "lucide-solid"
import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { isFavorite, missingFavorites, toggleFavorite, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { GROUP_LABEL, ITEM, SURFACE, TOOL } from "./styles.ts"

const FAVORITES = "favorites"

const FAVORITE_KEY = /Mac|iPhone|iPad/u.test(navigator.userAgent) ? "⌘D" : "Ctrl+D"

type Entry = { readonly value: string; readonly group: string; readonly model: ModelInfo }

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

/** The model picker: search, a rail of providers, and the catalog grouped by provider with favourites first. */
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
  const [highlighted, setHighlighted] = createSignal<string | null>(null)
  let list: HTMLDivElement | undefined

  const providerIds = createMemo(() => [...new Set(props.models.map((model) => model.provider))])
  const entries = createMemo<readonly Entry[]>(() => [
    ...[...props.models, ...(props.query.trim() === "" ? extra() : [])]
      .filter((model, index, all) => isFavorite(model) && all.findIndex((other) => refKey(other) === refKey(model)) === index)
      .map((model) => ({ value: `${FAVORITES}:${refKey(model)}`, group: FAVORITES, model })),
    ...props.models.map((model) => ({ value: refKey(model), group: model.provider, model })),
  ])
  const collection = createMemo(() =>
    createListCollection<Entry>({
      items: [...entries()],
      itemToValue: (entry) => entry.value,
      itemToString: (entry) => entry.model.name,
      isItemDisabled: (entry) => !entry.model.keyed,
      groupBy: (entry) => entry.group,
      groupSort: [FAVORITES, ...providerIds()],
    }),
  )
  const selected = (): string[] => {
    const ref = props.current
    if (ref === undefined) return []
    return isFavorite(ref) ? [refKey(ref), `${FAVORITES}:${refKey(ref)}`] : [refKey(ref)]
  }
  const currentProvider = (): string | undefined => props.current?.provider

  const jump = (group: string): void => {
    list?.querySelector(`[data-group="${CSS.escape(group)}"]`)?.scrollIntoView({ block: "start" })
  }

  return (
    <Popover.Root
      open={open()}
      onOpenChange={(details) => {
        setOpen(details.open)
        setHighlighted(null)
        if (!details.open) return
        props.onSearch("")
        void missingFavorites(props.models).then(setExtra)
      }}
      positioning={{ placement: "top-start", gutter: 8 }}
      lazyMount
      unmountOnExit
    >
      <Popover.Trigger class={TOOL}>
        <Show when={props.current}>{(ref) => <ProviderMark provider={ref().provider} />}</Show>
        <span class="max-w-[220px] truncate">{props.label}</span>
        <ChevronDown size={14} stroke-width={1.5} class="text-icon" />
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content class={`${SURFACE} w-[min(440px,calc(100vw-16px))]`} aria-label="Choose a model">
            <Listbox.Root
              collection={collection()}
              value={selected()}
              onHighlightChange={(details) => setHighlighted(details.highlightedValue)}
              onSelect={(details) => {
                const entry = collection().find(details.value)
                if (entry === null) return
                props.onPick(entry.model)
                props.onSearch("")
                setOpen(false)
              }}
              class="flex flex-col"
            >
              <Listbox.Input
                value={props.query}
                onInput={(event) => props.onSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key.toLowerCase() !== "d" || !(event.metaKey || event.ctrlKey) || event.altKey) return
                  const value = highlighted()
                  const entry = value === null ? null : collection().find(value)
                  if (entry === null) return
                  event.preventDefault()
                  toggleFavorite(entry.model)
                }}
                placeholder="Search models"
                aria-label="Search models"
                class="h-11 w-full border-b border-line-1 bg-transparent px-3.5 text-sm text-ink outline-none placeholder:text-placeholder"
              />
              <div class="flex max-h-[400px] min-h-0">
                <Show when={props.query.trim() === "" && providerIds().length > 1}>
                  <nav aria-label="Providers" class="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line-1 py-1.5">
                    <Show when={entries().some((entry) => entry.group === FAVORITES)}>
                      <button
                        type="button"
                        aria-label="Favourites"
                        title="Favourites"
                        onClick={() => jump(FAVORITES)}
                        class="composer-press grid h-7 w-7 place-items-center rounded-sm text-icon hover:bg-hover hover:text-ink"
                      >
                        <Star size={16} stroke-width={1.5} />
                      </button>
                    </Show>
                    <For each={providerIds()}>
                      {(provider) => (
                        <button
                          type="button"
                          aria-label={providerLabel(provider)}
                          title={providerLabel(provider)}
                          onClick={() => jump(provider)}
                          class="composer-press grid h-7 w-7 place-items-center rounded-sm hover:bg-hover"
                          classList={{ "bg-secondary": provider === currentProvider() }}
                        >
                          <ProviderMark provider={provider} class="h-6 min-w-6 text-[10px]" />
                        </button>
                      )}
                    </For>
                  </nav>
                </Show>
                <Listbox.Content ref={(element: HTMLDivElement) => (list = element)} class="min-w-0 flex-1 overflow-y-auto p-1 outline-none">
                  <For each={collection().group()}>
                    {([group, items]) => (
                      <Listbox.ItemGroup data-group={group}>
                        <Listbox.ItemGroupLabel class={GROUP_LABEL}>
                          {group === FAVORITES ? "Favourites" : providerLabel(group)}
                        </Listbox.ItemGroupLabel>
                        <For each={items}>{(entry) => <ModelRow entry={entry} />}</For>
                      </Listbox.ItemGroup>
                    )}
                  </For>
                  <Show when={props.models.length === 0}>
                    <div class="px-2 py-2 text-sm text-ink-3">
                      {props.query.trim() === "" ? "No models yet. Add a provider key in Settings." : "No model matches that."}
                    </div>
                  </Show>
                  <Show when={props.omitted > 0 && props.query.trim() === ""}>
                    <div class="px-2 py-2 text-xs text-ink-3">{props.omitted} more · search to narrow the list</div>
                  </Show>
                </Listbox.Content>
              </div>
            </Listbox.Root>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  )
}

function ModelRow(props: { entry: Entry }): JSX.Element {
  const model = (): ModelInfo => props.entry.model
  const favorite = (): boolean => isFavorite(model())
  return (
    <Listbox.Item item={props.entry} aria-keyshortcuts="Meta+D Control+D" class={`${ITEM} group/model pr-1`}>
      <ProviderMark provider={model().provider} />
      <Listbox.ItemText class="min-w-0 flex-1 truncate" classList={{ "text-ink-3": !model().keyed }}>
        {model().name}
      </Listbox.ItemText>
      <Show when={!model().keyed}>
        <span class="shrink-0 text-xs text-ink-3">no key</span>
      </Show>
      <button
        type="button"
        aria-label={`${favorite() ? `Remove ${model().name} from favourites` : `Add ${model().name} to favourites`} (${FAVORITE_KEY})`}
        title={`${favorite() ? "Remove from favourites" : "Add to favourites"} · ${FAVORITE_KEY}`}
        aria-pressed={favorite()}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          toggleFavorite(model())
        }}
        class="grid h-6 w-6 shrink-0 place-items-center rounded-xs text-icon opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/model:opacity-100 group-data-[highlighted]/model:opacity-100"
        classList={{ "!opacity-100 text-working": favorite() }}
      >
        <Star size={14} stroke-width={1.5} fill={favorite() ? "currentColor" : "none"} />
      </button>
      <span class="grid w-5 shrink-0 place-items-center">
        <Listbox.ItemIndicator>
          <Check size={14} stroke-width={1.5} class="text-ink" />
        </Listbox.ItemIndicator>
      </span>
    </Listbox.Item>
  )
}
