import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { isDefinitive } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { slugify } from "../../lib/slug.ts"
import {
  archiveCaptain,
  captainDetail,
  createCaptain,
  updateCaptain,
  type CaptainFields,
  type CaptainProfile,
} from "../../state/captains.ts"
import { activeProjects, routeProject } from "../../state/home.ts"
import { searchModels, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { setSidebarDrawer } from "../../state/tabs.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"

const STANDING_LIMIT = 16_000

const [creating, setCreating] = createSignal(false)

export function openNewCaptain(): void {
  setSidebarDrawer(false)
  setCreating(true)
}

const keyOf = (model: ModelRef): string => `${model.provider}/${model.modelId}`

function failureText(problem: unknown): string {
  return problem instanceof Error ? problem.message : "That did not go through"
}

type Draft = {
  readonly name: string
  readonly alias: string
  readonly description: string
  readonly model: string
  readonly rules: string
  readonly crewRules: string
}

const EMPTY: Draft = { name: "", alias: "", description: "", model: "", rules: "", crewRules: "" }

function ModelSelect(props: { value: string; disabled: boolean; allowDefault: boolean; onChange: (value: string) => void }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [found] = createResource(query, searchModels)
  const catalog = (): readonly ModelInfo[] => (found.latest?.models ?? []).filter((model) => model.keyed)
  return (
    <div class="flex flex-col gap-1.5">
      <input
        type="search"
        class={`${FIELD_INPUT} h-8 text-sm`}
        value={query()}
        disabled={props.disabled}
        placeholder="Search models"
        aria-label="Search models"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <select
        class={`${FIELD_INPUT} h-[34px]`}
        value={props.value}
        disabled={props.disabled}
        aria-label="Model"
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <Show when={props.allowDefault}>
          <option value="">The project's coordinator model</option>
        </Show>
        <Show when={props.value !== "" && !catalog().some((model) => keyOf(model) === props.value)}>
          <option value={props.value}>{props.value}</option>
        </Show>
        <For each={catalog()}>{(model) => <option value={keyOf(model)}>{model.name}</option>}</For>
      </select>
    </div>
  )
}

function DraftFields(props: { draft: Draft; busy: boolean; allowDefaultModel: boolean; onChange: (draft: Draft) => void }): JSX.Element {
  const set = (patch: Partial<Draft>): void => props.onChange({ ...props.draft, ...patch })
  return (
    <>
      <div class="grid grid-cols-[1fr_200px] gap-3">
        <Field label="Name">
          <input
            autofocus
            class={`${FIELD_INPUT} h-[34px]`}
            value={props.draft.name}
            maxlength={80}
            disabled={props.busy}
            placeholder="Bosun"
            onInput={(event) => set({ name: event.currentTarget.value })}
          />
        </Field>
        <Field label="Alias" optional>
          <input
            class={`${FIELD_INPUT} h-[34px] font-mono text-sm`}
            value={props.draft.alias}
            maxlength={40}
            disabled={props.busy}
            placeholder={slugify(props.draft.name) || "bosun"}
            onInput={(event) => set({ alias: event.currentTarget.value })}
          />
        </Field>
      </div>
      <Field label="Description" optional hint="One line, shown under its name">
        <input
          class={`${FIELD_INPUT} h-[34px]`}
          value={props.draft.description}
          maxlength={200}
          disabled={props.busy}
          placeholder="Runs the web client's crew"
          onInput={(event) => set({ description: event.currentTarget.value })}
        />
      </Field>
      <Field label="Model" hint="Its chat runs on this model from its next request">
        <ModelSelect
          value={props.draft.model}
          disabled={props.busy}
          allowDefault={props.allowDefaultModel}
          onChange={(model) => set({ model })}
        />
      </Field>
      <Field label="Rules" optional hint="The Captain's own standing rules, read on every turn">
        <textarea
          class={`${FIELD_INPUT} min-h-[88px] resize-y py-2 text-sm`}
          value={props.draft.rules}
          maxlength={STANDING_LIMIT}
          disabled={props.busy}
          placeholder="Report back once a day. Never merge without asking."
          onInput={(event) => set({ rules: event.currentTarget.value })}
        />
      </Field>
      <Field label="Crew rules" optional hint="Every crew thread reads these. The Captain may rewrite them.">
        <textarea
          class={`${FIELD_INPUT} min-h-[88px] resize-y py-2 text-sm`}
          value={props.draft.crewRules}
          maxlength={STANDING_LIMIT}
          disabled={props.busy}
          placeholder="Open a pull request for every change. Keep reports short."
          onInput={(event) => set({ crewRules: event.currentTarget.value })}
        />
      </Field>
    </>
  )
}

function modelFrom(draft: Draft): ModelRef | undefined {
  const cut = draft.model.indexOf("/")
  if (cut <= 0) return undefined
  return { provider: draft.model.slice(0, cut), modelId: draft.model.slice(cut + 1) }
}

function Footer(props: { busy: boolean; ready: boolean; label: string; busyLabel: string; onCancel: () => void; children?: JSX.Element }): JSX.Element {
  return (
    <>
      {props.children}
      <span class="mr-auto" />
      <button
        type="button"
        disabled={props.busy}
        onClick={props.onCancel}
        class="h-8 rounded-sm px-3 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={!props.ready}
        class="flex h-8 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-40"
      >
        {props.busy ? props.busyLabel : props.label}
        <span class="kbd border-on-primary/30 text-on-primary">⌘↵</span>
      </button>
    </>
  )
}

/** captain.create is idempotent per command id: a retry after a lost ack reuses the id, and a rejection mints a new one, because the host replays a rejected id. */
export function NewCaptainDialog(): JSX.Element {
  const [draft, setDraft] = createSignal<Draft>(EMPTY)
  const [projectId, setProjectId] = createSignal("")
  const [commandId, setCommandId] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const close = (): void => {
    setCreating(false)
  }

  resetOnOpen(creating, () => {
    setDraft(EMPTY)
    setProjectId(routeProject()?.id ?? activeProjects()[0]?.id ?? "")
    setCommandId(crypto.randomUUID())
    setFailure(undefined)
    setBusy(false)
  })

  const ready = (): boolean => !busy() && draft().name.trim() !== "" && projectId() !== ""

  const create = async (): Promise<void> => {
    if (!ready()) return
    setBusy(true)
    setFailure(undefined)
    const current = draft()
    const model = modelFrom(current)
    const alias = slugify(current.alias)
    const fields: CaptainFields = {
      name: current.name.trim(),
      ...(alias === "" ? {} : { alias }),
      ...(current.description.trim() === "" ? {} : { description: current.description.trim() }),
      ...(model === undefined ? {} : { model }),
      ...(current.rules.trim() === "" ? {} : { rules: current.rules }),
      ...(current.crewRules.trim() === "" ? {} : { crewRules: current.crewRules }),
    }
    try {
      const created = await createCaptain(projectId(), fields, commandId())
      close()
      navigate(`/c/${created.alias}`)
    } catch (problem) {
      if (isDefinitive(problem)) setCommandId(crypto.randomUUID())
      setFailure(failureText(problem))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={creating()}
      onClose={close}
      title="New Captain"
      busy={busy()}
      width="w-[600px]"
      onSubmit={() => void create()}
      footer={<Footer busy={busy()} ready={ready()} label="Create Captain" busyLabel="Creating…" onCancel={close} />}
    >
      <p class="text-sm text-ink-3">
        A Captain is a named coordinator that keeps its own chat, notes and crew of threads in one project.
      </p>
      <Field label="Project" hint="Its crew threads run in this project">
        <select
          class={`${FIELD_INPUT} h-[34px]`}
          value={projectId()}
          disabled={busy()}
          onChange={(event) => setProjectId(event.currentTarget.value)}
        >
          <For each={activeProjects()}>{(project) => <option value={project.id}>{project.name}</option>}</For>
        </select>
      </Field>
      <DraftFields draft={draft()} busy={busy()} allowDefaultModel onChange={setDraft} />
      <Show when={failure()}>{(text) => <div class="text-sm text-failed">{text()}</div>}</Show>
    </Dialog>
  )
}

/** Edit and archive one Captain. Notes are the Captain's own, rewritten by its captain_notes tool, so they are read here only. */
export function CaptainSettings(props: { captain: CaptainProfile; open: boolean; onClose: () => void }): JSX.Element {
  const [detail, { refetch }] = createResource(
    () => (props.open ? props.captain.id : undefined),
    (id) => captainDetail(id),
  )
  const [draft, setDraft] = createSignal<Draft>(EMPTY)
  const [touched, setTouched] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)

  resetOnOpen(
    () => props.open,
    () => {
        setTouched(false)
      setFailure(undefined)
      setConfirming(false)
      setBusy(false)
    },
  )

  const base = (): Draft | undefined => {
    const loaded = detail()
    if (loaded === undefined) return undefined
    return {
      name: loaded.name,
      alias: loaded.alias,
      description: loaded.description,
      model: loaded.model === null ? "" : keyOf(loaded.model),
      rules: loaded.rules,
      crewRules: loaded.crewRules,
    }
  }
  const current = (): Draft => (touched() ? draft() : (base() ?? EMPTY))
  const edit = (next: Draft): void => {
    setDraft(next)
    setTouched(true)
  }

  const changes = (): Partial<CaptainFields> => {
    const from = base()
    if (from === undefined) return {}
    const next = current()
    const model = modelFrom(next)
    const alias = slugify(next.alias)
    return {
      ...(next.name.trim() === from.name ? {} : { name: next.name.trim() }),
      ...(alias === "" || alias === from.alias ? {} : { alias }),
      ...(next.description.trim() === from.description ? {} : { description: next.description.trim() }),
      ...(model === undefined || next.model === from.model ? {} : { model }),
      ...(next.rules === from.rules ? {} : { rules: next.rules }),
      ...(next.crewRules === from.crewRules ? {} : { crewRules: next.crewRules }),
    }
  }
  const ready = (): boolean => !busy() && current().name.trim() !== "" && Object.keys(changes()).length > 0

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await work()
    } catch (problem) {
      setFailure(failureText(problem))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!ready()) return
    const patch = changes()
    await run(async () => {
      await updateCaptain(props.captain.id, patch)
      props.onClose()
      if (patch.alias !== undefined) navigate(`/c/${patch.alias}`)
    })
  }

  const archive = (): Promise<void> =>
    run(async () => {
      await archiveCaptain(props.captain.id)
      props.onClose()
      navigate("/")
    })

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={`${props.captain.name} settings`}
      busy={busy()}
      width="w-[600px]"
      onSubmit={() => void save()}
      footer={
        <Show
          when={confirming()}
          fallback={
            <Footer busy={busy()} ready={ready()} label="Save" busyLabel="Saving…" onCancel={props.onClose}>
              <button
                type="button"
                disabled={busy()}
                onClick={() => setConfirming(true)}
                class="h-8 rounded-sm px-2 text-sm text-ink-3 hover:text-failed disabled:opacity-50"
              >
                Archive Captain
              </button>
            </Footer>
          }
        >
          <span class="text-sm text-ink-3">Archive {props.captain.name}? Running crew threads still finish and report.</span>
          <span class="mr-auto" />
          <button
            type="button"
            disabled={busy()}
            onClick={() => setConfirming(false)}
            class="h-8 rounded-sm px-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Keep
          </button>
          <button
            type="button"
            disabled={busy()}
            onClick={() => void archive()}
            class="h-8 rounded-sm border border-failed/40 bg-failed-soft px-3 text-sm font-medium text-failed hover:border-failed disabled:opacity-50"
          >
            Archive
          </button>
        </Show>
      }
    >
      <Show when={detail.error}>
        <div class="flex items-center gap-2 text-sm text-failed">
          {failureText(detail.error)}
          <button type="button" class="link" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      </Show>
      <Show when={base()} fallback={<span class="text-sm text-ink-3">{detail.loading ? "Loading…" : ""}</span>}>
        <DraftFields draft={current()} busy={busy()} allowDefaultModel={base()?.model === ""} onChange={edit} />
        <Field label="Notes" hint="The Captain keeps these itself with its captain_notes tool">
          <div class="max-h-[180px] min-h-[52px] overflow-y-auto whitespace-pre-wrap rounded-sm border border-line-1 bg-secondary px-2.5 py-2 text-sm text-ink-2">
            {detail()?.notes === "" ? <span class="text-icon">No notes yet</span> : detail()?.notes}
          </div>
        </Field>
      </Show>
      <Show when={failure()}>{(text) => <div class="text-sm text-failed">{text()}</div>}</Show>
    </Dialog>
  )
}
