import { For, type JSX } from "solid-js"
import { navigate } from "../../lib/router.ts"
import { Pictogram } from "../ui/pictogram.tsx"

export function EmptyInbox(): JSX.Element {
  return (
    <div class="flex flex-col items-center rounded-[4px] border border-dashed border-line-inner px-6 py-16 text-center">
      <Pictogram name="inbox" size={88} />
      <span class="mt-5 text-[13px] font-medium text-fg-2">Nothing waits on you</span>
      <span class="mt-1.5 max-w-[380px] text-[12.5px] leading-[1.5] text-fg-3">
        Questions from threads, and threads that failed, land here until you answer them.
      </span>
      <button type="button" class="link mt-4" onClick={() => navigate("/")}>
        Back to home
      </button>
    </div>
  )
}

export function LoadingInbox(): JSX.Element {
  return (
    <div class="flex flex-col overflow-hidden rounded-[4px] border border-line">
      <For each={[0, 1, 2]}>
        {(index) => (
          <div class="flex items-center gap-3 border-b border-line bg-raised px-3.5 py-4 last:border-0">
            <span class="h-4 w-4 shrink-0 rounded-[2px] bg-line-inner" />
            <span class="min-w-0 flex-1">
              <span class="block h-3 rounded-[1px] bg-line-inner" classList={{ "w-[52%]": index === 0, "w-[38%]": index === 1, "w-[45%]": index === 2 }} />
              <span class="mt-2 block h-2.5 w-[28%] rounded-[1px] bg-line" />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
