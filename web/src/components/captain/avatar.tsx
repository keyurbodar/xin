import type { JSX } from "solid-js"

/** A Captain's monogram: round where a project's mark is square, so a coordinator you named reads apart from a project. */
export function CaptainAvatar(props: { name: string; size?: number | undefined; class?: string | undefined }): JSX.Element {
  const size = (): number => props.size ?? 20
  const letters = (): string =>
    props.name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toUpperCase())
      .join("") || "C"
  return (
    <span
      aria-hidden="true"
      class={`grid shrink-0 place-items-center rounded-full border border-line-2 bg-card font-medium text-ink-2 ${props.class ?? ""}`}
      style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${Math.max(8, Math.round(size() * 0.42))}px` }}
    >
      {letters()}
    </span>
  )
}
