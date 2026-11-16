import "./settings.css"
import "@ui-sdk/web/checkbox"
import "@ui-sdk/web/input"
import "@ui-sdk/web/select"
import "@ui-sdk/web/switch"
import { Check, ChevronsUpDown } from "lucide-solid"
import {
  createContext,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  splitProps,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js"
import { POPUP, POPUP_ITEM, POPUP_LABEL } from "../ui/surface.ts"

export function matches(query: string, ...texts: readonly (string | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter((word) => word !== "")
  if (words.length === 0) return true
  const haystack = texts.filter((text) => text !== undefined).join(" ").toLowerCase()
  return words.every((word) => haystack.includes(word))
}

type Scope = {
  readonly query: Accessor<string>
  readonly forced: Accessor<boolean>
  readonly enlist: (shown: Accessor<boolean>) => void
}

const SearchScope = createContext<Scope>({ query: () => "", forced: () => false, enlist: () => undefined })

function enlisted(): { readonly any: Accessor<boolean>; readonly enlist: (shown: Accessor<boolean>) => void } {
  const [members, setMembers] = createSignal<readonly Accessor<boolean>[]>([])
  return {
    any: () => members().some((shown) => shown()),
    enlist: (shown) => {
      setMembers((now) => [...now, shown])
      onCleanup(() => setMembers((now) => now.filter((member) => member !== shown)))
    },
  }
}

/** The page column: filters its groups and rows by `query`, and reports whether anything is left. */
export function SearchablePage(props: {
  query: string
  children: JSX.Element
  empty: (query: string) => JSX.Element
}): JSX.Element {
  const groups = enlisted()
  const searching = (): boolean => props.query.trim() !== ""
  return (
    <SearchScope.Provider value={{ query: () => props.query, forced: () => false, enlist: groups.enlist }}>
      <div class="settings-sections flex flex-col gap-8">{props.children}</div>
      <Show when={searching() && !groups.any()}>{props.empty(props.query.trim())}</Show>
    </SearchScope.Provider>
  )
}

export function Group(props: { title: string; detail?: string | undefined; children: JSX.Element }): JSX.Element {
  const outer = useContext(SearchScope)
  const rows = enlisted()
  const titled = (): boolean => outer.forced() || matches(outer.query(), props.title, props.detail)
  const shown = (): boolean => outer.query().trim() === "" || titled() || rows.any()
  outer.enlist(shown)
  return (
    <section class="settings-section flex flex-col gap-3" hidden={!shown()} aria-label={props.title}>
      <div class="flex flex-col gap-0.5">
        <div class="flex items-center gap-2">
          <span aria-hidden="true" class="settings-index font-mono text-mini text-ink-3" />
          <h2 class="text-small font-title text-ink">{props.title}</h2>
          <span aria-hidden="true" class="h-px min-w-4 flex-1 bg-line-1" />
        </div>
        <Show when={props.detail}>{(detail) => <p class="text-mini text-ink-3">{detail()}</p>}</Show>
      </div>
      <SearchScope.Provider value={{ query: outer.query, forced: titled, enlist: rows.enlist }}>
        {props.children}
      </SearchScope.Provider>
    </section>
  )
}

export function Card(props: { children: JSX.Element; class?: string | undefined }): JSX.Element {
  return (
    <div
      class={`flex flex-col overflow-hidden rounded-lg shadow-ring [&>*:not([hidden])~*:not([hidden])]:border-t [&>*]:border-line-1 ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  )
}

export function Row(props: { title: string; detail?: string | undefined; children: JSX.Element }): JSX.Element {
  const scope = useContext(SearchScope)
  const shown = (): boolean => scope.forced() || matches(scope.query(), props.title, props.detail)
  scope.enlist(shown)
  return (
    <div
      hidden={!shown()}
      data-settings-row={props.title}
      class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
    >
      <div class="min-w-[min(100%,200px)] flex-[1_1_200px]">
        <span class="block text-small font-title text-ink">{props.title}</span>
        <Show when={props.detail}>
          {(detail) => <span class="mt-0.5 block text-mini text-ink-3">{detail()}</span>}
        </Show>
      </div>
      <div class="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end">{props.children}</div>
    </div>
  )
}

/** Free content inside a Card (a list, a note, a form) that shows only while the search leaves its group open. */
export function CardBlock(props: { children: JSX.Element; class?: string | undefined }): JSX.Element {
  const scope = useContext(SearchScope)
  const shown = (): boolean => scope.query().trim() === "" || scope.forced()
  return (
    <div hidden={!shown()} class={props.class ?? "px-4 py-3"}>
      {props.children}
    </div>
  )
}

export const FIELD =
  "h-[var(--h-control)] w-full min-w-0 rounded-sm bg-bg px-2 text-body text-ink shadow-ring placeholder:text-placeholder disabled:opacity-40"

export const MONO_FIELD = `${FIELD} font-mono`

export function TextField(
  props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class"> & { class?: string | undefined; mono?: boolean | undefined },
): JSX.Element {
  const [own, rest] = splitProps(props, ["class", "mono"])
  return (
    <ui-input class={`flex min-w-0 ${own.class ?? "w-full"}`}>
      <input {...rest} class={own.mono === true ? MONO_FIELD : FIELD} />
    </ui-input>
  )
}

export function Switch(props: {
  on: boolean
  disabled?: boolean | undefined
  label: string
  onChange: (next: boolean) => void
}): JSX.Element {
  let element: (HTMLElement & { checked: boolean; disabled: boolean }) | undefined
  createEffect(() => {
    const on = props.on
    const disabled = props.disabled === true
    if (element === undefined) return
    element.disabled = false
    element.checked = on
    element.disabled = disabled
  })
  return (
    <ui-switch
      ref={(node: HTMLElement) => {
        element = node as HTMLElement & { checked: boolean; disabled: boolean }
      }}
      aria-label={props.label}
      on:checkedchange={(event: CustomEvent<{ value: boolean; reason: string }>) => {
        if (event.detail.reason === "imperative") return
        event.preventDefault()
        props.onChange(event.detail.value)
      }}
      class="settings-switch relative block h-4 w-7 shrink-0 cursor-default rounded-full bg-line-2 transition-colors duration-150 data-[checked]:bg-ink data-[disabled]:opacity-40"
    >
      <ui-switch-thumb class="absolute left-0.5 top-0.5 block h-3 w-3 rounded-full bg-ink-3 data-[checked]:translate-x-3 data-[checked]:bg-bg" />
    </ui-switch>
  )
}

export function CheckboxField(props: { checked: boolean; label: string; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <label class="flex items-center gap-2 text-small text-ink-2">
      <ui-checkbox
        prop:checked={props.checked}
        on:checkedchange={(event: CustomEvent<{ value: boolean }>) => props.onChange(event.detail.value)}
        class="grid h-4 w-4 shrink-0 place-items-center rounded-xs bg-bg text-on-primary shadow-ring data-[checked]:bg-primary"
      >
        <ui-checkbox-indicator class="grid place-items-center">
          <Check size={12} stroke-width={2} aria-hidden="true" />
        </ui-checkbox-indicator>
      </ui-checkbox>
      {props.label}
    </label>
  )
}

export type Choice = { readonly value: string; readonly label: string; readonly group?: string | undefined }

const UNSET = "\u0000unset"

export function SelectField(props: {
  value: string
  onChange: (next: string) => void
  choices: readonly Choice[]
  placeholder?: string | undefined
  ariaLabel: string
  disabled?: boolean | undefined
  required?: boolean | undefined
  width?: string | undefined
}): JSX.Element {
  const groups = (): readonly { readonly name: string | undefined; readonly entries: readonly Choice[] }[] => {
    const found: { name: string | undefined; entries: Choice[] }[] = []
    for (const choice of props.choices) {
      const current = found.find((group) => group.name === choice.group)
      if (current === undefined) found.push({ name: choice.group, entries: [choice] })
      else current.entries.push(choice)
    }
    return found
  }

  const item = (choice: Choice): JSX.Element => (
    <ui-select-item value={choice.value} label={choice.label} class={POPUP_ITEM}>
      <span class="min-w-0 flex-1 truncate">{choice.label}</span>
      <ui-select-item-indicator class="text-ink-2">
        <Check size={14} stroke-width={1.5} aria-hidden="true" />
      </ui-select-item-indicator>
    </ui-select-item>
  )

  return (
    <ui-select
      prop:value={props.value === "" && props.required !== true ? UNSET : props.value}
      prop:disabled={props.disabled === true}
      placeholder={props.placeholder ?? "Catalog default"}
      on:valuechange={(event: CustomEvent<{ value: unknown }>) => {
        const next = event.detail.value
        if (typeof next === "string") props.onChange(next === UNSET ? "" : next)
      }}
      class="block max-w-full"
      style={{ width: props.width ?? "240px" }}
    >
      <ui-select-trigger>
        <button
          type="button"
          aria-label={props.ariaLabel}
          class={`${FIELD} flex items-center gap-2 text-left text-small`}
        >
          <ui-select-value class="min-w-0 flex-1 truncate" />
          <ChevronsUpDown size={14} stroke-width={1.5} class="shrink-0 text-icon" aria-hidden="true" />
        </button>
      </ui-select-trigger>
      <ui-select-content side-offset="4" class={`${POPUP} w-[var(--anchor-width)]`}>
        <Show when={props.required !== true}>{item({ value: UNSET, label: props.placeholder ?? "Catalog default" })}</Show>
        <For each={groups()}>
          {(group) =>
            group.name === undefined ? (
              <For each={group.entries}>{item}</For>
            ) : (
              <ui-select-group>
                <ui-select-group-label class={POPUP_LABEL}>{group.name}</ui-select-group-label>
                <For each={group.entries}>{item}</For>
              </ui-select-group>
            )
          }
        </For>
      </ui-select-content>
    </ui-select>
  )
}

export function Saved(props: { show: boolean }): JSX.Element {
  return (
    <Show when={props.show}>
      <span class="ml-2 inline-flex items-center gap-1 text-mini text-ink-3">
        <Check size={12} stroke-width={1.5} aria-hidden="true" />
        Saved
      </span>
    </Show>
  )
}
