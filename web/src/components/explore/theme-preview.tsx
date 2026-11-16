import type { JSX } from "solid-js"
import { tokensOf, type Effect, type Palette, type Variant } from "../../appearance/model.ts"

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E\")"

function effectLayer(effect: Effect, accent: string): JSX.CSSProperties | undefined {
  switch (effect) {
    case "none":
      return undefined
    case "dither":
      return {
        "background-image": `radial-gradient(circle, ${accent} 0.9px, transparent 1.2px)`,
        "background-size": "5px 5px",
        "mask-image": "linear-gradient(135deg, black, transparent 70%)",
        opacity: "0.55",
      }
    case "grain":
      return { "background-image": GRAIN, "mix-blend-mode": "overlay", opacity: "0.6" }
    case "vignette":
      return { "background-image": "radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,.5))" }
  }
}

/** A miniature app drawn in a theme's colours: wallpaper, sidebar, a thread and a composer, all CSS. */
export function ThemePreview(props: {
  palette: Palette
  variant: Variant
  effect: Effect
  label: string
  class?: string | undefined
}): JSX.Element {
  const tokens = () => tokensOf(props.palette, props.variant)
  const t = (key: string): string => tokens()[key] ?? "transparent"
  const wallpaper = (): string =>
    `radial-gradient(120% 90% at 85% 10%, color-mix(in oklab, ${t("accent")} 38%, ${t("bg")}), transparent 60%), radial-gradient(90% 80% at 0% 100%, color-mix(in oklab, ${t("accent")} 16%, ${t("bg")}), ${t("bg")})`
  return (
    <div
      role="img"
      aria-label={`${props.label}, ${props.variant} preview`}
      class={`relative aspect-[16/10] w-full overflow-hidden rounded-md ${props.class ?? ""}`}
      style={{ background: wallpaper() }}
    >
      <div class="pointer-events-none absolute inset-0" style={effectLayer(props.effect, t("accent"))} />
      <div
        class="absolute bottom-0 right-0 flex h-[72%] w-[78%] overflow-hidden rounded-tl-md"
        style={{ background: t("bg"), "box-shadow": `0 0 0 0.5px ${t("line-2")}, 0 8px 30px rgba(0,0,0,.25)` }}
      >
        <div class="flex w-[26%] flex-col gap-[6%] px-[4%] pt-[6%]" style={{ background: t("panel") }}>
          <span class="h-[5%] w-[70%] rounded-full" style={{ background: t("ink-2") }} />
          <span class="h-[5%] w-[55%] rounded-full" style={{ background: t("ink-3") }} />
          <span class="h-[5%] w-[62%] rounded-full" style={{ background: t("hover") }} />
          <span class="h-[5%] w-[48%] rounded-full" style={{ background: t("ink-3") }} />
        </div>
        <div class="relative flex flex-1 flex-col gap-[5%] px-[6%] pt-[7%]">
          <span class="h-[5%] w-[52%] rounded-full" style={{ background: t("ink") }} />
          <span class="h-[4%] w-[80%] rounded-full" style={{ background: t("ink-3") }} />
          <span class="h-[4%] w-[66%] rounded-full" style={{ background: t("ink-3") }} />
          <span
            class="ml-auto mt-[3%] h-[12%] w-[46%] rounded-sm"
            style={{ background: t("card"), "box-shadow": `0 0 0 0.5px ${t("line-2")}` }}
          />
          <div
            class="absolute bottom-[8%] left-[6%] right-[6%] flex h-[18%] items-center justify-end rounded-md px-[3%]"
            style={{ background: t("card"), "box-shadow": `0 0 0 0.5px ${t("line-2")}` }}
          >
            <span class="aspect-square h-[55%] rounded-full" style={{ background: t("accent") }} />
          </div>
        </div>
      </div>
    </div>
  )
}

export function Swatch(props: { palette: Palette }): JSX.Element {
  return (
    <span class="inline-flex h-3.5 w-6 shrink-0 overflow-hidden rounded-full shadow-ring" aria-hidden="true">
      <span class="flex-1" style={{ background: props.palette.background }} />
      <span class="flex-1" style={{ background: props.palette.accent }} />
    </span>
  )
}
