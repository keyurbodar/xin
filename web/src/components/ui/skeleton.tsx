import { For, Show, type JSX } from "solid-js"

export function Loading(props: { when: boolean; skeleton: JSX.Element; label: string; children: JSX.Element }): JSX.Element {
  return (
    <Show
      when={!props.when}
      fallback={
        <div role="status" aria-busy="true" aria-label={props.label}>
          {props.skeleton}
        </div>
      }
    >
      <div class="im-content">{props.children}</div>
    </Show>
  )
}

export function Bar(props: { width: string; class?: string }): JSX.Element {
  return <span class={`im-skeleton block ${props.class ?? "h-2.5"}`} style={{ width: props.width }} />
}

function Dot(props: { class: string }): JSX.Element {
  return <span class={`im-skeleton block shrink-0 rounded-full! ${props.class}`} />
}

const TITLE = ["58%", "72%", "46%", "64%"]
const META = ["24%", "18%", "28%", "20%"]

export function RowSkeleton(props: { rows: number }): JSX.Element {
  return (
    <div class="flex flex-col">
      <For each={Array.from({ length: props.rows }, (_, index) => index)}>
        {(index) => (
          <div class="flex h-[46px] items-center gap-2.5 px-3">
            <Dot class="h-4 w-4" />
            <span class="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar width={TITLE[index % TITLE.length] ?? "60%"} />
              <Bar width={META[index % META.length] ?? "24%"} class="h-2" />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

export function PaneSkeleton(props: { rows: number }): JSX.Element {
  return (
    <div class="flex flex-col gap-1 p-2">
      <div class="flex h-7 items-center justify-between rounded-sm bg-card px-2">
        <Bar width="22%" class="h-2" />
        <Bar width="20px" class="h-2" />
      </div>
      <RowSkeleton rows={props.rows} />
    </div>
  )
}

export function ThreadSkeleton(): JSX.Element {
  return (
    <div class="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-6 pb-6 pt-7">
      <div class="flex gap-3">
        <Dot class="h-6 w-6" />
        <div class="flex flex-1 flex-col gap-2.5 pt-1">
          <Bar width="68%" class="h-3" />
          <Bar width="94%" />
          <Bar width="56%" />
        </div>
      </div>
      <span class="im-skeleton block h-16 w-full rounded-md!" />
      <div class="flex justify-center">
        <Bar width="44%" class="h-2" />
      </div>
      <div class="flex gap-3">
        <Dot class="h-6 w-6" />
        <div class="flex flex-1 flex-col gap-2.5 pt-1">
          <Bar width="84%" class="h-3" />
          <Bar width="72%" />
        </div>
      </div>
    </div>
  )
}
