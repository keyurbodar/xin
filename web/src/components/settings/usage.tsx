import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { money } from "../../lib/format.ts"
import {
  errorMessage,
  modelName,
  models,
  setUsageAlert,
  setUsageCap,
  usage,
  type UsageDay,
  type UsageSummary,
} from "../../state/settings.ts"
import { Button, Empty, Failure, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph, type GlyphName } from "../extensions/glyph.tsx"
import { Group, Saved } from "./parts.tsx"

type Recorded = Extract<UsageSummary, { readonly recorded: true }>
type Range = "7d" | "month" | "prev"

const RANGES: readonly { readonly key: Range; readonly label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "prev", label: "Last month" },
]

const iso = (date: Date): string => date.toISOString().slice(0, 10)

/** Every day of a range, so a quiet day keeps its slot instead of the chart closing the gap. */
function windowOf(range: Range, today = new Date()): readonly string[] {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const start =
    range === "7d"
      ? new Date(end.getTime() - 6 * 86_400_000)
      : range === "month"
        ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
        : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1))
  const last =
    range === "prev" ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)) : end
  const days: string[] = []
  for (let at = start.getTime(); at <= last.getTime(); at += 86_400_000) days.push(iso(new Date(at)))
  return days
}

export function Usage(): JSX.Element {
  const [range, setRange] = createSignal<Range>("month")
  const [table, setTable] = createSignal(false)
  onMount(() => {
    void usage.reload()
    void models.reload()
  })

  const value = (): Recorded | undefined => {
    const state = usage.state()
    return state.kind === "ready" && state.value.recorded ? state.value : undefined
  }

  const notRecorded = (): boolean => {
    const state = usage.state()
    return state.kind === "ready" && !state.value.recorded
  }

  const days = (summary: Recorded): readonly UsageDay[] => {
    const byDay = new Map(summary.days.map((day) => [day.day, day]))
    return windowOf(range()).map((day) => byDay.get(day) ?? { day, spend: 0, tokens: 0 })
  }

  return (
    <div class="flex max-w-[900px] flex-col gap-6">
      <div class="flex flex-wrap items-center gap-2">
        <span class="label">Usage + cost</span>
        <span class="text-[12px] text-fg-3">Billed by day, in UTC</span>
        <div class="ml-auto flex items-center gap-1">
          <For each={RANGES}>
            {(entry) => (
              <button
                type="button"
                onClick={() => setRange(entry.key)}
                class="rounded-[2px] px-2 py-1 text-[12px]"
                classList={{
                  "bg-hover text-fg": range() === entry.key,
                  "text-fg-3 hover:text-fg": range() !== entry.key,
                }}
              >
                {entry.label}
              </button>
            )}
          </For>
          <button
            type="button"
            onClick={() => setTable((shown) => !shown)}
            class="rounded-[2px] px-2 py-1 text-[12px] text-fg-3 hover:text-fg"
          >
            {table() ? "Chart" : "Table"}
          </button>
        </div>
      </div>

      <Show when={usage.state().kind === "loading"}>
        <Pending label="Reading usage" />
      </Show>
      <Show when={failureOf(usage.state())}>
        {(message) => <Failure message={message()} onRetry={() => void usage.reload()} />}
      </Show>

      <Show when={notRecorded()}>
        <Empty
          title="Not recorded yet."
          detail="The usage ledger has no figures to show. Spend, token counts and per-model totals appear here once usage.summary answers."
        >
          <Button size="sm" variant="quiet" onClick={() => void usage.reload()}>Check again</Button>
        </Empty>
      </Show>

      <Show when={value()}>
        {(summary) => {
          const spent = (): number => days(summary()).reduce((sum, day) => sum + day.spend, 0)
          const tokens = (): number => days(summary()).reduce((sum, day) => sum + day.tokens, 0)
          const label = (): string => RANGES.find((entry) => entry.key === range())?.label ?? ""
          return (
            <>
              <div class="grid grid-cols-2 overflow-hidden rounded-[4px] border border-line md:grid-cols-4">
                <Kpi label={`Spend · ${label()}`} value={money(spent())} detail="Model and tool cost" />
                <Kpi label="Tokens" value={formatTokens(tokens())} detail="In this range" />
                <Kpi label="Models used" value={String(summary().byModel.length)} detail="In this home" />
                <Kpi label="Tools used" value={String(summary().byTool.length)} detail="In this home" />
              </div>

              <Group
                title="Daily spend"
                detail={
                  summary().alert > 0
                    ? `USD · dashed line is your ${money(summary().alert)} daily alert`
                    : "USD, one bar per day"
                }
              >
                <Show when={!table()} fallback={<DayTable days={days(summary())} />}>
                  <SpendChart days={days(summary())} alert={summary().alert} />
                </Show>
              </Group>

              <div class="grid gap-6 lg:grid-cols-2">
                <div class="min-w-0">
                  <Group title="By project" detail="Sorted by cost">
                    <UsageTable
                      tokens={true}
                      empty="Projects appear here once they run."
                      rows={summary()
                        .byProject.filter((entry) => entry.spend > 0 || entry.tokens > 0)
                        .map(
                          (entry): Row => ({
                            key: entry.id,
                            name: entry.name,
                            detail: "",
                            tokens: entry.tokens,
                            cost: entry.spend,
                            glyph: "briefcase",
                          }),
                        )}
                    />
                  </Group>
                </div>

                <div class="min-w-0">
                  <Group title="By model" detail="Sorted by cost">
                    <UsageTable
                      empty="No model usage is recorded."
                      rows={summary().byModel.map((entry) => ({
                        key: entry.name,
                        name: modelName(entry.provider, entry.modelId) ?? (entry.modelId === "" ? entry.name : entry.modelId),
                        detail: entry.provider === "" ? entry.name : entry.provider,
                        tokens: entry.totalTokens,
                        cost: entry.cost,
                      }))}
                    />
                  </Group>
                </div>
              </div>

              <Group title="By tool" detail="Sorted by cost">
                <UsageTable
                  empty="No tool usage is recorded."
                  rows={summary().byTool.map((entry) => ({
                    key: entry.name,
                    name: entry.name,
                    detail: "",
                    tokens: entry.totalTokens,
                    cost: entry.cost,
                  }))}
                />
              </Group>

              <Limits summary={summary()} />

              <Note>
                Days are cut at midnight UTC and a run that crosses it counts once, in the day it finishes. Project
                spend comes from each project's coordinator and thread conversations. Absent figures stay absent
                instead of being estimated.
              </Note>
            </>
          )
        }}
      </Show>
    </div>
  )
}

function Kpi(props: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div class="border-b border-r border-line px-3.5 py-3 last:border-r-0">
      <span class="label">{props.label}</span>
      <span class="mt-2 block text-[24px] font-light tracking-[-0.02em]">{props.value}</span>
      <span class="mt-0.5 block text-[11.5px] text-fg-3">{props.detail}</span>
    </div>
  )
}

function SpendChart(props: { days: readonly UsageDay[]; alert: number }): JSX.Element {
  const [hover, setHover] = createSignal<number | undefined>(undefined)
  const peak = (): number => Math.max(...props.days.map((day) => day.spend))
  const top = (): number => Math.max(0.01, Math.ceil(Math.max(peak(), props.alert) * 100) / 100)
  const alertAt = (): number => (1 - props.alert / top()) * 100
  return (
    <Panel>
      <Show
        when={peak() > 0 || props.alert > 0}
        fallback={
          <p class="px-3.5 py-6 text-[12.5px] text-fg-3">
            No spend in this range. The models that answered report no cost, so only tokens are recorded.
          </p>
        }
      >
      <div class="flex gap-3 px-3.5 pt-3">
        <div class="flex h-[132px] w-9 shrink-0 flex-col justify-between pb-5 text-right font-mono text-[10px] text-fg-4">
          <span>{money(top())}</span>
          <span>{money(top() / 2)}</span>
          <span>{money(0)}</span>
        </div>
        <div class="relative min-w-0 flex-1">
          <div class="pointer-events-none absolute inset-x-0 top-0 h-[132px]">
            <div class="absolute inset-x-0 top-0 border-t border-dashed border-line" />
            <div class="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
            <Show when={props.alert > 0}>
              <div
                class="absolute inset-x-0 border-t border-dashed border-fg-4"
                style={{ top: `${alertAt()}%` }}
                aria-hidden="true"
              />
            </Show>
          </div>
          <div class="flex h-[132px] items-end gap-[2px]">
            <For each={props.days}>
              {(day, index) => (
                <div
                  class="group relative flex h-full min-w-0 flex-1 items-end"
                  onMouseEnter={() => setHover(index())}
                  onMouseLeave={() => setHover(undefined)}
                  role="img"
                  aria-label={`${day.day}: ${money(day.spend)}, ${formatTokens(day.tokens)} tokens`}
                >
                  <div
                    class="w-full rounded-t-[1px]"
                    classList={{
                      "bg-fg-2": day.spend > 0,
                      "bg-line": day.spend === 0,
                      "opacity-100": hover() === index(),
                      "opacity-70": hover() !== index() && day.spend > 0,
                    }}
                    style={{ height: day.spend > 0 ? `${Math.max(3, (day.spend / top()) * 100)}%` : "1px" }}
                  />
                </div>
              )}
            </For>
          </div>
          <div class="mt-1 flex items-center justify-between font-mono text-[10px] text-fg-4">
            <span>{props.days[0]?.day.slice(5)}</span>
            <span>{props.days.at(-1)?.day.slice(5)}</span>
          </div>
          <Show when={hover()}>
            {(index) => (
              <div
                class="pointer-events-none absolute bottom-[calc(100%-132px)] z-10 -translate-x-1/2 rounded-[2px] border border-line-inner bg-surface px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
                style={{ left: `${((index() + 0.5) / props.days.length) * 100}%` }}
              >
                <span class="block font-mono text-[10.5px] text-fg-3">{props.days[index()]?.day}</span>
                <span class="block text-[12px] text-fg">{money(props.days[index()]?.spend ?? 0)}</span>
                <span class="block text-[11px] text-fg-3">{formatTokens(props.days[index()]?.tokens ?? 0)} tokens</span>
              </div>
            )}
          </Show>
        </div>
      </div>
      </Show>
      <div class="h-3" />
    </Panel>
  )
}

function Limits(props: { summary: Recorded }): JSX.Element {
  const [capText, setCapText] = createSignal(props.summary.cap === null ? "" : String(props.summary.cap))
  const [alertText, setAlertText] = createSignal(props.summary.alert > 0 ? String(props.summary.alert) : "")
  const [capBusy, setCapBusy] = createSignal(false)
  const [alertBusy, setAlertBusy] = createSignal(false)
  const [capError, setCapError] = createSignal<string | undefined>(undefined)
  const [alertError, setAlertError] = createSignal<string | undefined>(undefined)
  const [capSaved, setCapSaved] = createSignal(false)
  const [alertSaved, setAlertSaved] = createSignal(false)

  const cap = (): number | null => props.summary.cap
  const share = (): number => {
    const limit = cap()
    if (limit === null || limit <= 0) return 0
    return Math.min(100, (props.summary.month / limit) * 100)
  }
  const capLabel = (): string => {
    const limit = cap()
    return limit === null ? "Not set" : `${money(props.summary.month)} of ${money(limit)} · alert at 80%`
  }

  const saveCap = async (): Promise<void> => {
    if (capBusy()) return
    setCapError(undefined)
    setCapSaved(false)
    const usd = usdOf(capText())
    if (usd === undefined || usd <= 0) {
      setCapError("Enter a monthly cap above $0, like 25 or 150.50.")
      return
    }
    setCapBusy(true)
    try {
      await setUsageCap(usd)
      setCapText(String(usd))
      setCapSaved(true)
      window.setTimeout(() => setCapSaved(false), 2400)
    } catch (failure: unknown) {
      setCapError(errorMessage(failure))
    } finally {
      setCapBusy(false)
    }
  }

  const clearCap = async (): Promise<void> => {
    if (capBusy()) return
    setCapError(undefined)
    setCapSaved(false)
    setCapBusy(true)
    try {
      await setUsageCap(null)
      setCapText("")
    } catch (failure: unknown) {
      setCapError(errorMessage(failure))
    } finally {
      setCapBusy(false)
    }
  }

  const saveAlert = async (): Promise<void> => {
    if (alertBusy()) return
    setAlertError(undefined)
    setAlertSaved(false)
    const usd = usdOf(alertText())
    if (usd === undefined || usd < 0) {
      setAlertError("Enter a daily alert of $0 or more.")
      return
    }
    setAlertBusy(true)
    try {
      await setUsageAlert(usd)
      setAlertText(usd > 0 ? String(usd) : "")
      setAlertSaved(true)
      window.setTimeout(() => setAlertSaved(false), 2400)
    } catch (failure: unknown) {
      setAlertError(errorMessage(failure))
    } finally {
      setAlertBusy(false)
    }
  }

  return (
    <Panel>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 pb-2.5 pt-3.5">
        <span class="text-[12.5px] font-medium text-fg">Monthly cap</span>
        <span class="text-[11.5px] text-fg-3">Threads pause at the cap and ask you</span>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <span class="font-mono text-[11.5px] text-fg-2">{capLabel()}</span>
          <DollarField
            label="Monthly cap in USD"
            value={capText()}
            onInput={setCapText}
            onEnter={() => void saveCap()}
          />
          <Button size="sm" variant="primary" disabled={capBusy()} onClick={() => void saveCap()}>
            {capBusy() ? "Saving" : "Set"}
          </Button>
          <Show when={cap() !== null}>
            <Button size="sm" variant="quiet" disabled={capBusy()} onClick={() => void clearCap()}>
              Clear
            </Button>
          </Show>
          <Saved show={capSaved()} />
        </div>
      </div>

      <div class="px-3.5 pb-3">
        <div class="relative h-1.5 rounded-[1px] bg-line">
          <div class="h-full rounded-[1px] bg-fg-2" style={{ width: `${share()}%` }} />
          <Show when={cap() !== null}>
            <span class="absolute -top-0.5 -bottom-0.5 w-px bg-fg-3" style={{ left: "80%" }} aria-hidden="true" />
          </Show>
        </div>
      </div>

      <Show when={capError()}>
        {(message) => <p class="px-3.5 pb-3 text-[11.5px] text-bad">{message()}</p>}
      </Show>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3.5 py-3">
        <span class="text-[12.5px] font-medium text-fg">Daily alert</span>
        <span class="text-[11.5px] text-fg-3">The dashed line on the daily chart; $0 turns it off</span>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <DollarField
            label="Daily alert in USD"
            value={alertText()}
            onInput={setAlertText}
            onEnter={() => void saveAlert()}
          />
          <Button size="sm" variant="ghost" disabled={alertBusy()} onClick={() => void saveAlert()}>
            {alertBusy() ? "Saving" : "Save"}
          </Button>
          <Saved show={alertSaved()} />
        </div>
      </div>

      <Show when={alertError()}>
        {(message) => <p class="px-3.5 pb-3 text-[11.5px] text-bad">{message()}</p>}
      </Show>
    </Panel>
  )
}

function DollarField(props: {
  label: string
  value: string
  onInput: (next: string) => void
  onEnter: () => void
}): JSX.Element {
  return (
    <label class="flex h-8 w-[104px] items-center gap-1 rounded-[2px] border border-line-inner bg-page px-2 focus-within:border-line-strong">
      <span class="font-mono text-[12px] text-fg-3" aria-hidden="true">$</span>
      <input
        type="text"
        inputmode="decimal"
        aria-label={props.label}
        placeholder="0"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onEnter()
        }}
        class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg outline-none placeholder:text-fg-4"
      />
    </label>
  )
}

function usdOf(text: string): number | undefined {
  const raw = text.trim().replace(/[$,]/gu, "")
  if (raw === "") return undefined
  const usd = Number(raw)
  if (!Number.isFinite(usd)) return undefined
  return Math.round(usd * 100) / 100
}

function DayTable(props: { days: readonly UsageDay[] }): JSX.Element {
  const shown = (): readonly UsageDay[] => props.days.filter((day) => day.spend > 0 || day.tokens > 0)
  return (
    <Panel>
      <div class="grid grid-cols-[minmax(0,1fr)_72px_80px] items-center gap-2 border-b border-line px-3.5 py-2">
        <span class="label">Day</span>
        <span class="label text-right">Tokens</span>
        <span class="label text-right">Spend</span>
      </div>
      <Show
        when={shown().length > 0}
        fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">No spend is recorded in this range.</div>}
      >
        <For each={shown()}>
          {(day) => (
            <div class="grid grid-cols-[minmax(0,1fr)_72px_80px] items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
              <span class="font-mono text-[11.5px] text-fg-2">{day.day}</span>
              <span class="text-right font-mono text-[11.5px] text-fg-2">{formatTokens(day.tokens)}</span>
              <span class="text-right font-mono text-[11.5px] text-fg-2">{money(day.spend)}</span>
            </div>
          )}
        </For>
      </Show>
    </Panel>
  )
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "—"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

type Row = {
  readonly key: string
  readonly name: string
  readonly detail: string
  readonly tokens: number
  readonly cost: number
  readonly glyph?: GlyphName | undefined
}

function UsageTable(props: { rows: readonly Row[]; empty: string; tokens?: boolean | undefined }): JSX.Element {
  const max = (): number => Math.max(0.0001, ...props.rows.map((row) => row.cost))
  const withTokens = (): boolean => props.tokens !== false
  const columns = (): string =>
    withTokens() ? "grid-cols-[minmax(0,1fr)_72px_64px_80px]" : "grid-cols-[minmax(0,1fr)_64px_80px]"
  return (
    <Panel>
      <div class={`grid ${columns()} items-center gap-2 border-b border-line px-3.5 py-2`}>
        <span class="label">Name</span>
        <Show when={withTokens()}>
          <span class="label text-right">Tokens</span>
        </Show>
        <span class="label">Share</span>
        <span class="label text-right">Cost</span>
      </div>
      <Show when={props.rows.length > 0} fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">{props.empty}</div>}>
        <For each={props.rows}>
          {(row) => (
            <div class={`grid ${columns()} items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0`}>
              <span class="flex min-w-0 items-center gap-1.5">
                <Show when={row.glyph}>
                  {(glyph) => <Glyph name={glyph()} size={13} class="shrink-0 text-fg-3" />}
                </Show>
                <span class="min-w-0">
                  <span class="block truncate text-fg">{row.name}</span>
                  <Show when={row.detail !== ""}>
                    <span class="block truncate text-[11px] text-fg-3">{row.detail}</span>
                  </Show>
                </span>
              </span>
              <Show when={withTokens()}>
                <span class="text-right font-mono text-[11.5px] text-fg-2">{formatTokens(row.tokens)}</span>
              </Show>
              <span class="h-1.5 overflow-hidden rounded-[1px] bg-line">
                <span
                  class="block h-full rounded-[1px] bg-fg-2"
                  style={{ width: `${Math.round((row.cost / max()) * 100)}%` }}
                />
              </span>
              <span class="text-right font-mono text-[11.5px] text-fg-2">{money(row.cost)}</span>
            </div>
          )}
        </For>
      </Show>
    </Panel>
  )
}
