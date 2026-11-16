import type { JSX } from "solid-js"
import "./composer.css"

/**
 * The composer card (spec §4.1 Palermo composer): an optional scope row above it, the editor, the attachments
 * strip inside the card, and a footer whose start holds
 * +, model and reasoning and whose end holds the mic, context meter and send. The card is the form: Enter in the
 * editor submits it. Its fill follows `--appearance-input-opacity` (1 when unset), so a wallpaper can show through.
 */
export function ComposerCard(props: {
  above?: JSX.Element
  attachments?: JSX.Element
  start: JSX.Element
  end: JSX.Element
  dragging?: boolean
  onSubmit: () => void
  onDragOver?: (event: DragEvent) => void
  onDragLeave?: (event: DragEvent) => void
  onDrop?: (event: DragEvent) => void
  onPaste?: (event: ClipboardEvent) => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="mx-auto w-full max-w-[var(--w-column)]">
      {props.above}
      <form
        class="rounded-lg bg-[color-mix(in_oklch,var(--color-card)_calc(var(--appearance-input-opacity,1)*100%),transparent)] shadow-composer transition-shadow duration-[var(--dur-fast)]"
        classList={{ "shadow-[0_0_0_1px_var(--color-primary)]": props.dragging === true }}
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit()
        }}
        onDragOver={(event) => props.onDragOver?.(event)}
        onDragLeave={(event) => props.onDragLeave?.(event)}
        onDrop={(event) => props.onDrop?.(event)}
        oncapture:paste={(event) => props.onPaste?.(event)}
      >
        {props.children}
        {props.attachments}
        <div class="flex items-center gap-0.5 px-2 pb-2 pt-1">
          {props.start}
          <div class="ml-auto flex items-center gap-1.5">{props.end}</div>
        </div>
      </form>
    </div>
  )
}
