import type { JSX } from "solid-js"

const KIKO =
  '<path d="M31 95c-5 0-7-3-6.6-8C26.2 66 40.5 53 60 53s33.8 13 35.6 34c.4 5-1.6 8-6.6 8z"/>' +
  '<path d="M48.5 57.5c4-12-6-22-15-26-3 10 3 22 15 26z"/><path d="M68 55.5c12-6 14-21 8-34-11 7-14 22-8 34z"/>' +
  '<circle cx="46.4" cy="74" r="2.6"/><circle cx="70.6" cy="72.6" r="2.6"/><path d="M55 82c2 2 5 2 7 0"/>'

const kiko = (x: number, y: number, scale: number): string => `<g transform="translate(${x} ${y}) scale(${scale}) translate(-20 -16)">${KIKO}</g>`

const WAVE = "c6-3 12-3 18 0s12 3 18 0 12-3 18 0 12 3 18 0"

/** Hairline scenes of Kiko, Ingle's mark, for the empty pane views; 1px currentColor strokes that stay 1px at any size. */
const SCENES = {
  boat:
    `<path d="M101 18v58M103 24l24 46h-24z"/><path d="M107 40l5 10M106 50l9 16" class="h"/>` +
    kiko(46, 22, 0.62) +
    `<path d="M28 76h102l-13 17H42z"/><path d="M36 83h86" class="h"/><circle cx="52" cy="85" r="2.5"/>` +
    `<path d="M14 100${WAVE}"/><path d="M48 108${WAVE}" class="h"/>`,
  folder:
    `<path d="M30 52h36l8 8h56v46H30z"/>` + kiko(58, 18, 0.55) + `<path d="M26 70h108l-5 36H31z"/><path d="M40 88h40" class="h"/>`,
  calendar:
    `<path d="M88 34h44v42H88zM88 46h44M98 28v10M122 28v10"/><path d="M96 56h6M108 56h6M120 56h6M96 66h6" class="h"/>` +
    kiko(28, 30, 0.62) +
    `<path d="M22 92h116"/><path d="M40 100h80" class="h"/>`,
} as const

export type KikoScene = keyof typeof SCENES

export function Kiko(props: { scene: KikoScene; class?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 160 120"
      width="160"
      height="120"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={`kiko text-icon [&_*]:[vector-effect:non-scaling-stroke] [&_.h]:opacity-60 ${props.class ?? ""}`}
      innerHTML={SCENES[props.scene]}
    />
  )
}
