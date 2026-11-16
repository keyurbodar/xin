import { For, Show, type JSX } from "solid-js"
import type { ConsentPermission } from "../../state/extensions.ts"
import { Button } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"
import { permissionSentence } from "./permissions.ts"

/** The market's consent prompt: what a package may do that it could not before, and why, with one action to allow it. */
export function ConsentPrompt(props: {
  subject: string
  permissions: readonly ConsentPermission[]
  action: string
  busy: boolean
  onAllow: (grant: readonly string[]) => void
  onCancel: () => void
}): JSX.Element {
  return (
    <section class="overflow-hidden rounded-md border border-working/40 bg-working-soft" role="alertdialog" aria-label={`Allow ${props.subject}`}>
      <div class="flex items-center gap-2 border-b border-line-1 px-3.5 py-2.5">
        <Glyph name="lock" size={13} class="text-working-text" />
        <span class="text-sm text-ink">What {props.subject} will be allowed to do</span>
      </div>
      <ul class="flex flex-col">
        <For each={props.permissions}>
          {(permission) => (
            <li class="flex gap-2.5 border-b border-line-1 px-3.5 py-2.5 last:border-0">
              <Glyph name="check" size={13} class="mt-[3px] shrink-0 text-ink-3" />
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm text-ink">{permissionSentence(permission.id)}</span>
                <Show when={permission.why !== ""}>
                  <span class="text-xs text-ink-3">Asked for because {permission.why}</span>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>
      <div class="flex items-center gap-2 border-t border-line-1 px-3.5 py-2.5">
        <span class="text-xs text-ink-3">
          It runs with the same access you have. This list is what it says it needs, not a limit on what it can do.
        </span>
        <span class="ml-auto" />
        <Button size="sm" variant="quiet" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={props.busy}
          onClick={() => props.onAllow(props.permissions.map((permission) => permission.id))}
        >
          {props.action}
        </Button>
      </div>
    </section>
  )
}
