export type ThemeEffect = "none" | "dither" | "grain" | "vignette"

/** The three colours Settings → Appearance derives every other token from. */
export type ThemePalette = { readonly accent: string; readonly background: string; readonly foreground: string }

export type CatalogTheme = {
  readonly id: string
  readonly label: string
  readonly author: string
  readonly category: string
  readonly description: string
  readonly scheme: "dark" | "light"
  readonly effect: ThemeEffect
  readonly dark: ThemePalette
  readonly light: ThemePalette
}

export const THEMES: readonly CatalogTheme[] = [
  {
    id: "ember",
    label: "Ember",
    author: "Ingle",
    category: "Warm",
    description: "Charcoal and banked-fire orange, with a light film grain over the wallpaper.",
    scheme: "dark",
    effect: "grain",
    dark: { accent: "#e8743b", background: "#120d0a", foreground: "#f1e7df" },
    light: { accent: "#c4541f", background: "#fbf6f1", foreground: "#2a1d16" },
  },
  {
    id: "fjord",
    label: "Fjord",
    author: "Ingle",
    category: "Cool",
    description: "Deep slate water and a clear northern blue. Quiet enough for long sessions.",
    scheme: "dark",
    effect: "none",
    dark: { accent: "#4f9fe0", background: "#0b1117", foreground: "#e3ebf2" },
    light: { accent: "#2a6fb4", background: "#f4f7fa", foreground: "#16212c" },
  },
  {
    id: "lichen",
    label: "Lichen",
    author: "Ingle",
    category: "Natural",
    description: "Grey-green stone with a soft moss accent and an ordered dither screen.",
    scheme: "dark",
    effect: "dither",
    dark: { accent: "#9fbf6a", background: "#0e110f", foreground: "#e2e8df" },
    light: { accent: "#5a7a2a", background: "#f3f5f0", foreground: "#1c2219" },
  },
  {
    id: "dune",
    label: "Dune",
    author: "Ingle",
    category: "Warm",
    description: "Sun-bleached sand, dark umber ink and a burnt-sienna accent.",
    scheme: "light",
    effect: "vignette",
    dark: { accent: "#d9864a", background: "#17120c", foreground: "#efe4d3" },
    light: { accent: "#a65b24", background: "#f6efe3", foreground: "#2b241b" },
  },
  {
    id: "quire",
    label: "Quire",
    author: "Ingle",
    category: "Paper",
    description: "Bright stock and blue-black ink, like a freshly printed page.",
    scheme: "light",
    effect: "none",
    dark: { accent: "#7d8cf0", background: "#0f1014", foreground: "#e8e9ee" },
    light: { accent: "#3346c8", background: "#fafaf7", foreground: "#14161c" },
  },
  {
    id: "nocturne",
    label: "Nocturne",
    author: "Ingle",
    category: "Cool",
    description: "Midnight violet with a lavender accent and a soft vignette.",
    scheme: "dark",
    effect: "vignette",
    dark: { accent: "#a385f0", background: "#0f0c16", foreground: "#e9e4f3" },
    light: { accent: "#6a48c9", background: "#f8f6fc", foreground: "#1f1830" },
  },
  {
    id: "saffron",
    label: "Saffron",
    author: "Ingle",
    category: "Warm",
    description: "Cream paper with a saffron accent and a fine grain.",
    scheme: "light",
    effect: "grain",
    dark: { accent: "#e7a91c", background: "#14110a", foreground: "#f0e9d6" },
    light: { accent: "#9a6a00", background: "#fbf8ee", foreground: "#25211a" },
  },
  {
    id: "basalt",
    label: "Basalt",
    author: "Ingle",
    category: "Neutral",
    description: "Near-black volcanic stone with a signal-red accent.",
    scheme: "dark",
    effect: "grain",
    dark: { accent: "#e5484d", background: "#0c0c0d", foreground: "#ebeaea" },
    light: { accent: "#cc2f35", background: "#f9f9f8", foreground: "#1a1a1b" },
  },
  {
    id: "tidepool",
    label: "Tidepool",
    author: "Ingle",
    category: "Cool",
    description: "Ink-blue shallows and a sea-glass cyan accent.",
    scheme: "dark",
    effect: "dither",
    dark: { accent: "#2ec4c0", background: "#08131a", foreground: "#dff0f2" },
    light: { accent: "#0f7f7c", background: "#f1f8f8", foreground: "#0f2328" },
  },
]
