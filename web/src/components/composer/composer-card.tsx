import { Show, type JSX } from "solid-js"
import "./composer.css"

/**
 * The composer card (spec §4.1 Palermo composer): an optional scope row above it, a surface attached to its top
 * for queue and usage notices, the editor, the attachments strip inside the card, and a footer whose start holds
 * +, model and reasoning and whose end holds the mic, context meter and send. The card is the form: Enter in the
 * editor submits it.
 */
export function ComposerCard(props: {
  above?: JSX.Element
  top?: JSX.Element
  attachments?: JSX.Element
  start: JSX.Element
  end: JSX.Element
  dragging?: boolean
  onSubmit: () => void
  onDragOver?: (event: DragEvent) => void
  onDragLeave?: (event: DragEvent) => void
  onDrop?: (event: DragEvent) => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="mx-auto w-full max-w-[var(--w-column)]">
      {props.above}
      <Show when={props.top}>
        <div class="mx-3 rounded-t-md bg-secondary px-3 py-1.5 text-mini text-ink-2 shadow-ring">{props.top}</div>
      </Show>
      <form
        class="rounded-lg bg-card shadow-composer transition-shadow duration-[var(--dur-fast)]"
        classList={{ "shadow-[0_0_0_1px_var(--color-primary)]": props.dragging === true }}
        onSubmit={(event) => {
          event.preventDefault()
          props.onSubmit()
        }}
        onDragOver={(event) => props.onDragOver?.(event)}
        onDragLeave={(event) => props.onDragLeave?.(event)}
        onDrop={(event) => props.onDrop?.(event)}
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
