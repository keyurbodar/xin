import type { JSX } from "solid-js"
import { ChevronRight, Files } from "lucide-solid"
import { showPaneView } from "../../state/tabs.ts"
import { Kiko } from "../ui/kiko.tsx"
import type { PaneContext } from "./overview.tsx"

/** A project with nothing in it yet: Kiko afloat, then a card per place to start. Ingle has no diffs or shell, so Files is the one card. */
export function OverviewEmpty(props: PaneContext): JSX.Element {
  return (
    <div class="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-10">
      <Kiko scene="boat" />
      <div class="flex w-full max-w-[320px] flex-col gap-2">
        <button
          type="button"
          onClick={() => showPaneView(props.project.id, "files")}
          class="im-press flex w-full items-center gap-3 rounded-lg border border-line-1 bg-card px-3 py-3 text-left outline-none hover:border-line-2 focus-visible:ring-2 focus-visible:ring-primary-soft"
        >
          <span class="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-ink-2">
            <Files size={16} stroke-width={1.5} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-base text-ink">Files</span>
            <span class="block text-sm text-ink-3">Nothing in Drive yet</span>
          </span>
          <ChevronRight size={14} stroke-width={1.5} class="shrink-0 text-icon" />
        </button>
      </div>
    </div>
  )
}
