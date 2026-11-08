import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { priceMarks, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { Icon } from "../ui/icon.tsx"
import { GlideList } from "../ui/glide.tsx"

const PIN_KEY = "xin.models.pinned"

function readPinned(): readonly string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}

function writePinned(value: readonly string[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(value))
  } catch {
    return
  }
}

const keyOf = (model: { readonly provider: string; readonly modelId: string }): string =>
  `${model.provider}/${model.modelId}`

const same = (left: ModelRef | undefined, right: ModelInfo): boolean =>
  left !== undefined && left.provider === right.provider && left.modelId === right.modelId

export function ModelPicker(props: {
  models: readonly ModelInfo[]
  current: ModelRef | undefined
  omitted: number
  query: string
  onSearch: (query: string) => void
  onPick: (model: ModelInfo) => void
}): JSX.Element {
  const [pinned, setPinned] = createSignal<readonly string[]>(readPinned())
  const [provider, setProvider] = createSignal<string | undefined>(undefined)
  const [cursor, setCursor] = createSignal(0)
  let search!: HTMLInputElement

  onMount(() => search.focus())

  const providers = createMemo((): readonly string[] => {
    const seen: string[] = []
    for (const model of props.models) if (!seen.includes(model.provider)) seen.push(model.provider)
    return seen
  })

  const visible = createMemo((): readonly ModelInfo[] => {
    const wanted = provider()
    return wanted === undefined ? props.models : props.models.filter((model) => model.provider === wanted)
  })

  const favoriteRows = createMemo((): readonly ModelInfo[] => {
    const marks = pinned()
    if (marks.length === 0 || props.query.trim() !== "") return []
    return visible().filter((model) => marks.includes(keyOf(model)))
  })

  const rows = createMemo((): readonly ModelInfo[] => {
    const favorites = favoriteRows()
    const rest = visible().filter((model) => !favorites.includes(model))
    return [...favorites, ...rest]
  })

  const currentIndex = (): number => Math.min(cursor(), Math.max(rows().length - 1, 0))

  const pick = (model: ModelInfo | undefined): void => {
    if (model === undefined || !model.keyed) return
    props.onPick(model)
  }

  const togglePin = (model: ModelInfo): void => {
    const key = keyOf(model)
    const next = pinned().includes(key) ? pinned().filter((item) => item !== key) : [key, ...pinned()]
    setPinned(next)
    writePinned(next)
  }

  const move = (step: number): void => {
    setCursor((value) => Math.max(0, Math.min(value + step, rows().length - 1)))
  }

  return (
    <div class="flex max-h-[min(392px,70dvh)] w-[min(400px,calc(100vw-32px))] flex-col overflow-hidden">
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="search" size={13} class="shrink-0 text-fg-4" />
        <input
          ref={search}
          type="text"
          value={props.query}
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-label="Search models"
          aria-controls="model-picker-list"
          aria-activedescendant={rows().length > 0 ? `model-option-${currentIndex()}` : undefined}
          placeholder="Search models"
          class="h-6 min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-4"
          onInput={(event) => {
            setCursor(0)
            props.onSearch(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              move(1)
              return
            }
            if (event.key === "ArrowUp") {
              event.preventDefault()
              move(-1)
              return
            }
            if (event.key === "Enter") {
              event.preventDefault()
              pick(rows()[currentIndex()])
            }
          }}
        />
        <span class="mono-meta shrink-0">{rows().length}</span>
      </div>

      <div class="flex min-h-0 flex-1">
        <GlideList class="flex w-[112px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-1" radius="8px">
          <button
            type="button"
            data-glide-item=""
            title="All providers"
            aria-label="All providers"
            aria-pressed={provider() === undefined}
            onClick={() => {
              setProvider(undefined)
              setCursor(0)
            }}
            class="glide-item flex h-8 w-full items-center rounded-[8px] px-2 text-[12.5px]"
            classList={{ "text-fg": provider() === undefined, "text-fg-3": provider() !== undefined }}
          >
            All providers
          </button>
          <For each={providers()}>
            {(name) => (
              <button
                type="button"
                data-glide-item=""
                title={name}
                aria-label={name}
                aria-pressed={provider() === name}
                onClick={() => {
                  setProvider(name)
                  setCursor(0)
                }}
                class="glide-item flex h-8 w-full items-center truncate rounded-[8px] px-2 font-mono text-[11.5px]"
                classList={{ "text-fg": provider() === name, "text-fg-3": provider() !== name }}
              >
                {name}
              </button>
            )}
          </For>
        </GlideList>

        <div class="min-h-0 flex-1 overflow-y-auto p-1" id="model-picker-list" role="listbox" aria-label="Models">
          <Show
            when={rows().length > 0}
            fallback={
              <div class="px-2.5 py-3 text-[13px] text-fg-3">
                {props.query.trim() === "" ? "No models yet. Add a provider key in Settings." : "No model matches that."}
              </div>
            }
          >
            <GlideList class="flex flex-col gap-0.5" radius="8px" active={rows()[currentIndex()] === undefined ? undefined : `model-${currentIndex()}`}>
              <Show when={favoriteRows().length > 0}>
                <div class="label px-2 pb-1 pt-1" aria-hidden="true">
                  Pinned
                </div>
              </Show>
              <For each={rows()}>
                {(model, index) => (
                  <>
                    <Show when={favoriteRows().length > 0 && index() === favoriteRows().length}>
                      <div class="label px-2 pb-1 pt-2.5" aria-hidden="true">
                        {provider() ?? "All models"}
                      </div>
                    </Show>
                    <div
                      data-glide-item=""
                      data-glide-value={`model-${index()}`}
                      id={`model-option-${index()}`}
                      role="option"
                      aria-selected={same(props.current, model)}
                      aria-disabled={!model.keyed}
                      class="glide-item flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left"
                      classList={{ "opacity-45": !model.keyed }}
                      onClick={() => pick(model)}
                    >
                      <span class="min-w-0 flex-1 truncate text-[13.5px]">
                        {model.name}
                        <Show when={provider() === undefined && props.query.trim() === ""}>
                          <span class="ml-1.5 font-mono text-[10.5px] text-fg-4">{model.provider}</span>
                        </Show>
                      </span>
                      <Show when={priceMarks(model.cost)}>
                        {(marks) => <span class="shrink-0 font-mono text-[10.5px] text-fg-3">{marks()}</span>}
                      </Show>
                      <Show when={!model.keyed}>
                        <span class="shrink-0 font-mono text-[10.5px] text-fg-3">no key</span>
                      </Show>
                      <button
                        type="button"
                        aria-label={pinned().includes(keyOf(model)) ? "Unpin this model" : "Pin this model"}
                        aria-pressed={pinned().includes(keyOf(model))}
                        onClick={(event) => {
                          event.stopPropagation()
                          togglePin(model)
                        }}
                        class="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-fg-4 hover:bg-fill-strong hover:text-fg-2 focus-visible:opacity-100"
                        classList={{ "text-fg-2 opacity-100": pinned().includes(keyOf(model)), "opacity-0": !pinned().includes(keyOf(model)) }}
                      >
                        <Icon name="pin" size={11} />
                      </button>
                      <Show when={same(props.current, model)}>
                        <span class="grid h-4 w-4 shrink-0 place-items-center text-fg">
                          <Icon name="check" size={12} />
                        </span>
                      </Show>
                    </div>
                  </>
                )}
              </For>
            </GlideList>
          </Show>
        </div>
      </div>

      <Show when={props.omitted > 0 && props.query.trim() === ""}>
        <div class="shrink-0 border-t border-line px-3 py-1.5 font-mono text-[10.5px] text-fg-4">
          {props.omitted} more · search to narrow the list
        </div>
      </Show>
    </div>
  )
}
