import { For, onMount, Show, type JSX } from "solid-js"
import { money } from "../../lib/format.ts"
import { usage, type UsageSummary } from "../../state/settings.ts"
import { Button, Empty, Failure, MissingOp, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Group } from "./parts.tsx"

type Recorded = Extract<UsageSummary, { readonly recorded: true }>

export function Usage(): JSX.Element {
  onMount(() => {
    void usage.reload()
  })

  const value = (): Recorded | undefined => {
    const state = usage.state()
    return state.kind === "ready" && state.value.recorded ? state.value : undefined
  }

  const notRecorded = (): boolean => {
    const state = usage.state()
    return state.kind === "ready" && !state.value.recorded
  }

  return (
    <div class="flex max-w-[900px] flex-col gap-6">
      <div class="flex items-center gap-2">
        <span class="label">Usage + cost</span>
        <span class="text-[12px] text-fg-3">Life of this home</span>
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
          <Button label="Check again" variant="ghost" onClick={() => void usage.reload()} />
        </Empty>
      </Show>

      <Show when={value()}>
        {(summary) => (
          <>
            <div class="grid grid-cols-2 overflow-hidden rounded-[4px] border border-line md:grid-cols-4">
              <Kpi label="Spend" value={money(summary().spend)} detail="Across every model and tool" />
              <Kpi label="Tokens" value={formatTokens(summary().tokens)} detail="Input, output and cache" />
              <Kpi label="Models used" value={String(summary().byModel.length)} detail="From the catalog" />
              <Kpi label="Tools used" value={String(summary().byTool.length)} detail="Every tool call counted once" />
            </div>

            <Group title="By model" detail="Sorted by cost">
              <UsageTable
                empty="No model usage is recorded."
                rows={summary().byModel.map((entry) => ({
                  key: entry.name,
                  name: entry.modelId === "" ? entry.name : entry.modelId,
                  detail: entry.provider === "" ? entry.name : entry.provider,
                  tokens: entry.totalTokens,
                  cost: entry.cost,
                }))}
              />
            </Group>

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

            <Group title="Monthly cap" detail="Threads pause at the cap and ask you">
              <div class="flex items-center gap-2">
                <span class="text-[12.5px] text-fg-2">Not set</span>
                <MissingOp op="usage.cap" detail="The ledger records spend; it stores no cap or alert threshold." />
              </div>
            </Group>

            <Note>
              The ledger has no time bucket and no project dimension yet, so these totals cover the life of the home rather
              than a month, and nothing here splits spend by project. Absent figures stay absent instead of being estimated.
            </Note>
          </>
        )}
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
}

function UsageTable(props: { rows: readonly Row[]; empty: string }): JSX.Element {
  const max = (): number => Math.max(0.0001, ...props.rows.map((row) => row.cost))
  return (
    <Panel>
      <div class="grid grid-cols-[minmax(0,1fr)_72px_64px_80px] items-center gap-2 border-b border-line px-3.5 py-2">
        <span class="label">Name</span>
        <span class="label text-right">Tokens</span>
        <span class="label">Share</span>
        <span class="label text-right">Cost</span>
      </div>
      <Show when={props.rows.length > 0} fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">{props.empty}</div>}>
        <For each={props.rows}>
          {(row) => (
            <div class="grid grid-cols-[minmax(0,1fr)_72px_64px_80px] items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
              <span class="min-w-0">
                <span class="block truncate text-fg">{row.name}</span>
                <Show when={row.detail !== ""}>
                  <span class="block truncate text-[11px] text-fg-3">{row.detail}</span>
                </Show>
              </span>
              <span class="text-right font-mono text-[11.5px] text-fg-2">{formatTokens(row.tokens)}</span>
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

// The ledger's bucket also carries input/output/cache splits; the pane shows totals and cost,
// which are the two figures a reader can act on.
