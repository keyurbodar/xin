import { FolderClosed } from "lucide-solid"
import type { JSX } from "solid-js"

/** Where a new thread will run, above the composer of an empty conversation: its project. */
export function ScopeChips(props: { project: string }): JSX.Element {
  return (
    <div class="flex items-center gap-1 px-2 pb-2" aria-label="Thread scope" role="group">
      <span class="inline-flex h-[var(--h-control-sm)] items-center gap-1.5 rounded-full px-2.5 text-small text-ink-2">
        <FolderClosed size={14} stroke-width={1.5} class="text-icon" />
        {props.project}
      </span>
    </div>
  )
}
