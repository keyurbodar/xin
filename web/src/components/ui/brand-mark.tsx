import type { JSX } from "solid-js"

export function BrandMark(props: { class?: string }): JSX.Element {
  return (
    <span
      role="img"
      aria-label="Ingle"
      class={`inline-block shrink-0 bg-current [mask:url(/brand/ingle-mark-20.svg)_center/contain_no-repeat] ${props.class ?? "h-5 w-5"}`}
    />
  )
}
