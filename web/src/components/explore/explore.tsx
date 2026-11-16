import { Menu } from "@ark-ui/solid/menu"
import "@ui-sdk/web/tabs"
import { createMemo, createSignal, For, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { navigate } from "../../lib/router.ts"
import { market, packages, rows, skills, type MarketSummary, type Remote } from "../../state/extensions.ts"
import { exploreSkills, exploreThemes, themeSource, type ExploreSkill, type ExploreTheme } from "../../state/explore.ts"
import { isCatalogThemeAdded } from "../../appearance/store.ts"
import { MENU_CONTENT, MENU_ITEM } from "../shell/menu.ts"
import { Glyph } from "../extensions/glyph.tsx"
import { failureOf } from "../extensions/chrome.tsx"
import {
  CompactRow,
  LoadFailed,
  LogoTile,
  NoMatches,
  Page,
  Pager,
  RowGrid,
  SearchBox,
  SectionHead,
  SkeletonRows,
  ViewAll,
  type Crumb,
} from "./parts.tsx"
import { Swatch, ThemePreview } from "./theme-preview.tsx"
import { PluginDetail } from "./plugin-detail.tsx"
import { SkillDetail } from "./skill-detail.tsx"
import { AddThemeButton, ThemeDetail } from "./theme-detail.tsx"
import {
  EXPLORE_TABS,
  logoOf,
  pluginPath,
  skillPath,
  statusWord,
  TAB_LABEL,
  TAB_PATH,
  tabOf,
  themePalette,
  themePath,
  type ExploreTab,
  type ExploreView,
} from "./routes.ts"
import "./explore.css"

const TAB_COPY: Readonly<Record<ExploreTab, string>> = {
  plugins: "Extend what Ingle can do, from your market indexes",
  skills: "Instructions the agent follows, written and checked by Ingle",
  themes: "Palettes for light and dark, each with a background effect",
}

export function Explore(props: { view: ExploreView }): JSX.Element {
  return (
    <Switch>
      <Match when={props.view.kind === "list" && props.view}>{(view) => <ExploreList tab={view().tab} />}</Match>
      <Match when={props.view.kind === "plugin" && props.view}>{(view) => <PluginDetail name={view().name} />}</Match>
      <Match when={props.view.kind === "skill" && props.view}>{(view) => <SkillDetail name={view().name} />}</Match>
      <Match when={props.view.kind === "theme" && props.view}>{(view) => <ThemeDetail id={view().id} />}</Match>
    </Switch>
  )
}

const matches = (query: string, fields: readonly (string | undefined)[]): boolean => {
  const text = query.trim().toLowerCase()
  return text === "" || fields.some((field) => field?.toLowerCase().includes(text) === true)
}

const ready = <T,>(state: Remote<readonly T[]>): readonly T[] => (state.kind === "ready" ? state.value : [])

function ExploreList(props: { tab: ExploreTab }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [category, setCategory] = createSignal<string | undefined>(undefined)
  const [section, setSection] = createSignal<string | undefined>(undefined)

  const select = (tab: ExploreTab): void => {
    setQuery("")
    setCategory(undefined)
    setSection(undefined)
    navigate(TAB_PATH[tab])
  }

  const crumbs = (): readonly Crumb[] => {
    const open = section()
    if (open === undefined) return [{ label: "Explore", to: TAB_PATH.plugins }, { label: TAB_LABEL[props.tab] }]
    return [{ label: "Explore", to: TAB_PATH.plugins }, { label: TAB_LABEL[props.tab], to: TAB_PATH[props.tab] }, { label: open }]
  }

  return (
    <Page crumbs={crumbs()}>
      <ui-tabs
        prop:value={props.tab}
        on:valuechange={(event) => {
          const tab = tabOf(event.detail.value)
          if (tab !== undefined && tab !== props.tab) select(tab)
        }}
        class="flex flex-col gap-6"
      >
        <header class="flex flex-col gap-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <h1 class="text-xl font-normal text-ink">{TAB_LABEL[props.tab]}</h1>
              <p class="mt-1 text-sm text-ink-2">{TAB_COPY[props.tab]}</p>
            </div>
            <SearchBox
              value={query()}
              placeholder={props.tab === "plugins" ? "Search plugins" : "Search Explore"}
              onInput={(value) => {
                setQuery(value)
                setSection(undefined)
              }}
            />
          </div>
          <div class="flex items-center justify-between gap-3">
            <ui-tabs-list
              aria-label="Explore"
              class="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-sm bg-secondary p-0.5"
            >
              <For each={EXPLORE_TABS}>
                {(tab) => (
                  <ui-tabs-tab value={tab}>
                    <button
                      type="button"
                      class="ex-color h-7 rounded-[5px] px-3 text-sm font-medium text-ink-2 hover:text-ink data-[selected]:bg-card data-[selected]:text-ink data-[selected]:shadow-ring"
                    >
                      {TAB_LABEL[tab]}
                    </button>
                  </ui-tabs-tab>
                )}
              </For>
            </ui-tabs-list>
            <Show when={props.tab === "plugins"}>
              <CategoryMenu
                categories={pluginCategories(ready(market.state()))}
                value={category()}
                onChange={(next) => {
                  setCategory(next)
                  setSection(undefined)
                }}
              />
            </Show>
          </div>
        </header>

        <Switch>
          <Match when={props.tab === "plugins"}>
            <ui-tabs-panel value="plugins" class="flex flex-col gap-7">
              <PluginsTab
                query={query()}
                category={category()}
                section={section()}
                onSection={setSection}
                onClear={() => setQuery("")}
              />
            </ui-tabs-panel>
          </Match>
          <Match when={props.tab === "skills"}>
            <ui-tabs-panel value="skills" class="flex flex-col gap-7">
              <SkillsTab query={query()} onClear={() => setQuery("")} />
            </ui-tabs-panel>
          </Match>
          <Match when={props.tab === "themes"}>
            <ui-tabs-panel value="themes" class="flex flex-col gap-7">
              <ThemesTab query={query()} onClear={() => setQuery("")} />
            </ui-tabs-panel>
          </Match>
        </Switch>
      </ui-tabs>
    </Page>
  )
}

const pluginCategories = (entries: readonly MarketSummary[]): readonly string[] =>
  [...new Set(entries.map((entry) => entry.category ?? "Other"))].toSorted((left, right) => left.localeCompare(right))

function CategoryMenu(props: {
  categories: readonly string[]
  value: string | undefined
  onChange: (value: string | undefined) => void
}): JSX.Element {
  return (
    <Menu.Root positioning={{ placement: "bottom-end", gutter: 6 }} lazyMount unmountOnExit>
      <Menu.Trigger class="ex-color flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-sm text-ink-2 hover:bg-hover hover:text-ink data-[state=open]:bg-hover">
        {props.value ?? "Categories"}
        <Glyph name="chevron-down" size={13} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content class={`${MENU_CONTENT} w-[200px]`}>
            <Menu.RadioItemGroup
              value={props.value ?? ""}
              onValueChange={(details) => props.onChange(details.value === "" ? undefined : details.value)}
            >
              <For each={["", ...props.categories]}>
                {(name) => (
                  <Menu.RadioItem value={name} class={MENU_ITEM}>
                    <Menu.ItemText class="flex-1">{name === "" ? "All categories" : name}</Menu.ItemText>
                    <Menu.ItemIndicator>
                      <Glyph name="check" size={13} />
                    </Menu.ItemIndicator>
                  </Menu.RadioItem>
                )}
              </For>
            </Menu.RadioItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  )
}

const FEATURED = 4
const PER_SECTION = 6

function PluginsTab(props: {
  query: string
  category: string | undefined
  section: string | undefined
  onSection: (section: string | undefined) => void
  onClear: () => void
}): JSX.Element {
  onMount(() => {
    void market.reload()
    void packages.reload()
    void rows.reload()
  })

  const entries = createMemo(() =>
    ready(market.state()).filter(
      (entry) =>
        (props.category === undefined || (entry.category ?? "Other") === props.category) &&
        matches(props.query, [entry.name, entry.title, entry.description, entry.author, entry.category]),
    ),
  )

  const sections = createMemo((): readonly { readonly label: string; readonly entries: readonly MarketSummary[] }[] => {
    const list = entries()
    if (props.query.trim() !== "" || props.category !== undefined) return [{ label: props.category ?? "Results", entries: list }]
    const featured = list.length > FEATURED ? list.slice(0, FEATURED) : []
    const byCategory = new Map<string, MarketSummary[]>()
    for (const entry of list.slice(featured.length)) {
      const key = entry.category ?? "Other"
      byCategory.set(key, [...(byCategory.get(key) ?? []), entry])
    }
    const categories = [...byCategory.entries()]
      .toSorted(([left], [right]) => (left === "Other" ? 1 : right === "Other" ? -1 : left.localeCompare(right)))
      .map(([label, items]) => ({ label, entries: items }))
    return featured.length > 0 ? [{ label: "Featured", entries: featured }, ...categories] : categories
  })

  const visible = () => {
    const open = props.section
    return open === undefined ? sections() : sections().filter((group) => group.label === open)
  }

  return (
    <Switch>
      <Match when={market.state().kind === "loading"}>
        <SkeletonRows count={8} />
      </Match>
      <Match when={failureOf(market.state())}>
        {(message) => <LoadFailed what="the market" message={message()} onRetry={() => void market.reload()} />}
      </Match>
      <Match when={ready(market.state()).length === 0}>
        <div class="flex flex-col items-start gap-2 px-2 py-8">
          <span class="text-base text-ink">No market index yet</span>
          <span class="text-sm text-ink-2">Plugins here come from the index URLs you add in Sources.</span>
          <button type="button" onClick={() => navigate("/extensions/sources")} class="text-sm text-primary-ink hover:underline">
            Open Sources
          </button>
        </div>
      </Match>
      <Match when={entries().length === 0}>
        <NoMatches query={props.query === "" ? (props.category ?? "") : props.query} onClear={props.onClear} />
      </Match>
      <Match when={true}>
        <For each={visible()}>
          {(group) => (
            <section class="flex flex-col gap-1.5">
              <SectionHead
                label={group.label.charAt(0).toUpperCase() + group.label.slice(1)}
                action={
                  <Show
                    when={props.section === undefined}
                    fallback={<ViewAll label="All plugins" onClick={() => props.onSection(undefined)} />}
                  >
                    <Show when={group.entries.length > PER_SECTION}>
                      <ViewAll onClick={() => props.onSection(group.label)} />
                    </Show>
                  </Show>
                }
              />
              <RowGrid>
                <For each={props.section === undefined ? group.entries.slice(0, PER_SECTION) : group.entries}>
                  {(entry) => (
                    <CompactRow
                      to={pluginPath(entry.name)}
                      title={entry.title}
                      description={entry.description}
                      badge={statusWord(entry.status)}
                      logo={<LogoTile src={logoOf(entry)} glyph="package" verified={entry.status === "provided"} />}
                    />
                  )}
                </For>
              </RowGrid>
            </section>
          )}
        </For>
      </Match>
    </Switch>
  )
}

function Initial(props: { name: string }): JSX.Element {
  return (
    <span
      class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-medium text-primary-ink"
      aria-hidden="true"
    >
      {props.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function SkillsTab(props: { query: string; onClear: () => void }): JSX.Element {
  onMount(() => {
    void exploreSkills.reload()
    void skills.reload()
  })
  const added = createMemo(() => new Set(ready(skills.state()).map((skill) => skill.name)))
  const list = createMemo(() =>
    ready(exploreSkills.state()).filter((skill: ExploreSkill) =>
      matches(props.query, [skill.name, skill.title, skill.description, skill.author, skill.category]),
    ),
  )
  return (
    <Switch>
      <Match when={exploreSkills.state().kind === "loading"}>
        <SkeletonRows count={8} />
      </Match>
      <Match when={failureOf(exploreSkills.state())}>
        {(message) => <LoadFailed what="skills" message={message()} onRetry={() => void exploreSkills.reload()} />}
      </Match>
      <Match when={list().length === 0}>
        <NoMatches query={props.query} onClear={props.onClear} />
      </Match>
      <Match when={true}>
        <RowGrid>
          <For each={list()}>
            {(skill) => (
              <CompactRow
                to={skillPath(skill.name)}
                title={skill.title}
                description={skill.description}
                badge={added().has(skill.name) ? "Added" : undefined}
                logo={<Initial name={skill.author} />}
                trailing={<span class="hidden shrink-0 text-xs text-ink-2 sm:block">{skill.author}</span>}
              />
            )}
          </For>
        </RowGrid>
      </Match>
    </Switch>
  )
}

const THEMES_PER_PAGE = 6

function ThemesTab(props: { query: string; onClear: () => void }): JSX.Element {
  const [page, setPage] = createSignal(1)
  onMount(() => void exploreThemes.reload())
  const list = createMemo(() =>
    ready(exploreThemes.state()).filter((theme: ExploreTheme) =>
      matches(props.query, [theme.id, theme.label, theme.description, theme.author, theme.category, theme.effect]),
    ),
  )
  const featured = (): ExploreTheme | undefined => (props.query.trim() === "" ? list()[0] : undefined)
  const rest = createMemo(() => (featured() === undefined ? list() : list().slice(1)))
  const pages = (): number => Math.max(1, Math.ceil(rest().length / THEMES_PER_PAGE))
  const current = (): number => Math.min(page(), pages())
  const shown = () => rest().slice((current() - 1) * THEMES_PER_PAGE, current() * THEMES_PER_PAGE)

  return (
    <Switch>
      <Match when={exploreThemes.state().kind === "loading"}>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Loading">
          <For each={Array.from({ length: 4 })}>{() => <span class="ex-skeleton aspect-[16/10] rounded-md" />}</For>
        </div>
      </Match>
      <Match when={failureOf(exploreThemes.state())}>
        {(message) => <LoadFailed what="themes" message={message()} onRetry={() => void exploreThemes.reload()} />}
      </Match>
      <Match when={list().length === 0}>
        <NoMatches query={props.query} onClear={props.onClear} />
      </Match>
      <Match when={true}>
        <Show when={featured()}>{(theme) => <FeaturedTheme theme={theme()} />}</Show>
        <section class="flex flex-col gap-3">
          <SectionHead label={props.query.trim() === "" ? "By Ingle" : "Results"} />
          <div class="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
            <For each={shown()}>{(theme) => <ThemeCard theme={theme} />}</For>
          </div>
          <Show when={pages() > 1}>
            <Pager page={current()} pages={pages()} onPage={setPage} />
          </Show>
        </section>
      </Match>
    </Switch>
  )
}

function FeaturedTheme(props: { theme: ExploreTheme }): JSX.Element {
  return (
    <section class="overflow-hidden rounded-lg bg-card shadow-ring">
      <ThemePreview
        palette={themePalette(props.theme)}
        variant={props.theme.scheme}
        effect={props.theme.effect}
        label={props.theme.label}
        class="rounded-none"
      />
      <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="min-w-0">
          <span class="text-xs text-ink-2">Featured</span>
          <h2 class="text-lg text-ink">{props.theme.label}</h2>
          <p class="mt-0.5 text-sm text-ink-2">{props.theme.description}</p>
          <p class="mt-1 text-xs text-ink-2">By {props.theme.author}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <a
            href={`#${themePath(props.theme.id)}`}
            class="ex-color inline-flex h-7 items-center rounded-sm px-2.5 text-sm font-medium text-ink shadow-ring hover:bg-hover"
          >
            Details
          </a>
          <AddThemeButton id={props.theme.id} />
        </div>
      </div>
    </section>
  )
}

function ThemeCard(props: { theme: ExploreTheme }): JSX.Element {
  const added = (): boolean => isCatalogThemeAdded(themeSource(props.theme.id))
  return (
    <a href={`#${themePath(props.theme.id)}`} class="group flex flex-col gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-focus">
      <span class="ex-color block overflow-hidden rounded-md shadow-ring group-hover:shadow-[0_0_0_1px_var(--color-line-3)]">
        <ThemePreview
          palette={themePalette(props.theme)}
          variant={props.theme.scheme}
          effect={props.theme.effect}
          label={props.theme.label}
        />
      </span>
      <span class="flex items-center gap-2 px-0.5">
        <Swatch palette={themePalette(props.theme)} />
        <span class="truncate text-sm font-medium text-ink">{props.theme.label}</span>
        <Show when={added()}>
          <span class="rounded-xs bg-secondary px-1 text-2xs text-ink-2">Added</span>
        </Show>
        <span class="ml-auto shrink-0 text-xs text-ink-2">{props.theme.author}</span>
      </span>
    </a>
  )
}
