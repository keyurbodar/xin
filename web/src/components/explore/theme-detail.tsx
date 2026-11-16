import { createMemo, createSignal, onMount, Show, type JSX } from "solid-js"
import { addCatalogTheme, appearance, isCatalogThemeAdded } from "../../appearance/store.ts"
import { errorMessage } from "../../state/extensions.ts"
import { catalogTheme, exploreThemes, themeSource, type ExploreTheme } from "../../state/explore.ts"
import { Button, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Card, LoadFailed, Page, SkeletonRows } from "./parts.tsx"
import { crumbsFor, themePalette } from "./routes.ts"
import { ThemePreview } from "./theme-preview.tsx"

const EFFECT_LABEL: Readonly<Record<ExploreTheme["effect"], string>> = {
  none: "None",
  dither: "Dither",
  grain: "Grain",
  vignette: "Vignette",
}

/** Add verifies the entry's sha256, stores a copy in your themes and applies it; your wallpaper stays. */
export function AddThemeButton(props: { id: string }): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const added = (): boolean => isCatalogThemeAdded(themeSource(props.id))
  const add = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      addCatalogTheme(await catalogTheme(props.id, appearance().background))
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show
      when={!added()}
      fallback={
        <span class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-sm text-ink-2 shadow-ring">
          <Glyph name="check" size={13} />
          Added
        </span>
      }
    >
      <span class="flex shrink-0 flex-col items-end gap-1">
        <Button size="sm" variant="primary" disabled={busy()} onClick={() => void add()}>
          <Glyph name="plus" size={13} />
          {busy() ? "Adding" : "Add"}
        </Button>
        <Show when={error()}>
          {(message) => (
            <span role="alert" class="max-w-[240px] text-right text-xs text-failed">
              {message()}
            </span>
          )}
        </Show>
      </span>
    </Show>
  )
}

export function ThemeDetail(props: { id: string }): JSX.Element {
  onMount(() => void exploreThemes.reload())
  const theme = createMemo((): ExploreTheme | undefined => {
    const state = exploreThemes.state()
    return state.kind === "ready" ? state.value.find((entry) => entry.id === props.id) : undefined
  })

  return (
    <Page crumbs={crumbsFor("themes", theme()?.label ?? props.id)}>
      <Show when={exploreThemes.state().kind === "loading"}>
        <span class="ex-skeleton aspect-[16/10] rounded-lg" />
        <SkeletonRows count={2} />
      </Show>
      <Show when={failureOf(exploreThemes.state())}>
        {(message) => <LoadFailed what="themes" message={message()} onRetry={() => void exploreThemes.reload()} />}
      </Show>
      <Show when={exploreThemes.state().kind === "ready" && theme() === undefined}>
        <div class="flex flex-col items-start gap-2 py-8">
          <span class="text-base text-ink">No theme called {props.id}</span>
          <a href="#/explore/themes" class="text-sm text-primary-ink hover:underline">
            Back to themes
          </a>
        </div>
      </Show>
      <Show when={theme()}>
        {(entry) => (
          <>
            <div class="overflow-hidden rounded-lg shadow-ring">
              <ThemePreview
                palette={themePalette(entry())}
                variant={entry().scheme}
                effect={entry().effect}
                label={entry().label}
                class="rounded-none"
              />
            </div>
            <Card>
              <div class="flex items-start justify-between gap-3 p-4">
                <div class="min-w-0">
                  <h1 class="text-xl font-normal text-ink">{entry().label}</h1>
                  <p class="mt-1 text-sm text-ink-2">{entry().description}</p>
                </div>
                <AddThemeButton id={entry().id} />
              </div>
              <dl class="grid grid-cols-2 gap-4 border-t border-line-1 px-4 py-3 sm:grid-cols-4">
                <Stat label="Made by" value={entry().author} />
                <Stat label="Effect" value={EFFECT_LABEL[entry().effect]} />
                <Stat label="Opens in" value={entry().scheme === "dark" ? "Dark" : "Light"} />
                <Stat label="Version" value="1" />
              </dl>
            </Card>
            <section class="flex flex-col gap-3">
              <div>
                <h2 class="text-sm font-medium text-ink">Light and dark</h2>
                <p class="text-sm text-ink-2">Adding it applies these colours, and switches your background effect to {EFFECT_LABEL[entry().effect].toLowerCase()}.</p>
              </div>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <figure class="flex flex-col gap-2">
                  <div class="overflow-hidden rounded-md shadow-ring">
                    <ThemePreview palette={entry().light} variant="light" effect={entry().effect} label={entry().label} />
                  </div>
                  <figcaption class="text-sm text-ink-2">Light</figcaption>
                </figure>
                <figure class="flex flex-col gap-2">
                  <div class="overflow-hidden rounded-md shadow-ring">
                    <ThemePreview palette={entry().dark} variant="dark" effect={entry().effect} label={entry().label} />
                  </div>
                  <figcaption class="text-sm text-ink-2">Dark</figcaption>
                </figure>
              </div>
            </section>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Report: ${entry().label} theme`)}`}
              class="self-start text-sm text-ink-2 hover:text-ink"
            >
              Report
            </a>
          </>
        )}
      </Show>
    </Page>
  )
}

function Stat(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex flex-col gap-0.5">
      <dt class="text-xs text-ink-2">{props.label}</dt>
      <dd class="text-sm text-ink">{props.value}</dd>
    </div>
  )
}
