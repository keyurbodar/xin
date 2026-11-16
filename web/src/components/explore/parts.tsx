import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Glyph, type GlyphName } from "../extensions/glyph.tsx"

export type Crumb = { readonly label: string; readonly to?: string | undefined }

export function Breadcrumb(props: { crumbs: readonly Crumb[] }): JSX.Element {
  return (
    <nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-1.5 text-sm">
      <For each={props.crumbs}>
        {(crumb, index) => (
          <>
            <Show when={index() > 0}>
              <Glyph name="chevron-right" size={12} class="shrink-0 text-icon" />
            </Show>
            <Show
              when={crumb.to !== undefined && index() < props.crumbs.length - 1}
              fallback={
                <span class="truncate text-ink" aria-current="page">
                  {crumb.label}
                </span>
              }
            >
              <a
                href={`#${crumb.to ?? ""}`}
                class="shrink-0 rounded-xs text-ink-2 hover:text-ink"
              >
                {crumb.label}
              </a>
            </Show>
          </>
        )}
      </For>
    </nav>
  )
}

/** A 32px logo tile that holds its slot: the glyph shows at once and the image fades in over it when it loads. */
export function LogoTile(props: {
  src?: string | undefined
  glyph: GlyphName
  verified?: boolean | undefined
  size?: number | undefined
}): JSX.Element {
  const [loaded, setLoaded] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const size = (): number => props.size ?? 32
  return (
    <span
      class="relative grid shrink-0 place-items-center rounded-sm bg-secondary text-ink-2 shadow-ring"
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      <Glyph name={props.glyph} size={Math.round(size() / 2)} />
      <Show when={props.src !== undefined && !failed()}>
        <img
          src={props.src}
          alt=""
          loading="lazy"
          decoding="async"
          width={size()}
          height={size()}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          class="ex-fade absolute inset-0 h-full w-full rounded-sm object-cover"
          data-loaded={loaded() ? "" : undefined}
        />
      </Show>
      <Show when={props.verified === true}>
        <span
          class="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-primary text-on-primary ring-2 ring-panel"
          title="Built in"
        >
          <Glyph name="check" size={9} />
        </span>
      </Show>
    </span>
  )
}

/** The header search box; "/" anywhere outside a text field focuses it. */
export function SearchBox(props: { value: string; placeholder: string; onInput: (value: string) => void }): JSX.Element {
  let input: HTMLInputElement | undefined
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))) return
      event.preventDefault()
      input?.focus()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
  return (
    <label class="flex h-8 w-full items-center gap-2 rounded-sm bg-bg px-2.5 shadow-ring focus-within:shadow-[0_0_0_1px_var(--color-primary)] sm:w-[220px]">
      <Glyph name="search" size={14} class="shrink-0 text-ink-3" />
      <input
        ref={input}
        type="search"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.value !== "") {
            event.stopPropagation()
            props.onInput("")
          }
        }}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        spellcheck={false}
        class="h-full min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-placeholder focus:outline-none"
      />
      <span class="kbd hidden sm:inline-flex" aria-hidden="true">
        /
      </span>
    </label>
  )
}

export function SectionHead(props: { label: string; action?: JSX.Element | undefined }): JSX.Element {
  return (
    <div class="flex h-7 items-center justify-between">
      <h2 class="text-sm font-medium text-ink-2">{props.label}</h2>
      {props.action}
    </div>
  )
}

export function ViewAll(props: { onClick: () => void; label?: string | undefined }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onClick()}
      class="ex-color flex items-center gap-1 rounded-xs text-sm text-ink-2 hover:text-ink"
    >
      {props.label ?? "View all"}
      <Glyph name="arrow-right" size={12} />
    </button>
  )
}

/** A compact catalogue row: logo, name and a one-line description; the whole row is the link. */
export function CompactRow(props: {
  to: string
  title: string
  description: string
  logo: JSX.Element
  badge?: string | undefined
  trailing?: JSX.Element | undefined
}): JSX.Element {
  return (
    <a
      href={`#${props.to}`}
      class="ex-color flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
    >
      {props.logo}
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="truncate text-sm font-medium text-ink">{props.title}</span>
          <Show when={props.badge}>
            {(badge) => <span class="shrink-0 rounded-xs bg-secondary px-1 text-2xs text-ink-2">{badge()}</span>}
          </Show>
        </span>
        <span class="block truncate text-sm text-ink-2">{props.description === "" ? "No description" : props.description}</span>
      </span>
      {props.trailing}
    </a>
  )
}

export function RowGrid(props: { children: JSX.Element }): JSX.Element {
  return <div class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">{props.children}</div>
}

export function SkeletonRows(props: { count?: number | undefined }): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading">
      <RowGrid>
        <For each={Array.from({ length: props.count ?? 6 })}>
          {() => (
            <div class="flex items-center gap-3 px-2 py-2">
              <span class="ex-skeleton h-8 w-8 rounded-sm" />
              <span class="flex flex-1 flex-col gap-1.5">
                <span class="ex-skeleton h-3 w-2/5 rounded-xs" />
                <span class="ex-skeleton h-3 w-4/5 rounded-xs" />
              </span>
            </div>
          )}
        </For>
      </RowGrid>
    </div>
  )
}

export function NoMatches(props: { query: string; onClear: () => void }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-md px-2 py-8" role="status">
      <span class="text-base text-ink">No matches for “{props.query}”</span>
      <span class="text-sm text-ink-2">Try a shorter word, an author, or a category.</span>
      <button type="button" onClick={() => props.onClear()} class="text-sm text-primary-ink hover:underline">
        Clear search
      </button>
    </div>
  )
}

export function LoadFailed(props: { what: string; message: string; onRetry: () => void }): JSX.Element {
  return (
    <div class="flex flex-col items-start gap-2 rounded-md bg-failed-soft px-4 py-4" role="alert">
      <span class="text-sm text-ink">Couldn't load {props.what}</span>
      <span class="font-mono text-xs text-ink-2">{props.message}</span>
      <button
        type="button"
        onClick={() => props.onRetry()}
        class="mt-1 rounded-sm px-2.5 py-1 text-sm text-ink shadow-ring hover:bg-hover"
      >
        Try again
      </button>
    </div>
  )
}

/** The page frame: a centred 640px column with the breadcrumb on top. */
export function Page(props: { crumbs: readonly Crumb[]; wide?: boolean | undefined; children: JSX.Element }): JSX.Element {
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        class="mx-auto flex w-full flex-col gap-6 px-4 pb-16 pt-5 sm:px-8"
        classList={{ "max-w-[688px]": props.wide !== true, "max-w-[976px]": props.wide === true }}
      >
        <Breadcrumb crumbs={props.crumbs} />
        {props.children}
      </div>
    </div>
  )
}

export function Fact(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-1">
      <dt class="text-xs text-ink-3">{props.label}</dt>
      <dd class="min-w-0 break-words text-sm text-ink">{props.children}</dd>
    </div>
  )
}

export function ExternalLink(props: { href: string; children: JSX.Element }): JSX.Element {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer noopener"
      class="inline-flex max-w-full items-center gap-1 text-primary-ink hover:underline"
    >
      <span class="truncate">{props.children}</span>
      <Glyph name="external-link" size={11} class="shrink-0" />
    </a>
  )
}

export function Card(props: { title?: string | undefined; children: JSX.Element; class?: string | undefined }): JSX.Element {
  return (
    <section class={`overflow-hidden rounded-lg bg-card shadow-ring ${props.class ?? ""}`}>
      <Show when={props.title}>
        {(title) => <h3 class="border-b border-line-1 px-4 py-2.5 text-sm font-medium text-ink">{title()}</h3>}
      </Show>
      {props.children}
    </section>
  )
}

/** Detail layout: main column and a side column of facts; the side stacks under main below 768px. */
export function DetailColumns(props: { main: JSX.Element; side: JSX.Element }): JSX.Element {
  return (
    <div class="grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_220px]">
      <div class="flex min-w-0 flex-col gap-5">{props.main}</div>
      <aside class="min-w-0">
        <dl class="flex flex-col gap-4 md:sticky md:top-0">{props.side}</dl>
      </aside>
    </div>
  )
}

export function Pager(props: { page: number; pages: number; onPage: (page: number) => void }): JSX.Element {
  return (
    <nav aria-label="Pages" class="flex items-center justify-center gap-4 text-sm">
      <button
        type="button"
        disabled={props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
        class="rounded-sm px-2 py-1 text-ink-2 hover:text-ink disabled:text-icon"
      >
        Previous
      </button>
      <span class="text-ink-2" aria-live="polite">
        {props.page} of {props.pages}
      </span>
      <button
        type="button"
        disabled={props.page >= props.pages}
        onClick={() => props.onPage(props.page + 1)}
        class="rounded-sm px-2 py-1 text-ink-2 hover:text-ink disabled:text-icon"
      >
        Next
      </button>
    </nav>
  )
}
