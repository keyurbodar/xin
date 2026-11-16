import { For, Show, type JSX } from "solid-js"

export type Crumb = { readonly label: string; readonly href: string }

/** A trail of links; the last one is the current page. */
export function Breadcrumb(props: { crumbs: readonly Crumb[] }): JSX.Element {
  return (
    <nav aria-label="Breadcrumb">
      <ol class="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
        <For each={props.crumbs}>
          {(crumb, index) => (
            <li class="flex min-w-0 items-center gap-1.5">
              <Show when={index() > 0}>
                <span aria-hidden="true" class="text-icon">
                  ›
                </span>
              </Show>
              <a
                href={crumb.href}
                aria-current={index() === props.crumbs.length - 1 ? "page" : undefined}
                class="truncate rounded-xs transition-colors duration-100 hover:text-ink aria-[current=page]:text-ink-2"
              >
                {crumb.label}
              </a>
            </li>
          )}
        </For>
      </ol>
    </nav>
  )
}
