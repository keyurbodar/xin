import { For, Show, type JSX } from "solid-js"

export function Group(props: { title: string; detail?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex items-baseline gap-2">
        <span class="label">{props.title}</span>
        <Show when={props.detail}>
          {(detail) => <span class="text-[11.5px] text-fg-3">{detail()}</span>}
        </Show>
      </div>
      <div class="flex flex-col">{props.children}</div>
    </section>
  )
}

export function Row(props: { title: string; detail?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <div class="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-6 border-b border-line py-3.5 last:border-0">
      <div class="min-w-0">
        <span class="block text-[12.5px] font-medium text-fg">{props.title}</span>
        <Show when={props.detail}>
          {(detail) => <span class="mt-0.5 block text-[11.5px] leading-snug text-fg-3">{detail()}</span>}
        </Show>
      </div>
      <div class="min-w-0">{props.children}</div>
    </div>
  )
}

export type Choice = { readonly value: string; readonly label: string; readonly group?: string | undefined }

export function SelectField(props: {
  value: string
  onChange: (next: string) => void
  choices: readonly Choice[]
  placeholder?: string | undefined
  ariaLabel: string
  disabled?: boolean | undefined
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

  return (
    <select
      value={props.value}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      class="h-8 rounded-[2px] border border-line-inner bg-page px-2 text-[12.5px] text-fg focus:border-line-strong focus:outline-none disabled:opacity-40"
      style={{ width: props.width ?? "260px" }}
    >
      <option value="">{props.placeholder ?? "Catalog default"}</option>
      <For each={groups()}>
        {(group) =>
          group.name === undefined ? (
            <For each={group.entries}>{(choice) => <option value={choice.value}>{choice.label}</option>}</For>
          ) : (
            <optgroup label={group.name}>
              <For each={group.entries}>{(choice) => <option value={choice.value}>{choice.label}</option>}</For>
            </optgroup>
          )
        }
      </For>
    </select>
  )
}

export function Saved(props: { show: boolean }): JSX.Element {
  return (
    <Show when={props.show}>
      <span class="ml-2 inline-flex items-center gap-1 text-[11.5px] text-fg-3">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="m5 12 5 5L20 7" />
        </svg>
        Saved
      </span>
    </Show>
  )
}
