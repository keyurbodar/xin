import type { JSX } from "solid-js"
import { Icon, type IconName } from "../ui/icon.tsx"

const EXTRA = {
  globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M3.5 9h17", "M3.5 15h17", "M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z"],
  pencil: ["M4 20h4L20 8l-4-4L4 16v4Z", "m13.5 6.5 4 4"],
  lock: ["M6 11h12v10H6z", "M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11"],
  download: ["M12 4v11", "m7 10 5 5 5-5", "M4 20h16"],
  briefcase: ["M4 8h16v12H4z", "M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2", "M4 13h16"],
  plug: ["M9 3v5", "M15 3v5", "M7 8h10v3a5 5 0 0 1-10 0V8Z", "M12 16v5"],
  "book-open": ["M3 5h6a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H3z", "M21 5h-6a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h6z"],
  "scroll-text": ["M6 4h12v14a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2V4Z", "M9 8h6", "M9 12h6"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"],
  cpu: ["M7 7h10v10H7z", "M4 10v4", "M20 10v4", "M10 4v3", "M14 4v3", "M10 17v3", "M14 17v3"],
  "chart-column": ["M4 20h16", "M7 20v-6", "M12 20V8", "M17 20v-9"],
  user: ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
  monitor: ["M3 4h18v12H3z", "M9 20h6", "M12 16v4"],
  smartphone: ["M7 2h10v20H7z", "M11 18h2"],
  warning: ["M12 3 2.5 20h19L12 3Z", "M12 9v5", "M12 17h.01"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 11v5", "M12 8h.01"],
  package: ["M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z", "M3 7.5 12 12l9-4.5", "M12 12v9"],
  "badge-check": ["M12 2.5 15 5l3.5-.5.5 3.5 2.5 2-2 3 1 3.5-3.5 1-1.5 3.2-3.5-1.2-3 2-2.2-2.8-3.3-.7.5-3.4L2 12l2.5-2.5-.5-3.5L7.5 5 9 2.8 12 2.5Z", "m9 12 2 2 4-4"],
  terminal: ["m5 7 5 5-5 5", "M12 17h7"],
  "git-branch": ["M6 4v10", "M6 18a2 2 0 1 0 0 .01", "M18 8a2 2 0 1 0 0 .01", "M6 14a6 6 0 0 0 6-6h4"],
  table: ["M3 5h18v14H3z", "M3 10h18", "M9 10v9"],
  eye: ["M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z", "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"],
  "rotate-ccw": ["M4 12a8 8 0 1 0 2.3-5.6", "M4 4v5h5"],
  receipt: ["M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z", "M8 8h8", "M8 12h8"],
  "file-code": ["M6 3h8l4 4v14H6z", "M14 3v4h4", "m10 12-2 2 2 2", "m14 12 2 2-2 2"],
  webhook: ["M9 8a3 3 0 1 1 6 0", "M6 16a3 3 0 1 0 6 0", "M18 16a3 3 0 1 0-6 0"],
  "external-link": ["M14 4h6v6", "M20 4 11 13", "M18 14v6H4V6h6"],
  shield: ["M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z", "m9 12 2 2 4-4"],
} as const satisfies Readonly<Record<string, readonly string[]>>

export type ExtraName = keyof typeof EXTRA
export type GlyphName = IconName | ExtraName

function isExtra(name: GlyphName): name is ExtraName {
  return Object.hasOwn(EXTRA, name)
}

export function Glyph(props: { name: GlyphName; size?: number | undefined; class?: string | undefined }): JSX.Element {
  const size = props.size ?? 16
  if (isExtra(props.name)) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class={props.class ?? ""}
        aria-hidden="true"
      >
        {EXTRA[props.name].map((d) => (
          <path d={d} />
        ))}
      </svg>
    )
  }
  return <Icon name={props.name} size={size} class={props.class ?? ""} />
}
