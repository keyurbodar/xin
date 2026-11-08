import type { JSX } from "solid-js"

const PATHS: Readonly<Record<string, readonly string[]>> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5", "M9.5 21v-6h5v6"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5Z"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-3.5-3.5"],
  grid: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  plus: ["M12 5v14", "M5 12h14"],
  settings: [
    "M12.2 3h-.4a1.9 1.9 0 0 0-1.9 1.9v.4a1.9 1.9 0 0 1-2.9 1.6l-.3-.2a1.9 1.9 0 0 0-2.6.7l-.2.4a1.9 1.9 0 0 0 .7 2.6l.3.2a1.9 1.9 0 0 1 0 3.3l-.3.2a1.9 1.9 0 0 0-.7 2.6l.2.4a1.9 1.9 0 0 0 2.6.7l.3-.2a1.9 1.9 0 0 1 2.9 1.6v.4A1.9 1.9 0 0 0 11.8 21h.4a1.9 1.9 0 0 0 1.9-1.9v-.4a1.9 1.9 0 0 1 2.9-1.6l.3.2a1.9 1.9 0 0 0 2.6-.7l.2-.4a1.9 1.9 0 0 0-.7-2.6l-.3-.2a1.9 1.9 0 0 1 0-3.3l.3-.2a1.9 1.9 0 0 0 .7-2.6l-.2-.4a1.9 1.9 0 0 0-2.6-.7l-.3.2a1.9 1.9 0 0 1-2.9-1.6v-.4A1.9 1.9 0 0 0 12.2 3Z",
    "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  ],
  calendar: ["M4 5h16v16H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  "chevron-right": ["m9 5 7 7-7 7"],
  "circle-x": ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "m9 9 6 6", "m15 9-6 6"],
  "chevron-down": ["m5 9 7 7 7-7"],
  "chevron-left": ["m15 5-7 7 7 7"],
  "arrow-up": ["M12 20V4", "m5 11 7-7 7 7"],
  "arrow-right": ["M4 12h16", "m13 5 7 7-7 7"],
  paperclip: [
    "M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3 3 0 0 1 4.3 4.3l-7.5 7.5a1.5 1.5 0 0 1-2.1-2.1l6.8-6.8",
  ],
  layers: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 13 9 5 9-5", "m3 17 9 5 9-5"],
  code: ["m9 8-5 4 5 4", "m15 8 5 4-5 4"],
  check: ["m5 12 5 5L20 7"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  folder: ["M3 6h6l2 3h10v11H3z"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "M12 8v4.5l3 2"],
  square: ["M5 5h14v14H5z"],
  stop: ["M6 6h12v12H6z"],
  play: ["m8 5 11 7-11 7z"],
  panel: ["M3 4h18v16H3z", "M15 4v16"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  refresh: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v5h-5"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  pin: [
    "M12 17v5",
    "M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ],
  pencil: ["M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z", "m15 5 4 4"],
  message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  upload: ["M12 20V8", "m7 13 5-5 5 5", "M4 4h16"],
  link: ["M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1", "M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"],
  sliders: ["M4 8h10", "M18 8h2", "M4 16h4", "M12 16h8", "M14 5v6", "M8 13v6"],
  bell: ["M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7", "M10.5 20a1.8 1.8 0 0 0 3 0"],
  brain: ["M9.5 4a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 5 11v2a2.5 2.5 0 0 0 2 2.4A2.5 2.5 0 0 0 9.5 20H12V4H9.5Z", "M14.5 4A2.5 2.5 0 0 1 17 6.5 2.5 2.5 0 0 1 19 11v2a2.5 2.5 0 0 1-2 2.4A2.5 2.5 0 0 1 14.5 20H12V4h2.5Z"],
  users: ["M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M2 20a6 6 0 0 1 12 0", "M16 4.5a3.5 3.5 0 0 1 0 7", "M18 20a6 6 0 0 0-2-4.5"],
  image: ["M3 5h18v14H3z", "M3 15l4.5-4.5 4 4 3-3L21 17", "M8.5 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  key: ["M14 4a6 6 0 1 0-5.2 8.9L4 17.7V20h2.3l1-1v-2h2v-2h2l1.6-1.6A6 6 0 0 0 14 4Z", "M16.5 7.5h.01"],
}

export type IconName = keyof typeof PATHS

export function Icon(props: { name: IconName; size?: number; class?: string; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      {(PATHS[props.name] ?? []).map((d) => (
        <path d={d} />
      ))}
    </svg>
  )
}
