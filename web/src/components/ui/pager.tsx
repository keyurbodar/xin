import "@ui-sdk/web/pagination"
import { Show, type JSX } from "solid-js"
import { PAGE_SIZE } from "../../lib/pages.ts"

const STEP =
  "im-hover h-[var(--h-control-sm)] rounded-sm px-2 text-small text-ink-2 outline-none focus-visible:outline-2 focus-visible:outline-primary data-[disabled]:pointer-events-none data-[disabled]:text-icon"

/** `Previous · 1 of N · Next` on UI SDK Pagination: text steps that disable at the ends, no numbered pages, and nothing at all for one page. */
export function Pager(props: { label: string; total: number; page: number; onPage: (page: number) => void; size?: number }): JSX.Element {
  const size = (): number => props.size ?? PAGE_SIZE
  const count = (): number => Math.max(1, Math.ceil(props.total / size()))
  return (
    <Show when={count() > 1}>
      <ui-pagination
        aria-label={props.label}
        total={props.total}
        page-size={size()}
        prop:page={Math.min(props.page, count())}
        on:pagechange={(event) => props.onPage(event.detail.value)}
        class="block"
      >
        <ui-pagination-list class="flex items-center justify-center gap-1">
          <ui-pagination-item>
            <ui-pagination-previous>
              <button type="button" class={STEP}>
                Previous
              </button>
            </ui-pagination-previous>
          </ui-pagination-item>
          <ui-pagination-item>
            <span class="px-1 font-mono text-micro text-ink-3">
              {Math.min(props.page, count())} of {count()}
            </span>
          </ui-pagination-item>
          <ui-pagination-item>
            <ui-pagination-next>
              <button type="button" class={STEP}>
                Next
              </button>
            </ui-pagination-next>
          </ui-pagination-item>
        </ui-pagination-list>
      </ui-pagination>
    </Show>
  )
}
