import "./appearance.css"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { putFile } from "../lib/api.ts"
import { drive } from "../lib/drive.ts"
import { themes } from "../plugins/slots.tsx"
import { Backdrop } from "./backdrop.tsx"
import { isHex } from "./color.ts"
import { forgetWallpaper } from "./wallpapers.ts"
import {
  contrastChecks,
  CUSTOM_PREFIX,
  customId,
  DEFAULT_BACKGROUND,
  DEFAULT_UI,
  INGLE_DARK,
  INGLE_LIGHT,
  LIMITS,
  ROSE,
  type Background,
  type CustomTheme,
  type Interface,
  type Palette,
  type Variant,
  type Wallpaper,
} from "./model.ts"
import {
  appearance,
  deleteCustomTheme,
  newThemeId,
  palettesOf,
  saveCustomTheme,
  saveState,
  selectTheme,
  update,
  variant,
} from "./store.ts"

const WALLPAPER_ROOT = "/me/"
const USER = { kind: "user" } as const
const WALLPAPER_FOLDER = "appearance/wallpapers/"

type Swatch = { readonly id: string; readonly label: string; readonly palette: Palette }

function Card(props: { readonly children: JSX.Element }): JSX.Element {
  return <div class="flex flex-col rounded-lg bg-panel shadow-ring">{props.children}</div>
}

function Section(props: { readonly title: string; readonly detail?: string; readonly action?: JSX.Element; readonly children: JSX.Element }): JSX.Element {
  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-end justify-between gap-4 px-1">
        <div class="min-w-0">
          <h2 class="text-base font-medium text-ink">{props.title}</h2>
          <Show when={props.detail}>{(detail) => <p class="mt-0.5 text-sm text-ink-3">{detail()}</p>}</Show>
        </div>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

function Line(props: { readonly title: string; readonly detail?: string; readonly for?: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-2 border-b border-line-1 px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div class="min-w-0">
        <label for={props.for} class="block text-sm font-medium text-ink">
          {props.title}
        </label>
        <Show when={props.detail}>{(detail) => <span class="mt-0.5 block text-xs text-ink-3">{detail()}</span>}</Show>
      </div>
      <div class="flex min-w-0 shrink-0 items-center gap-2">{props.children}</div>
    </div>
  )
}

function Select<T extends string>(props: {
  readonly id?: string
  readonly label: string
  readonly value: T
  readonly choices: readonly (readonly [T, string])[]
  readonly onChange: (next: T) => void
}): JSX.Element {
  return (
    <select
      id={props.id}
      aria-label={props.label}
      value={props.value}
      onChange={(event) => {
        const picked = props.choices.find(([value]) => value === event.currentTarget.value)
        if (picked !== undefined) props.onChange(picked[0])
      }}
      class="h-8 min-w-[160px] rounded-sm border border-line-2 bg-bg px-2 text-sm text-ink focus-visible:border-line-3 focus-visible:outline-none"
    >
      <For each={props.choices}>{([value, label]) => <option value={value}>{label}</option>}</For>
    </select>
  )
}

function Slider(props: {
  readonly id: string
  readonly value: number
  readonly limits: readonly [number, number, number]
  readonly unit: string
  readonly onInput: (next: number) => void
}): JSX.Element {
  return (
    <>
      <input
        id={props.id}
        type="range"
        min={props.limits[0]}
        max={props.limits[1]}
        step={props.limits[2]}
        value={props.value}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
        class="appearance-range w-40"
        aria-valuetext={`${props.value}${props.unit}`}
      />
      <output for={props.id} class="w-12 text-right font-mono text-xs tabular-nums text-ink-3">
        {props.value}
        {props.unit}
      </output>
    </>
  )
}

/** A miniature app window drawn from a palette: sidebar strip, two lines, an accent dot. */
function Thumb(props: { readonly palette: Palette; readonly split?: Palette; readonly class?: string }): JSX.Element {
  const half = (palette: Palette, clip?: string): JSX.Element => (
    <div class="absolute inset-0" style={{ background: palette.background, "clip-path": clip }}>
      <div class="absolute inset-y-0 left-0 w-[22%]" style={{ background: palette.foreground, opacity: 0.06 }} />
      <div class="absolute left-[32%] top-[30%] h-[7%] w-[48%] rounded-full" style={{ background: palette.foreground, opacity: 0.55 }} />
      <div class="absolute left-[32%] top-[46%] h-[7%] w-[32%] rounded-full" style={{ background: palette.foreground, opacity: 0.3 }} />
      <div class="absolute bottom-[14%] right-[10%] size-[12%] rounded-full" style={{ background: palette.accent }} />
    </div>
  )
  return (
    <div class={`relative overflow-hidden rounded-md shadow-ring ${props.class ?? ""}`}>
      {half(props.palette)}
      <Show when={props.split}>{(split) => half(split(), "polygon(50% 0, 100% 0, 100% 100%, 50% 100%)")}</Show>
    </div>
  )
}

function ModeRow(): JSX.Element {
  const current = createMemo(() => palettesOf(appearance().theme))
  const modes = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ] as const
  return (
    <div role="radiogroup" aria-label="Mode" class="flex gap-2">
      <For each={modes}>
        {([mode, label]) => (
          <button
            type="button"
            role="radio"
            aria-checked={appearance().mode === mode}
            aria-label={label}
            onClick={() => update((value) => ({ ...value, mode }))}
            class="appearance-pick flex flex-col items-center gap-1.5 rounded-lg p-1"
          >
            <Thumb
              class="h-10 w-16"
              palette={mode === "dark" ? current().dark : current().light}
              {...(mode === "system" ? { split: current().dark } : {})}
            />
            <span class="text-xs text-ink-2">{label}</span>
          </button>
        )}
      </For>
    </div>
  )
}

function ThemeGrid(props: { readonly swatches: readonly Swatch[] }): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Theme" class="grid grid-cols-3 gap-x-2 gap-y-3 p-3 sm:grid-cols-6">
      <For each={props.swatches}>
        {(swatch) => {
          const active = (): boolean => appearance().theme === swatch.id
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active()}
              onClick={() => selectTheme(swatch.id)}
              class="appearance-pick flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-1"
            >
              <Thumb class="aspect-[16/10] w-full" palette={swatch.palette} />
              <span class="w-full truncate text-center text-xs" classList={{ "font-medium text-ink": active(), "text-ink-3": !active() }}>
                {swatch.label}
              </span>
            </button>
          )
        }}
      </For>
    </div>
  )
}

function ColorField(props: { readonly label: string; readonly value: string; readonly onChange: (next: string) => void }): JSX.Element {
  const [draft, setDraft] = createSignal<string | undefined>()
  const id = `color-${props.label.toLowerCase()}`
  return (
    <Line title={props.label} for={id}>
      <input
        type="color"
        aria-label={`${props.label} colour picker`}
        value={props.value.slice(0, 7)}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        class="size-6 cursor-pointer rounded-xs border-0 bg-transparent p-0"
      />
      <input
        id={id}
        value={draft() ?? props.value}
        spellcheck={false}
        onInput={(event) => {
          const next = event.currentTarget.value.trim()
          setDraft(next)
          if (isHex(next)) props.onChange(next.toLowerCase())
        }}
        onBlur={() => setDraft(undefined)}
        aria-invalid={draft() !== undefined && !isHex(draft() ?? "")}
        class="h-8 w-28 rounded-sm border border-line-2 bg-bg px-2 font-mono text-sm text-ink focus-visible:border-line-3 focus-visible:outline-none aria-[invalid=true]:border-failed"
      />
    </Line>
  )
}

function Editor(props: { readonly selected: Swatch }): JSX.Element {
  const [side, setSide] = createSignal<Variant>(variant())
  const custom = (): CustomTheme | undefined => {
    const id = customId(props.selected.id)
    return id === undefined ? undefined : appearance().custom.find((entry) => entry.id === id)
  }
  const palettes = (): { readonly dark: Palette; readonly light: Palette } => custom() ?? palettesOf(props.selected.id)
  const palette = (): Palette => (side() === "dark" ? palettes().dark : palettes().light)

  /** A built-in theme is never changed: the first edit forks it into your themes. */
  const edit = (key: keyof Palette, value: string): void => {
    const mine = custom()
    const base: CustomTheme = mine ?? {
      id: newThemeId(props.selected.label),
      label: `${props.selected.label} copy`,
      dark: palettes().dark,
      light: palettes().light,
    }
    const next: CustomTheme = { ...base, [side()]: { ...palette(), [key]: value } }
    saveCustomTheme(next)
    if (mine === undefined) selectTheme(`${CUSTOM_PREFIX}${next.id}`)
  }

  const exportTheme = (): void => {
    const mine = custom()
    if (mine === undefined) return
    const { source: _source, ...shared } = mine
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([JSON.stringify({ kind: "ingle-theme", ...shared }, null, 2)], { type: "application/json" }))
    link.download = `${mine.id}.ingle-theme.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  return (
    <>
      <Show when={custom()}>
        {(mine) => (
          <Card>
            <Line title="Name" for="theme-name">
              <input
                id="theme-name"
                value={mine().label}
                maxLength={48}
                onChange={(event) => {
                  const label = event.currentTarget.value.trim()
                  if (label !== "") saveCustomTheme({ ...mine(), label })
                }}
                class="h-8 w-48 rounded-sm border border-line-2 bg-bg px-2 text-sm text-ink focus-visible:border-line-3 focus-visible:outline-none"
              />
            </Line>
            <Line title="Download theme" detail="Saves its colours as a JSON file">
              <button type="button" onClick={exportTheme} class="im-press h-8 rounded-sm px-2.5 text-sm text-ink-2 shadow-ring hover:text-ink">
                Download
              </button>
            </Line>
            <Line title="Delete theme" detail={`Removes ${mine().label} from your themes`}>
              <button
                type="button"
                onClick={() => deleteCustomTheme(mine().id)}
                class="im-press h-8 rounded-sm px-2.5 text-sm text-failed hover:bg-failed-soft"
              >
                Delete
              </button>
            </Line>
          </Card>
        )}
      </Show>
      <Section
        title="Colors"
        detail="Every other colour is derived from these three, and text is adjusted until it is readable"
        action={
          <div role="radiogroup" aria-label="Edit variant" class="flex rounded-sm bg-secondary p-0.5">
            <For each={["light", "dark"] as const}>
              {(value) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={side() === value}
                  onClick={() => setSide(value)}
                  class="h-6 rounded-xs px-2.5 text-xs capitalize"
                  classList={{ "bg-card text-ink shadow-ring": side() === value, "text-ink-3": side() !== value }}
                >
                  {value}
                </button>
              )}
            </For>
          </div>
        }
      >
        <Card>
          <ColorField label="Accent" value={palette().accent} onChange={(next) => edit("accent", next)} />
          <ColorField label="Background" value={palette().background} onChange={(next) => edit("background", next)} />
          <ColorField label="Foreground" value={palette().foreground} onChange={(next) => edit("foreground", next)} />
          <div class="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3">
            <For each={contrastChecks(palette())}>
              {(check) => (
                <span class="flex items-center gap-1.5 text-xs" classList={{ "text-ink-3": check.ratio >= check.target, "text-working-text": check.ratio < check.target }}>
                  <span class="font-mono tabular-nums">{check.ratio.toFixed(1)}:1</span>
                  {check.label}
                  {check.ratio >= check.target ? "" : " (raised automatically)"}
                </span>
              )}
            </For>
          </div>
        </Card>
      </Section>
    </>
  )
}

function Preview(props: { readonly background: Background }): JSX.Element {
  return (
    <div class="relative h-48 overflow-hidden rounded-lg bg-bg shadow-ring">
      <Backdrop background={props.background} />
      <Show when={props.background.image === undefined}>
        <p class="absolute inset-x-0 top-6 text-center text-sm text-ink-3">Upload an image to see it here</p>
      </Show>
      <div
        class="absolute left-1/2 top-[38%] w-[min(360px,80%)] -translate-x-1/2 rounded-lg bg-card p-3 shadow-composer"
        style={{ opacity: "var(--appearance-input-opacity, 1)" }}
      >
        <p class="text-sm text-placeholder">Ask anything</p>
        <div class="mt-6 flex items-center justify-between">
          <span class="flex size-6 items-center justify-center rounded-sm text-icon shadow-ring">+</span>
          <span class="flex size-6 items-center justify-center rounded-sm bg-accent text-on-accent">↑</span>
        </div>
      </div>
    </div>
  )
}

function BackgroundSection(): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string | undefined>()
  let picker: HTMLInputElement | undefined
  const background = (): Background => appearance().background
  const set = (patch: Partial<Background>): void => update((value) => ({ ...value, background: { ...value.background, ...patch } }))

  const upload = async (file: File): Promise<void> => {
    if (!file.type.startsWith("image/")) {
      setProblem(`${file.name} is not an image`)
      return
    }
    setBusy(true)
    setProblem(undefined)
    try {
      const name = `${Date.now().toString(36)}-${file.name.replace(/[^\w.-]+/gu, "-").slice(-60)}`
      await putFile(file, `${WALLPAPER_ROOT}${WALLPAPER_FOLDER}${name}`)
      const link = await drive.share({ kind: "user" }, `${WALLPAPER_FOLDER}${name}`)
      const wallpaper: Wallpaper = { name: file.name, url: link.url, path: `${WALLPAPER_FOLDER}${name}` }
      update((value) => ({
        ...value,
        background: { ...value.background, image: wallpaper },
        wallpapers: [wallpaper, ...value.wallpapers.filter((entry) => entry.url !== wallpaper.url)],
      }))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const forget = (wallpaper: Wallpaper): void => {
    setProblem(undefined)
    void forgetWallpaper(wallpaper, { unshare: (path) => drive.unshare(USER, path), remove: (path) => drive.remove(USER, path), edit: update }).catch(
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }

  const sliders: readonly (readonly [keyof typeof LIMITS & keyof Background, string, string])[] = [
    ["brightness", "Brightness", "%"],
    ["blur", "Blur", "px"],
    ["opacity", "Image opacity", "%"],
    ["fade", "Bottom fade", "%"],
    ["overlay", "Overlay opacity", "%"],
    ["input", "Input opacity", "%"],
  ]

  return (
    <>
      <Section title="Background" detail="An image behind the home composer, stored in your Drive">
        <Card>
          <Line title="Dashboard background" detail={busy() ? "Uploading…" : (problem() ?? "An image or gif, up to 50 MB, shared by an unlisted link so every device can load it")}>
            <Show when={background().image}>
              {(image) => <img src={image().url} alt="" class="h-8 w-12 rounded-xs object-cover shadow-ring" />}
            </Show>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              class="sr-only"
              aria-label="Upload a background image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file !== undefined) void upload(file)
                event.currentTarget.value = ""
              }}
            />
            <button type="button" disabled={busy()} onClick={() => picker?.click()} class="im-press h-8 rounded-sm px-2.5 text-sm text-ink-2 shadow-ring hover:text-ink disabled:opacity-50">
              {background().image === undefined ? "Upload" : "Replace"}
            </button>
            <Show when={background().image !== undefined}>
              <button
                type="button"
                onClick={() =>
                  update((value) => {
                    const { image: _image, ...rest } = value.background
                    return { ...value, background: rest }
                  })
                }
                class="im-press h-8 rounded-sm px-2.5 text-sm text-ink-3 hover:text-ink"
              >
                Remove
              </button>
            </Show>
          </Line>
          <Line title="Background effect" for="bg-effect">
            <Select
              id="bg-effect"
              label="Background effect"
              value={background().effect}
              choices={[
                ["none", "None"],
                ["dither", "Dither"],
                ["grain", "Grain"],
                ["vignette", "Vignette"],
              ]}
              onChange={(effect) => set({ effect })}
            />
          </Line>
          <Show when={background().effect === "dither"}>
            <Line title="Dither colour" detail="Dots in the image's own colours, the theme accent, or grey" for="bg-tone">
              <Select
                id="bg-tone"
                label="Dither colour"
                value={background().tone}
                choices={[
                  ["image", "Image"],
                  ["accent", "Accent"],
                  ["mono", "Mono"],
                ]}
                onChange={(tone) => set({ tone })}
              />
            </Line>
            <Line title="Dot size" for="bg-cell">
              <Slider id="bg-cell" value={background().cell} limits={LIMITS.cell} unit="px" onInput={(cell) => set({ cell })} />
            </Line>
          </Show>
          <Show when={background().effect !== "none"}>
            <Line title="Effect intensity" for="bg-intensity">
              <Slider id="bg-intensity" value={background().intensity} limits={LIMITS.intensity} unit="%" onInput={(intensity) => set({ intensity })} />
            </Line>
          </Show>
          <div class="px-4 py-3">
            <Preview background={background()} />
          </div>
          <For each={sliders}>
            {([key, label, unit]) => (
              <Line title={label} for={`bg-${key}`}>
                <Slider id={`bg-${key}`} value={background()[key]} limits={LIMITS[key]} unit={unit} onInput={(next) => set({ [key]: next })} />
              </Line>
            )}
          </For>
          <div class="flex justify-end px-4 py-2">
            <button
              type="button"
              onClick={() => update((value) => ({ ...value, background: { ...DEFAULT_BACKGROUND, ...(value.background.image === undefined ? {} : { image: value.background.image }) } }))}
              class="text-xs text-ink-3 hover:text-ink"
            >
              Reset to defaults
            </button>
          </div>
        </Card>
      </Section>
      <Show when={appearance().wallpapers.length > 0}>
        <Section title="Your wallpapers" detail="Stored in your Drive and served from a share link anyone with the link can open. Remove revokes the link and deletes the file.">
          <Card>
            <div class="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
              <For each={appearance().wallpapers}>
                {(wallpaper) => (
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <button
                      type="button"
                      aria-label={`Use ${wallpaper.name}`}
                      aria-pressed={background().image?.url === wallpaper.url}
                      onClick={() => set({ image: wallpaper })}
                      class="appearance-pick overflow-hidden rounded-md"
                    >
                      <img src={wallpaper.url} alt="" loading="lazy" class="aspect-video w-full object-cover" />
                    </button>
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate text-xs text-ink-3">{wallpaper.name}</span>
                      <button
                        type="button"
                        aria-label={`Forget ${wallpaper.name}`}
                        onClick={() => forget(wallpaper)}
                        class="shrink-0 text-xs text-ink-3 hover:text-failed"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Card>
        </Section>
      </Show>
    </>
  )
}

function InterfaceSection(): JSX.Element {
  const ui = (): Interface => appearance().ui
  const set = (patch: Partial<Interface>): void => update((value) => ({ ...value, ui: { ...value.ui, ...patch } }))
  return (
    <Section title="Interface" detail="Sizes apply to this home on every device that syncs">
      <Card>
        <Line title="Text size" for="ui-text">
          <Slider id="ui-text" value={ui().textScale} limits={LIMITS.textScale} unit="%" onInput={(textScale) => set({ textScale })} />
        </Line>
        <Line title="Density" detail="Auto is compact with a mouse and roomy on touch screens" for="ui-density">
          <Select
            id="ui-density"
            label="Density"
            value={ui().density}
            choices={[
              ["auto", "Auto"],
              ["pointer", "Compact"],
              ["touch", "Comfortable"],
            ]}
            onChange={(density) => set({ density })}
          />
        </Line>
        <Line title="Sidebar width" for="ui-sidebar">
          <Slider id="ui-sidebar" value={ui().sidebar} limits={LIMITS.sidebar} unit="px" onInput={(sidebar) => set({ sidebar })} />
        </Line>
        <Line title="Side pane width" for="ui-pane">
          <Slider id="ui-pane" value={ui().pane} limits={LIMITS.pane} unit="px" onInput={(pane) => set({ pane })} />
        </Line>
        <div class="flex justify-end px-4 py-2">
          <button type="button" onClick={() => update((value) => ({ ...value, ui: { ...DEFAULT_UI, codeSize: value.ui.codeSize, diffColors: value.ui.diffColors } }))} class="text-xs text-ink-3 hover:text-ink">
            Reset to defaults
          </button>
        </div>
      </Card>
    </Section>
  )
}

function CodeSection(): JSX.Element {
  const ui = (): Interface => appearance().ui
  const set = (patch: Partial<Interface>): void => update((value) => ({ ...value, ui: { ...value.ui, ...patch } }))
  return (
    <Section title="Code">
      <Card>
        <Line title="Code font size" detail="Text size in diffs, files and code blocks" for="ui-code">
          <Select
            id="ui-code"
            label="Code font size"
            value={ui().codeSize}
            choices={[
              ["small", "Small"],
              ["default", "Default"],
              ["large", "Large"],
            ]}
            onChange={(codeSize) => set({ codeSize })}
          />
        </Line>
        <Line title="Diff colors" detail="Blue/orange is the alternative for red-green colour blindness" for="ui-diff">
          <Select
            id="ui-diff"
            label="Diff colors"
            value={ui().diffColors}
            choices={[
              ["red-green", "Red/green"],
              ["blue-orange", "Blue/orange"],
            ]}
            onChange={(diffColors) => set({ diffColors })}
          />
        </Line>
        <pre class="appearance-code overflow-x-auto px-4 py-3 font-mono leading-5 text-ink-2" aria-label="Diff preview">
          <div>
            <span class="text-ink-3">1 </span>
            {"export function add(a: number, b: number) {"}
          </div>
          <div style={{ background: "color-mix(in oklch, var(--color-diff-del) 14%, transparent)" }}>
            <span style={{ color: "var(--color-diff-del)" }}>- </span>
            {"  return a - b"}
          </div>
          <div style={{ background: "color-mix(in oklch, var(--color-diff-add) 14%, transparent)" }}>
            <span style={{ color: "var(--color-diff-add)" }}>+ </span>
            {"  return a + b"}
          </div>
          <div>
            <span class="text-ink-3">3 </span>
            {"}"}
          </div>
        </pre>
      </Card>
    </Section>
  )
}

export function AppearanceSettings(): JSX.Element {
  const swatches = createMemo((): readonly Swatch[] => {
    const registry = themes().flatMap((entry): Swatch[] => {
      if (entry.id === "light") return []
      if (entry.id === "dark") return [{ id: "ingle", label: "Ingle", palette: variant() === "dark" ? INGLE_DARK : INGLE_LIGHT }]
      if (entry.id === "rose") return [{ id: "rose", label: "Rose", palette: ROSE }]
      return [{ id: entry.id, label: entry.label, palette: palettesOf(entry.id).dark }]
    })
    const custom = appearance().custom.map(
      (entry): Swatch => ({ id: `${CUSTOM_PREFIX}${entry.id}`, label: entry.label, palette: variant() === "dark" ? entry.dark : entry.light }),
    )
    return [...registry, ...custom]
  })
  const selected = (): Swatch | undefined => swatches().find((swatch) => swatch.id === appearance().theme) ?? swatches()[0]

  const createTheme = (): void => {
    const base = selected()
    const palettes = palettesOf(base?.id ?? "ingle")
    const theme: CustomTheme = { id: newThemeId("custom"), label: "My theme", dark: palettes.dark, light: palettes.light }
    saveCustomTheme(theme)
    selectTheme(`${CUSTOM_PREFIX}${theme.id}`)
  }

  return (
    <div class="flex flex-col gap-8">
      <Card>
        <Line title="Mode" detail="System follows your operating system">
          <ModeRow />
        </Line>
        <Line
          title="Appearance sync"
          detail={appearance().sync === "synced" ? (saveState() === "failed" ? "Could not save to your home; changes stay on this device" : "Changes apply across your devices") : "Only this device"}
          for="appearance-sync"
        >
          <Select
            id="appearance-sync"
            label="Appearance sync"
            value={appearance().sync}
            choices={[
              ["synced", "Synced"],
              ["device", "This device"],
            ]}
            onChange={(sync) => update((value) => ({ ...value, sync }))}
          />
        </Line>
      </Card>

      <Section
        title="Theme"
        detail={customId(appearance().theme) === undefined ? `Editing creates your own copy of ${selected()?.label ?? "this theme"}` : `Changes save to ${selected()?.label ?? "your theme"}`}
        action={
          <button type="button" onClick={createTheme} class="im-press h-7 rounded-sm px-2 text-sm text-ink-2 hover:bg-hover hover:text-ink">
            + Create theme
          </button>
        }
      >
        <Card>
          <ThemeGrid swatches={swatches()} />
        </Card>
      </Section>

      <Show when={selected()}>{(swatch) => <Editor selected={swatch()} />}</Show>

      <BackgroundSection />
      <InterfaceSection />
      <CodeSection />
    </div>
  )
}
