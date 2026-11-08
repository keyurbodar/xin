import type { JSX } from "solid-js"

/** I4: a 64 grid, a 1.5px stroke that never scales, one orange detail, and one small loop per drawing. */
export const PICTOGRAMS = {
  threads:
    '<circle class="l" cx="13" cy="32" r="5"/><path class="l" d="M18 32h26M24 32c9 0 9-14 20-14M24 32c9 0 9 14 20 14"/><circle class="l m-pop" style="animation-delay:.12s" cx="49" cy="18" r="4"/><circle class="a m-pop" cx="49" cy="32" r="4"/><circle class="l m-pop" style="animation-delay:.24s" cx="49" cy="46" r="4"/>',
  report:
    '<path class="l" d="M16 8h22l10 10v38H16z"/><path class="l" d="M38 8v10h10M22 22h12M22 28h18M22 50h20"/><path class="l m-bar" style="stroke-linecap:butt" d="M26 48v-8"/><path class="a m-bar" style="stroke-linecap:butt;animation-delay:.12s" d="M32 48v-13"/><path class="l m-bar" style="stroke-linecap:butt;animation-delay:.24s" d="M38 48v-17"/>',
  question:
    '<path class="l" d="M10 12h44v28H30l-8 8v-8H10z"/><g class="m-tilt" style="transform-origin:32px 26px"><path class="a" d="M28 22.5a4 4 0 1 1 5.6 3.7c-1 .5-1.6 1.2-1.6 2.3v1"/><circle class="af" cx="32" cy="33.4" r="1"/></g>',
  files:
    '<path class="l" d="M14 10h24v32H14z"/><g class="m-slide"><path class="k" d="M22 18h26v34H22z"/><path class="l" d="M27 27h16M27 33h16"/><path class="a" d="M27 39h10"/></g>',
  folder:
    '<path class="l" d="M10 16h16l4 4h24v32H10z"/><g class="m-peek"><path class="k" d="M16 18h32v20H16z"/><path class="a" d="M21 24h16"/></g><path class="k" d="M8 30h48l-2 22H10z"/>',
  memory:
    '<path class="l" d="M16 8h32v48H16zM22 8v48M27 20h14M27 26h9M27 32h14M27 38h6"/><path class="a m-swing" style="transform-origin:41px 8px" d="M38 8v16l3-3 3 3V8"/>',
  schedules:
    '<path class="l" d="M6 14h30v30H6zM6 22h30M13 10v8M29 10v8"/><g class="lf"><circle cx="13" cy="29" r="1"/><circle cx="21" cy="29" r="1"/><circle cx="29" cy="29" r="1"/><circle cx="13" cy="37" r="1"/><circle cx="21" cy="37" r="1"/></g><circle class="l" cx="49" cy="44" r="10"/><path class="l" d="M49 44h4"/><path class="a m-spin" style="transform-origin:49px 44px" d="M49 44v-6.5"/>',
  jobs:
    '<path class="l" d="M8 14h48v36H8z"/><circle class="lf" cx="15" cy="23" r="2.5"/><path class="l" d="M21 23h26"/><circle class="l m-spinf" cx="15" cy="32" r="2.5" style="stroke-dasharray:10 6"/><path class="l" d="M21 32h20"/><path class="dim l" d="M14 42h36"/><path class="a m-fill" d="M14 42h36"/>',
  extensions:
    '<path class="l" d="M14 20v22l18 10 18-10V20M32 30v22M14 20l18 10 18-10"/><g class="m-lift"><path class="k" d="M14 20l18-10 18 10-18 10z"/><path class="a" d="M23 15l18 10"/></g>',
  connectors:
    '<path class="l" d="M36 20h16v24H36zM52 32h6"/><circle class="a m-led" cx="46" cy="27" r="2"/><g class="m-plug"><path class="l" d="M12 24h14v16H12zM26 28h6M26 36h6M6 32h6"/></g>',
  push:
    '<g class="m-ring" style="transform-origin:32px 14px"><path class="l" d="M22 40V29a10 10 0 0 1 20 0v11l3 4H19zM29 48a3 3 0 0 0 6 0M32 14v5"/></g><path class="a m-wave" d="M47 20a9 9 0 0 1 3 8"/><path class="a m-wave" style="animation-delay:.25s" d="M51 15a15 15 0 0 1 5 13"/>',
  search:
    '<g class="m-scan"><circle class="l" cx="27" cy="27" r="11"/><path class="l" d="M35 35l11 11"/><path class="a" d="M21 25a6.5 6.5 0 0 1 4-4.5"/></g>',
  offline:
    '<path class="l m-drift" d="M18 44h28a9 9 0 0 0 0-18 13 13 0 0 0-25-2 8 8 0 0 0-3 20z"/><path class="a m-draw" pathLength="1" d="M12 14l40 36"/>',
  usage:
    '<path class="l" d="M12 44a20 20 0 0 1 40 0M32 24v4M18 30l3 3M46 30l-3 3M12 50h40"/><path class="a m-needle" d="M32 44V30"/><circle class="lf" cx="32" cy="44" r="2"/>',
  secrets:
    '<g class="m-key"><circle class="l" cx="18" cy="32" r="8"/><circle class="a" cx="18" cy="32" r="2.5"/><path class="l" d="M26 32h22M44 32v6M38 32v4"/></g><path class="l" d="M54 22v20"/>',
  inbox:
    '<path class="l" d="M8 36h14l3 6h14l3-6h14v16H8z"/><g class="m-drop"><path class="a" d="M32 10v18M25 21l7 7 7-7"/></g>',
} as const

export type PictogramName = keyof typeof PICTOGRAMS

export function Pictogram(props: { name: PictogramName; size?: number; class?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      width={props.size ?? 88}
      height={props.size ?? 88}
      class={`pictogram ${props.class ?? ""}`}
      aria-hidden="true"
      innerHTML={PICTOGRAMS[props.name]}
    />
  )
}
