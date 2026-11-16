import { For, Show, type JSX } from "solid-js"

export type Crumb = { readonly label: string; readonly href: string; readonly lead?: JSX.Element }

/**
 * A trail of links; the last one is the current page. Every crumb truncates and carries its full label as a title;
 * earlier crumbs take at most 40% of the trail, so the current one keeps room for its first characters.
 */
export function Breadcrumb(props: { crumbs: readonly Crumb[]; class?: string }): JSX.Element {
  return (
    <nav aria-label="Breadcrumb" class={`min-w-0 ${props.class ?? ""}`}>
      <ol class="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
        <For each={props.crumbs}>
          {(crumb, index) => {
            const last = (): boolean => index() === props.crumbs.length - 1
            return (
              <li class="flex min-w-0 items-center gap-1.5" classList={{ "max-w-[40%]": !last(), "min-w-[60px]": last() }}>
                <Show when={index() > 0}>
                  <span aria-hidden="true" class="text-icon">
                    ›
                  </span>
                </Show>
                {crumb.lead}
                <a
                  href={crumb.href}
                  title={crumb.label}
                  aria-current={last() ? "page" : undefined}
                  class="min-w-0 truncate rounded-xs outline-none transition-colors duration-100 hover:text-ink focus-visible:shadow-[0_0_0_2px_var(--color-primary-soft)] aria-[current=page]:text-ink-2"
                >
                  {crumb.label}
                </a>
              </li>
            )
          }}
        </For>
      </ol>
    </nav>
  )
}
