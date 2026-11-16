import { FolderClosed, Laptop } from "lucide-solid"
import { Show, type JSX } from "solid-js"

export type DeviceScope = { readonly name: string; readonly online: boolean }

const CHIP = "inline-flex h-[var(--h-control-sm)] items-center gap-1.5 rounded-full px-2.5 text-small text-ink-2"

/** Where a new thread will run, above the composer of an empty thread: its project and, once Ingle knows one, its device. */
export function ScopeChips(props: { project: string; device?: DeviceScope | undefined }): JSX.Element {
  return (
    <div class="flex items-center gap-1 px-2 pb-2" aria-label="Thread scope" role="group">
      <span class={CHIP}>
        <FolderClosed size={14} stroke-width={1.5} class="text-icon" />
        {props.project}
      </span>
      <Show when={props.device}>
        {(device) => (
          <span class={CHIP}>
            <Laptop size={14} stroke-width={1.5} class="text-icon" />
            {device().name}
            <span
              aria-label={device().online ? "online" : "offline"}
              class="h-1.5 w-1.5 rounded-full"
              classList={{ "bg-done": device().online, "bg-ink-3": !device().online }}
            />
          </span>
        )}
      </Show>
    </div>
  )
}
