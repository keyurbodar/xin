import "@ui-sdk/web/collapsible"
import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { CalendarClock, ChevronLeft, ChevronRight, Pencil, SkipForward, Timer, Webhook } from "lucide-solid"
import {
  batchGroupLabel,
  nextLabel,
  RUN_SOURCE_WORD,
  runDuration,
  runSignal,
  TARGET_WORD,
  triggerSummary,
  untilLabel,
  type Automation,
  type AutomationRun,
  type AutomationTrigger,
  type Batch,
} from "../../lib/automations.ts"
import { count, money } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { STATE_WORD } from "../../lib/status.ts"
import { createAutomationHistory, RUNS_PAGE } from "../../state/automations.ts"
import { homeProjects } from "../../state/home.ts"
import { EmptyState, ResourceError } from "../chat/ui.tsx"
import { ICON_BUTTON } from "../shell/menu.ts"
import { createOverlayMount } from "../shell/presence.ts"
import { Loading, RowSkeleton } from "../ui/skeleton.tsx"
import { Signal } from "../ui/signal.tsx"
import { createAutomationActions, createRowDialogs, EnabledToggle, RowMenu } from "./parts.tsx"
import { WebhookUrl } from "./triggers.tsx"

const ICON = { size: 14, "stroke-width": 1.5 } as const

const RUN_GRID = "grid grid-cols-[20px_minmax(0,1fr)_88px_64px_64px_16px] items-center gap-3 md:grid-cols-[20px_minmax(0,1fr)_96px_72px_80px_80px_16px]"

const PAGER_BUTTON =
  "im-press h-7 rounded-sm px-2 text-small text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink disabled:text-icon"

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

function TriggerIcon(props: { kind: AutomationTrigger["kind"] }): JSX.Element {
  return (
    <Switch>
      <Match when={props.kind === "schedule"}>
        <CalendarClock {...ICON} />
      </Match>
      <Match when={props.kind === "once"}>
        <Timer {...ICON} />
      </Match>
      <Match when={props.kind === "webhook"}>
        <Webhook {...ICON} />
      </Match>
    </Switch>
  )
}

function Section(props: { title: string; meta?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex h-6 items-baseline gap-2 px-1">
        <h2 class="text-small font-title text-ink-2">{props.title}</h2>
        <Show when={props.meta}>{(meta) => <span class="font-mono text-xs tabular-nums text-ink-3">{meta()}</span>}</Show>
      </div>
      {props.children}
    </section>
  )
}

function Fact(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex min-w-0 items-baseline gap-3">
      <span class="w-20 shrink-0 text-sm text-ink-3">{props.label}</span>
      <span class="min-w-0 flex-1 truncate text-sm text-ink">{props.children}</span>
    </div>
  )
}

function Overview(props: { automation: Automation; enabled: boolean }): JSX.Element {
  const project = (): string => homeProjects().find((item) => item.id === props.automation.project)?.name ?? "No project"
  return (
    <div class="grid gap-4 rounded-lg border border-line-1 bg-card p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-sm text-ink-3">Prompt</span>
        <p class="max-h-40 overflow-y-auto whitespace-pre-wrap text-base text-ink">{props.automation.prompt}</p>
      </div>
      <div class="flex flex-col gap-2 md:border-l md:border-line-1 md:pl-4">
        <Fact label="Project">{project()}</Fact>
        <Fact label="Runs go to">{TARGET_WORD[props.automation.target]}</Fact>
        <Fact label="Next run">
          <span class="font-mono text-xs">{nextLabel({ ...props.automation, enabled: props.enabled })}</span>
        </Fact>
      </div>
      <div class="flex flex-col gap-2 md:col-span-2">
        <span class="text-sm text-ink-3">Triggers</span>
        <Show when={props.automation.triggers.length > 0} fallback={<span class="text-sm text-ink-2">None: it runs only when you press Run now.</span>}>
          <For each={props.automation.triggers}>
            {(trigger) => (
              <div class="flex min-w-0 flex-col gap-1.5 rounded-md border border-line-1 bg-panel px-3 py-2">
                <div class="flex items-center gap-2 text-sm text-ink-2">
                  <span class="text-ink-3">
                    <TriggerIcon kind={trigger.kind} />
                  </span>
                  <span class="min-w-0 flex-1 truncate">{triggerSummary(trigger)}</span>
                  <Show when={trigger.kind === "webhook" && (trigger.contains.length > 0 || trigger.regex !== null)}>
                    <span class="truncate text-xs text-ink-3">filtered</span>
                  </Show>
                </div>
                <Show when={trigger.kind === "webhook" ? trigger.path : undefined}>{(path) => <WebhookUrl path={path()} />}</Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function Batches(props: { batches: readonly Batch[] }): JSX.Element {
  return (
    <Show when={props.batches.length > 0}>
      <Section title="Open batches" meta={String(props.batches.length)}>
        <div class="overflow-hidden rounded-lg border border-line-1 bg-card">
          <For each={props.batches}>
            {(batch) => (
              <div class="flex h-10 items-center gap-3 border-b border-line-1 px-4 text-sm last:border-0">
                <span class="text-ink-3">
                  <Webhook {...ICON} />
                </span>
                <span class="text-ink">{count(batch.count, "delivery", "deliveries")}</span>
                <Show when={batch.group !== ""}>
                  <code class="min-w-0 truncate font-mono text-xs text-ink-3">{batchGroupLabel(batch.group)}</code>
                </Show>
                <span class="ml-auto font-mono text-xs tabular-nums text-ink-2" title={new Date(batch.closeAt).toLocaleString()}>
                  closes {untilLabel(batch.closeAt)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Section>
    </Show>
  )
}

function RunRow(props: { run: AutomationRun; slug: string | undefined }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const detail = createOverlayMount(open)
  const thread = (): string | undefined =>
    props.run.threadId === null || props.slug === undefined ? undefined : `/p/${props.slug}/run/${props.run.threadId}`
  const state = () => runSignal(props.run.status)
  return (
    <ui-collapsible
      class="block border-b border-line-1 last:border-0"
      on:openchange={(event) => setOpen(event.detail.value)}
      on:openchangecomplete={detail.settle}
    >
      <ui-collapsible-trigger>
        <button type="button" class={`im-hover h-[var(--h-list-row)] w-full px-4 text-left ${RUN_GRID}`}>
        <Signal state={state()} size={14} />
        <span class="min-w-0 truncate text-sm text-ink">
          {when(props.run.createdAt)}
          <span class="ml-2 text-ink-3">{STATE_WORD[state()]}</span>
        </span>
        <span class="inline-flex h-5 w-max max-w-full items-center rounded-xs border border-line-2 px-1.5 text-xs text-ink-2">
          {RUN_SOURCE_WORD[props.run.source]}
        </span>
        <span class="font-mono text-xs tabular-nums text-ink-3">{props.run.inputs > 1 ? `×${props.run.inputs}` : ""}</span>
        <span class="hidden font-mono text-xs tabular-nums text-ink-3 md:block">{runDuration(props.run) ?? "—"}</span>
        <span class="text-right font-mono text-xs tabular-nums text-ink-2">{props.run.cost === null ? "—" : money(props.run.cost)}</span>
        <span class="im-chevron text-ink-3" data-open={open() ? "" : undefined} aria-hidden="true">
          <ChevronRight {...ICON} />
        </span>
        </button>
      </ui-collapsible-trigger>
      <ui-collapsible-panel class="im-grow">
        <div>
          <Show when={detail.mounted()}>
          <div class="flex flex-col gap-3 px-4 pb-4 pl-12">
            <Show when={props.run.error}>
              {(error) => (
                <div class="rounded-md border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">{error()}</div>
              )}
            </Show>
            <Show when={props.run.input}>
              {(input) => (
                <pre class="max-h-48 overflow-auto rounded-md border border-line-1 bg-secondary px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink-2">
                  {input()}
                </pre>
              )}
            </Show>
            <div class="flex items-center gap-3">
              <Show when={thread()}>
                {(to) => (
                  <button
                    type="button"
                    onClick={() => navigate(to())}
                    class="im-press flex h-7 items-center gap-1.5 rounded-sm border border-line-2 bg-card px-2.5 text-sm text-ink hover:border-line-3"
                  >
                    Open thread
                  </button>
                )}
              </Show>
              <span class="ml-auto font-mono text-xs text-ink-3">{props.run.id}</span>
            </div>
          </div>
          </Show>
        </div>
      </ui-collapsible-panel>
    </ui-collapsible>
  )
}

/** One automation: what it is, its open batches and its run history, reloaded on each revision bump. */
export function AutomationHistoryView(props: { id: string }): JSX.Element {
  const history = createAutomationHistory(() => props.id)
  const automation = createMemo(() => history.value()?.automation)
  const actions = createAutomationActions(() => {
    const current = automation()
    return current === undefined ? undefined : [current]
  })
  const rows = createRowDialogs(actions, { onDeleted: () => navigate("/automations") })
  const slug = (): string | undefined => homeProjects().find((item) => item.id === automation()?.project)?.slug
  const missing = (): boolean => history.detail.error !== undefined
  const [wanted, setPage] = createSignal(0)
  const pages = (): number => Math.max(1, Math.ceil(history.runs().length / RUNS_PAGE))
  const page = (): number => Math.min(wanted(), pages() - 1)
  const pageRuns = (): readonly AutomationRun[] => history.runs().slice(page() * RUNS_PAGE, (page() + 1) * RUNS_PAGE)
  const canNext = (): boolean => page() + 1 < pages() || history.hasOlder()
  const next = async (): Promise<void> => {
    if (page() + 1 >= pages()) await history.loadOlder()
    if (page() + 1 < pages()) setPage(page() + 1)
  }

  return (
    <>
      <header class="flex h-[var(--h-topbar)] shrink-0 items-center gap-2 border-b border-line-1 pl-2 pr-4">
        <button type="button" class={ICON_BUTTON} aria-label="All automations" onClick={() => navigate("/automations")}>
          <ChevronLeft size={16} stroke-width={1.5} />
        </button>
        <button type="button" class="text-base text-ink-3 hover:text-ink" onClick={() => navigate("/automations")}>
          Automations
        </button>
        <span class="text-ink-3">/</span>
        <h1 class="min-w-0 truncate text-body font-title text-ink">{automation()?.title ?? ""}</h1>
        <Show when={automation()}>
          {(current) => (
            <span class="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => rows.handle(current(), "run")}
                class="im-press flex h-7 items-center gap-1.5 rounded-sm bg-primary px-2.5 text-sm font-title text-on-primary hover:opacity-90"
              >
                <SkipForward {...ICON} />
                Run now
              </button>
              <button
                type="button"
                onClick={() => rows.handle(current(), "edit")}
                class="im-press flex h-7 items-center gap-1.5 rounded-sm border border-line-2 bg-card px-2.5 text-sm text-ink hover:border-line-3"
              >
                <Pencil {...ICON} />
                Edit
              </button>
              <span class="mx-1 h-4 w-px bg-line-2" />
              <EnabledToggle
                automation={current()}
                on={actions.enabled(current())}
                busy={actions.busy() === current().id}
                onToggle={() => rows.handle(current(), "toggle")}
              />
              <RowMenu
                automation={current()}
                enabled={actions.enabled(current())}
                busy={actions.busy() === current().id}
                withHistory={false}
                onAction={(action) => rows.handle(current(), action)}
              />
            </span>
          )}
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-4 pb-12 pt-5 md:px-6">
          <Show when={actions.failed()}>
            {(message) => (
              <div role="alert" class="im-event rounded-md border border-failed/30 bg-failed-soft px-3 py-2 text-sm text-failed">
                {message()}
              </div>
            )}
          </Show>
          <Show
            when={!missing()}
            fallback={
              <div class="flex flex-col gap-4 pt-10">
                <EmptyState
                  pictogram="schedules"
                  title="Automation not found"
                  detail="It may have been deleted, or the address is wrong."
                />
                <div class="overflow-hidden rounded-md border border-line-1">
                  <ResourceError what="this automation" error={history.detail.error} onRetry={history.retry} />
                </div>
              </div>
            }
          >
            <Loading when={history.value() === undefined} skeleton={<RowSkeleton rows={5} />} label="Loading automation">
              <Show when={automation()}>
                {(current) => (
                  <div class="flex flex-col gap-6">
                    <Overview automation={current()} enabled={actions.enabled(current())} />
                    <Batches batches={history.value()?.batches ?? []} />
                    <Section title="Runs" meta={history.runs().length > 0 ? String(history.runs().length) + (history.hasOlder() ? "+" : "") : undefined}>
                      <Show
                        when={history.runs().length > 0}
                        fallback={
                          <div class="flex items-center gap-3 rounded-lg border border-dashed border-line-2 px-4 py-5">
                            <span class="text-sm text-ink-3">No runs yet. The first one shows up here as it starts.</span>
                            <button
                              type="button"
                              onClick={() => rows.handle(current(), "run")}
                              class="im-press ml-auto h-7 rounded-sm border border-line-2 bg-card px-2.5 text-sm text-ink hover:border-line-3"
                            >
                              Run now
                            </button>
                          </div>
                        }
                      >
                        <div class="overflow-hidden rounded-lg border border-line-1 bg-card">
                          <div class={`h-8 border-b border-line-1 px-4 text-xs text-ink-3 ${RUN_GRID}`}>
                            <span />
                            <span>Started</span>
                            <span>Source</span>
                            <span>Inputs</span>
                            <span class="hidden md:block">Took</span>
                            <span class="text-right">Cost</span>
                            <span />
                          </div>
                          <For each={pageRuns()}>{(run) => <RunRow run={run} slug={slug()} />}</For>
                        </div>
                        <Show when={history.runs().length >= RUNS_PAGE} fallback={<span class="pt-1 text-center text-mini text-ink-3">That's every run.</span>}>
                          <nav aria-label="Run pages" class="flex items-center justify-center gap-1 pt-1">
                            <button type="button" class={PAGER_BUTTON} disabled={page() === 0} onClick={() => setPage(page() - 1)}>
                              Previous
                            </button>
                            <span class="text-icon" aria-hidden="true">
                              ·
                            </span>
                            <span aria-live="polite" data-testid="run-page" class="px-1 text-small tabular-nums text-ink-3">
                              {history.hasOlder() ? `Page ${page() + 1}` : `${page() + 1} of ${pages()}`}
                            </span>
                            <span class="text-icon" aria-hidden="true">
                              ·
                            </span>
                            <button type="button" class={PAGER_BUTTON} disabled={!canNext() || history.loadingOlder()} onClick={() => void next()}>
                              {history.loadingOlder() ? "Loading…" : "Next"}
                            </button>
                          </nav>
                        </Show>
                        <Show when={history.olderFailed()}>{(text) => <span class="text-center text-sm text-failed">{text()}</span>}</Show>
                      </Show>
                    </Section>
                  </div>
                )}
              </Show>
            </Loading>
          </Show>
        </div>
      </div>
      {rows.dialogs()}
    </>
  )
}
