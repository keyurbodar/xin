import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { CalendarClock, Check, Copy, Plus, RefreshCw, Timer, Webhook, X } from "lucide-solid"
import { count } from "../../lib/format.ts"
import { cronInWords, cronProblem, newTrigger, rotated, webhookUrl, type TriggerDraft } from "../../lib/automations.ts"
import { FIELD_INPUT } from "../ui/dialog.tsx"

const ICON = { size: 14, "stroke-width": 1.5 } as const

const PRESETS: readonly { readonly label: string; readonly cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 9:00", cron: "0 9 * * 1" },
]

const KIND_WORD: Readonly<Record<TriggerDraft["kind"], string>> = { schedule: "Schedule", once: "Once", webhook: "Webhook" }

const KINDS: readonly TriggerDraft["kind"][] = ["schedule", "once", "webhook"]

function KindIcon(props: { kind: TriggerDraft["kind"] }): JSX.Element {
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

/** Copy holds its check for 1.5s, the motion table's Copy row. */
export function CopyButton(props: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(props.text)
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied() ? "Copied" : props.label}
      title={copied() ? "Copied" : props.label}
      class="im-press im-hover flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-line-2 px-2 text-xs text-ink-2"
    >
      <span class="im-swap im-swap-icon">
        <span data-active={copied() ? undefined : ""}>
          <Copy {...ICON} />
        </span>
        <span data-active={copied() ? "" : undefined} class="text-done">
          <Check {...ICON} />
        </span>
      </span>
      {copied() ? "Copied" : "Copy"}
    </button>
  )
}

/** The webhook's full URL, shown to the owner only: the secret is the path. */
export function WebhookUrl(props: { path: string }): JSX.Element {
  const url = (): string => webhookUrl(location.origin, props.path)
  return (
    <div class="flex min-w-0 items-center gap-2">
      <code class="min-w-0 flex-1 truncate rounded-sm border border-line-1 bg-secondary px-2 py-1 font-mono text-xs text-ink-2" title={url()}>
        {url()}
      </code>
      <CopyButton text={url()} label="Copy webhook URL" />
    </div>
  )
}

function ScheduleFields(props: { trigger: Extract<TriggerDraft, { kind: "schedule" }>; busy: boolean; onChange: (next: TriggerDraft) => void }): JSX.Element {
  const problem = (): string | undefined =>
    props.trigger.cron.trim() === "" ? undefined : cronProblem(props.trigger.cron, props.trigger.tz)
  const words = (): string | undefined => {
    const cron = props.trigger.cron.trim()
    const said = cronInWords(cron)
    return cron === "" || problem() !== undefined || said === cron ? undefined : said
  }
  return (
    <div class="flex flex-col gap-1.5">
      <input
        class={`${FIELD_INPUT} h-8 font-mono text-sm`}
        value={props.trigger.cron}
        disabled={props.busy}
        placeholder="0 9 * * 1-5"
        aria-label="Cron"
        aria-invalid={problem() !== undefined}
        spellcheck={false}
        onInput={(event) => props.onChange({ ...props.trigger, cron: event.currentTarget.value })}
      />
      <div class="flex flex-wrap items-center gap-1.5">
        <For each={PRESETS}>
          {(preset) => (
            <button
              type="button"
              disabled={props.busy}
              aria-pressed={props.trigger.cron.trim() === preset.cron}
              onClick={() => props.onChange({ ...props.trigger, cron: preset.cron })}
              class="im-press im-hover h-6 rounded-sm border border-line-2 px-2 text-xs text-ink-2 aria-pressed:border-line-3 aria-pressed:bg-secondary aria-pressed:text-ink"
            >
              {preset.label}
            </button>
          )}
        </For>
        <span class="ml-auto truncate text-xs text-ink-3">
          <Show when={problem()}>{(text) => <span class="text-failed">{text()}</span>}</Show>
          <Show when={problem() === undefined && words()} fallback={problem() === undefined ? <>5-field cron · {props.trigger.tz}</> : null}>
            {(said) => (
              <>
                <span class="text-ink-2">{said()}</span> · {props.trigger.tz}
              </>
            )}
          </Show>
        </span>
      </div>
    </div>
  )
}

function WebhookFields(props: { trigger: Extract<TriggerDraft, { kind: "webhook" }>; busy: boolean; onChange: (next: TriggerDraft) => void }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <Show
        when={props.trigger.path}
        fallback={
          <span class="text-xs text-ink-3">
            {props.trigger.key.startsWith("new-") ? "The URL appears once you save." : "A new URL is minted when you save; the old one stops answering."}
          </span>
        }
      >
        {(path) => (
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              <WebhookUrl path={path()} />
            </div>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => props.onChange(rotated(props.trigger))}
              title="Replace the secret; the current URL stops working when you save"
              class="im-press im-hover flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs text-ink-3"
            >
              <RefreshCw {...ICON} />
              Rotate
            </button>
          </div>
        )}
      </Show>
      <div class="grid grid-cols-2 gap-2">
        <input
          class={`${FIELD_INPUT} h-8 text-sm`}
          value={props.trigger.contains}
          disabled={props.busy}
          placeholder="Only if the body contains… (comma-separated)"
          aria-label="Only if the body contains"
          onInput={(event) => props.onChange({ ...props.trigger, contains: event.currentTarget.value })}
        />
        <input
          class={`${FIELD_INPUT} h-8 font-mono text-sm`}
          value={props.trigger.regex}
          disabled={props.busy}
          placeholder="…or matches regex"
          aria-label="Only if the body matches"
          spellcheck={false}
          onInput={(event) => props.onChange({ ...props.trigger, regex: event.currentTarget.value })}
        />
      </div>
      <Show when={props.trigger.rules.length > 0}>
        <span class="text-xs text-ink-3">{count(props.trigger.rules.length, "batching rule")} kept as set by the agent</span>
      </Show>
    </div>
  )
}

/** The whole trigger set: the editor sends it as one list, and an untouched list is not sent at all. */
export function TriggersEditor(props: {
  triggers: readonly TriggerDraft[]
  busy: boolean
  tz: string
  onChange: (next: readonly TriggerDraft[]) => void
}): JSX.Element {
  let minted = 0
  const replace = (key: string, next: TriggerDraft): void => props.onChange(props.triggers.map((item) => (item.key === key ? next : item)))
  const remove = (key: string): void => props.onChange(props.triggers.filter((item) => item.key !== key))
  const add = (kind: TriggerDraft["kind"]): void => {
    minted += 1
    props.onChange([...props.triggers, newTrigger(kind, `new-${minted}-${Date.now()}`, props.tz)])
  }
  return (
    <div class="flex flex-col gap-2">
      <span class="text-sm font-medium text-ink-2">Triggers</span>
      <For each={props.triggers}>
        {(trigger) => (
          <div class="im-event flex flex-col gap-2 rounded-md border border-line-1 bg-panel p-2.5">
            <div class="flex h-5 items-center gap-1.5 text-sm text-ink-2">
              <span class="text-ink-3">
                <KindIcon kind={trigger.kind} />
              </span>
              {KIND_WORD[trigger.kind]}
              <button
                type="button"
                disabled={props.busy}
                onClick={() => remove(trigger.key)}
                aria-label={`Remove ${KIND_WORD[trigger.kind].toLowerCase()} trigger`}
                class="im-press im-hover ml-auto grid h-6 w-6 place-items-center rounded-sm text-ink-3"
              >
                <X {...ICON} />
              </button>
            </div>
            <Switch>
              <Match when={trigger.kind === "schedule" ? trigger : undefined}>
                {(schedule) => <ScheduleFields trigger={schedule()} busy={props.busy} onChange={(next) => replace(trigger.key, next)} />}
              </Match>
              <Match when={trigger.kind === "once" ? trigger : undefined}>
                {(once) => (
                  <input
                    type="datetime-local"
                    class={`${FIELD_INPUT} h-8 text-sm`}
                    value={once().at}
                    disabled={props.busy}
                    aria-label="Run once at"
                    onInput={(event) => replace(trigger.key, { ...once(), at: event.currentTarget.value })}
                  />
                )}
              </Match>
              <Match when={trigger.kind === "webhook" ? trigger : undefined}>
                {(hook) => <WebhookFields trigger={hook()} busy={props.busy} onChange={(next) => replace(trigger.key, next)} />}
              </Match>
            </Switch>
          </div>
        )}
      </For>
      <Show when={props.triggers.length === 0}>
        <span class="text-xs text-ink-3">No triggers: it runs only when you press Run now.</span>
      </Show>
      <div class="flex items-center gap-1.5">
        <For each={KINDS}>
          {(kind) => (
            <button
              type="button"
              disabled={props.busy}
              onClick={() => add(kind)}
              class="im-press im-hover flex h-7 items-center gap-1.5 rounded-sm border border-dashed border-line-2 px-2 text-xs text-ink-2"
            >
              <Plus {...ICON} />
              {KIND_WORD[kind]}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
