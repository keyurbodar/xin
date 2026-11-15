import { For, type JSX } from "solid-js"
import type { ConsentPermission } from "../../state/extensions.ts"
import { Button } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

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
        <span class="text-sm text-ink">{props.subject} asks to</span>
      </div>
      <For each={props.permissions}>
        {(permission) => (
          <div class="flex flex-col gap-0.5 border-b border-line-1 px-3.5 py-2 last:border-0">
            <span class="text-sm text-ink">{permission.title}</span>
            <span class="text-xs text-ink-3">
              <code class="font-mono">{permission.id}</code>
              {permission.why === "" ? "" : ` · ${permission.why}`}
            </span>
          </div>
        )}
      </For>
      <div class="flex items-center gap-2 border-t border-line-1 px-3.5 py-2.5">
        <span class="text-xs text-ink-3">Plugins run in your Home with no sandbox. Allow only what you trust.</span>
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
