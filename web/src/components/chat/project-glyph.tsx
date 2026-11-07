import type { JSX } from "solid-js"
import { projectIcon } from "../../lib/project-icon.ts"
import { Icon } from "../ui/icon.tsx"

export function ProjectGlyph(props: { slug: string; class?: string }): JSX.Element {
  return (
    <span
      class={`grid h-6 w-6 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2 ${props.class ?? ""}`}
    >
      <Icon name={projectIcon(props.slug)} size={14} />
    </span>
  )
}
