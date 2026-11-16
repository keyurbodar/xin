import { expect, test } from "bun:test"
import { contrast, parseColor } from "./color.ts"
import {
  DEFAULT_APPEARANCE,
  fromLegacyTheme,
  INGLE_DARK,
  INGLE_LIGHT,
  parseAppearance,
  pickedInMenu,
  tokensOf,
  withCatalogTheme,
  type CustomTheme,
  type Palette,
} from "./model.ts"

const rgb = (value: string | undefined) => {
  const parsed = parseColor(value ?? "")
  if (parsed === undefined) throw new Error(`not a colour: ${value}`)
  return parsed
}

const PALETTES: readonly (readonly [string, Palette, "light" | "dark"])[] = [
  ["ingle dark", INGLE_DARK, "dark"],
  ["ingle light", INGLE_LIGHT, "light"],
  ["low-contrast dark pick", { accent: "#222244", background: "#101010", foreground: "#333333" }, "dark"],
  ["low-contrast light pick", { accent: "#eeeeff", background: "#f4f4f4", foreground: "#cccccc" }, "light"],
  ["saturated", { accent: "#ff00aa", background: "#001a33", foreground: "#88ccff" }, "dark"],
]

for (const [name, palette, variant] of PALETTES)
  test(`derived text passes WCAG AA on the background: ${name}`, () => {
    const tokens = tokensOf(palette, variant)
    const bg = rgb(tokens["bg"])
    expect(contrast(rgb(tokens["ink"]), bg)).toBeGreaterThanOrEqual(7)
    expect(contrast(rgb(tokens["ink-2"]), bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(tokens["ink-3"]), bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(tokens["accent-ink"]), bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(rgb(tokens["on-accent"]), rgb(tokens["accent"]))).toBeGreaterThanOrEqual(3)
  })

test("an empty or hostile doc parses to the defaults, keeping Ingle's own theme", () => {
  expect(parseAppearance({})).toEqual(DEFAULT_APPEARANCE)
  expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE)
  const parsed = parseAppearance({
    mode: "sepia",
    ui: { textScale: 900, sidebar: -4 },
    background: { blur: 999, effect: "melt", image: { url: "javascript:alert(1)" } },
    custom: [{ id: "bad id!", label: "x" }],
  })
  expect(parsed.mode).toBe("dark")
  expect(parsed.theme).toBe("ingle")
  expect(parsed.ui.textScale).toBe(125)
  expect(parsed.ui.sidebar).toBe(200)
  expect(parsed.background.blur).toBe(24)
  expect(parsed.background.effect).toBe("dither")
  expect(parsed.background.image).toBeUndefined()
  expect(parsed.custom).toEqual([])
})

test("a custom theme keeps valid colours and repairs invalid ones from Ingle's palette", () => {
  const parsed = parseAppearance({
    custom: [{ id: "mine", label: "Mine", dark: { accent: "#ABCDEF", background: "nope", foreground: "#eee" } }],
  })
  expect(parsed.custom[0]?.dark).toEqual({ accent: "#abcdef", background: INGLE_DARK.background, foreground: "#eee" })
  expect(parsed.custom[0]?.light).toEqual(INGLE_LIGHT)
})

test("a translucent colour cannot slip past the contrast guarantee", () => {
  const parsed = parseAppearance({
    custom: [{ id: "clear", label: "Clear", dark: { accent: "#3168f2", background: "#0a0a0b00", foreground: "#ececed00" } }],
  })
  expect(parsed.custom[0]?.dark).toEqual(INGLE_DARK)
})

test("a wallpaper loads only from this home's share links or an inline image, never a third party", () => {
  const image = (url: string) => parseAppearance({ background: { image: { url } } }).background.image
  expect(image("/s/abc123/wall.png")?.url).toBe("/s/abc123/wall.png")
  expect(image("data:image/png;base64,AAAA")?.url).toBe("data:image/png;base64,AAAA")
  expect(image("https://tracker.example/pixel.png")).toBeUndefined()
  expect(image("//tracker.example/pixel.png")).toBeUndefined()
  expect(image("/v1/ops")).toBeUndefined()
})

test("the first load after upgrading keeps the theme the old picker stored", () => {
  expect(fromLegacyTheme(null)).toEqual(DEFAULT_APPEARANCE)
  expect(fromLegacyTheme("dark")).toEqual(DEFAULT_APPEARANCE)
  expect(fromLegacyTheme("light")).toMatchObject({ mode: "light", theme: "ingle" })
  expect(fromLegacyTheme("rose")).toMatchObject({ mode: "dark", theme: "rose" })
})

test("Light or Dark from the owner menu sets the mode, and any other theme sets the theme", () => {
  const custom = { ...DEFAULT_APPEARANCE, theme: "custom:mine" }
  expect(pickedInMenu(custom, "light")).toMatchObject({ mode: "light", theme: "ingle" })
  expect(pickedInMenu({ ...DEFAULT_APPEARANCE, mode: "light" }, "dark")).toMatchObject({ mode: "dark", theme: "ingle" })
  expect(pickedInMenu(DEFAULT_APPEARANCE, "rose")).toMatchObject({ mode: "dark", theme: "rose" })
})

test("adding a catalogue theme twice keeps one copy and applies it both times", () => {
  const fjord: CustomTheme = { id: "fjord", label: "Fjord", source: "explore:fjord", dark: INGLE_DARK, light: INGLE_LIGHT }
  const once = withCatalogTheme(DEFAULT_APPEARANCE, fjord, "fjord-1a2b3c")
  expect(once.custom.map((theme) => theme.id)).toEqual(["fjord-1a2b3c"])
  expect(once.theme).toBe("custom:fjord-1a2b3c")
  const twice = withCatalogTheme({ ...once, theme: "ingle" }, fjord, "fjord-9z9z9z")
  expect(twice.custom.map((theme) => theme.id)).toEqual(["fjord-1a2b3c"])
  expect(twice.theme).toBe("custom:fjord-1a2b3c")
})
