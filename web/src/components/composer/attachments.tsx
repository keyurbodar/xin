import type { JSX } from "solid-js"
import { createAttachments, type ComposerAttachment, type Upload } from "../../lib/attachments.ts"
import { AttachmentCardGrid } from "./attachment-card.tsx"

export type { Upload }

export const useAttachments = createAttachments

/** The composer's files: the card grid between the field and the toolbar, handing focus back to the field when the last card goes. */
export function AttachmentGrid(props: { items: readonly ComposerAttachment[]; onRemove: (id: string) => void }): JSX.Element {
  let wrapper: HTMLDivElement | undefined
  return (
    <div ref={wrapper} class="max-w-[680px] px-3 pb-1 pt-1" classList={{ hidden: props.items.length === 0 }}>
      <AttachmentCardGrid
        items={props.items}
        onRemove={props.onRemove}
        fallbackFocus={() => wrapper?.parentElement?.querySelector("textarea") ?? undefined}
      />
    </div>
  )
}
