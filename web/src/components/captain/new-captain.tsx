import "@ui-sdk/web/collapsible"
import "@ui-sdk/web/combobox"
import "@ui-sdk/web/select"
import { Check, ChevronDown, ChevronRight } from "lucide-solid"
import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { isDefinitive } from "../../lib/api.ts"
import { navigate } from "../../lib/router.ts"
import { slugify } from "../../lib/slug.ts"
import { canCreateCaptain, captainModel, modelKey, type CaptainFields } from "../../lib/captains.ts"
import { createCaptain } from "../../state/captains.ts"
import { ensureContext } from "../../state/context.ts"
import { activeProjects, routeProject } from "../../state/home.ts"
import { modelName, searchModels, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { Dialog, FIELD_INPUT, Field, resetOnOpen } from "../ui/dialog.tsx"
import { POPUP, POPUP_ITEM } from "../ui/surface.ts"
import { CaptainAvatar } from "./avatar.tsx"
import { closeNewCaptain, newCaptainOpen } from "./captain-dialog.tsx"

const STANDING_LIMIT = 16_000

const ROW = "flex min-h-12 items-center justify-between gap-4 border-b border-line-1 py-2"
const ROW_LABEL = "shrink-0 text-base text-ink"
const GHOST =
  "im-hover flex h-[var(--h-control)] max-w-[300px] items-center gap-1.5 rounded-sm px-2 text-base text-ink-2 outline-none hover:bg-secondary hover:text-ink focus-visible:ring-[3px] focus-visible:ring-primary-soft disabled:opacity-50"

type Draft = {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly alias: string
  readonly rules: string
  readonly crewRules: string
}

const EMPTY: Draft = { name: "", description: "", model: "", alias: "", rules: "", crewRules: "" }

function ModelRow(props: { current: ModelRef | undefined; busy: boolean; onPick: (key: string) => void }): JSX.Element {
  const [query, setQuery] = createSignal("")
  const [found] = createResource(query, searchModels)
  const options = (): readonly { key: string; name: string }[] => {
    const keyed = (found.latest?.models ?? []).filter((model: ModelInfo) => model.keyed).map((model) => ({ key: modelKey(model), name: model.name }))
    const current = props.current
    if (current === undefined || keyed.some((option) => option.key === modelKey(current))) return keyed
    return [{ key: modelKey(current), name: modelName(current.provider, current.modelId) ?? current.modelId }, ...keyed]
  }
  return (
    <ui-combobox
      class={ROW}
      filter="false"
      prop:value={props.current === undefined ? null : modelKey(props.current)}
      disabled={props.busy ? "" : undefined}
      on:valuechange={(event) => {
        const value = event.detail.value
        if (typeof value === "string") props.onPick(value)
      }}
      on:querychange={(event) => {
        if (event.detail.reason === "input-change") setQuery(event.detail.value)
      }}
    >
      <ui-combobox-label class={ROW_LABEL}>Model</ui-combobox-label>
      <div class="flex min-w-0 items-center">
        <ui-combobox-input class="contents">
          <input
            placeholder="Pick a model"
            class="h-[var(--h-control)] w-[220px] min-w-0 rounded-sm bg-transparent px-2 text-right text-base text-ink-2 outline-none placeholder:text-icon hover:bg-secondary focus:bg-secondary focus:text-left focus:text-ink"
          />
        </ui-combobox-input>
        <ui-combobox-trigger>
          <button type="button" aria-label="Show models" class="grid h-[var(--h-control)] w-6 place-items-center text-icon hover:text-ink">
            <ChevronDown size={14} stroke-width={1.5} />
          </button>
        </ui-combobox-trigger>
      </div>
      <ui-combobox-content side-offset="4" align="end" class={`${POPUP} w-[320px]`}>
        <ui-combobox-empty class="block px-2 py-1.5 text-sm text-ink-3">
          {query().trim() === "" ? "No models yet. Add a provider key in Settings." : "No model matches that."}
        </ui-combobox-empty>
        <ui-combobox-list>
          <For each={options()}>
            {(option) => (
              <ui-combobox-item value={option.key} label={option.name} class={POPUP_ITEM}>
                <span class="min-w-0 flex-1 truncate">{option.name}</span>
                <ui-combobox-item-indicator class="text-ink-2">
                  <Check size={14} stroke-width={1.5} />
                </ui-combobox-item-indicator>
              </ui-combobox-item>
            )}
          </For>
        </ui-combobox-list>
      </ui-combobox-content>
    </ui-combobox>
  )
}

function ProjectRow(props: { value: string; busy: boolean; onChange: (id: string) => void }): JSX.Element {
  return (
    <ui-select
      class={ROW}
      prop:value={props.value === "" ? null : props.value}
      placeholder="No projects yet"
      disabled={props.busy || activeProjects().length === 0 ? "" : undefined}
      on:valuechange={(event) => {
        const value = event.detail.value
        if (typeof value === "string") props.onChange(value)
      }}
    >
      <ui-select-label class={ROW_LABEL}>Project</ui-select-label>
      <ui-select-trigger>
        <button type="button" class={GHOST}>
          <ui-select-value class="min-w-0 truncate data-[placeholder]:text-icon" />
          <ChevronDown size={14} stroke-width={1.5} class="shrink-0 text-icon" />
        </button>
      </ui-select-trigger>
      <ui-select-content side-offset="4" align="end" class={`${POPUP} min-w-[200px]`}>
        <For each={activeProjects()}>
          {(project) => (
            <ui-select-item value={project.id} label={project.name} class={POPUP_ITEM}>
              <ui-select-item-text class="min-w-0 flex-1 truncate">{project.name}</ui-select-item-text>
              <ui-select-item-indicator class="text-ink-2">
                <Check size={14} stroke-width={1.5} />
              </ui-select-item-indicator>
            </ui-select-item>
          )}
        </For>
      </ui-select-content>
    </ui-select>
  )
}

/** captain.create is idempotent per command id: a retry after a lost ack reuses the id, and a rejection mints a new one, because the host replays a rejected id. */
export function NewCaptainDialog(): JSX.Element {
  const [draft, setDraft] = createSignal<Draft>(EMPTY)
  const [projectId, setProjectId] = createSignal("")
  const [commandId, setCommandId] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [more, setMore] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const set = (patch: Partial<Draft>): void => {
    setDraft({ ...draft(), ...patch })
  }

  resetOnOpen(newCaptainOpen, () => {
    setDraft(EMPTY)
    setProjectId(routeProject()?.id ?? activeProjects()[0]?.id ?? "")
    setCommandId(crypto.randomUUID())
    setFailure(undefined)
    setBusy(false)
    setMore(false)
  })

  const coordinatorId = (): number | undefined => activeProjects().find((project) => project.id === projectId())?.coordinatorId
  const [coordinator] = createResource(
    () => (newCaptainOpen() ? coordinatorId() : undefined),
    async (conv) => (await ensureContext(conv)).model,
  )
  const model = (): ModelRef | undefined => captainModel(draft().model, coordinator.state === "errored" ? undefined : coordinator.latest)
  const ready = (): boolean => !busy() && canCreateCaptain({ name: draft().name, projectId: projectId(), model: model() })

  const create = async (): Promise<void> => {
    const chosen = model()
    if (!ready() || chosen === undefined) return
    const current = draft()
    setBusy(true)
    setFailure(undefined)
    const alias = slugify(current.alias)
    const fields: CaptainFields & Required<Pick<CaptainFields, "model">> = {
      name: current.name.trim(),
      model: chosen,
      ...(alias === "" ? {} : { alias }),
      ...(current.description.trim() === "" ? {} : { description: current.description.trim() }),
      ...(current.rules.trim() === "" ? {} : { rules: current.rules }),
      ...(current.crewRules.trim() === "" ? {} : { crewRules: current.crewRules }),
    }
    try {
      const created = await createCaptain(projectId(), fields, commandId())
      closeNewCaptain()
      navigate(`/c/${created.alias}`)
    } catch (problem) {
      if (isDefinitive(problem)) setCommandId(crypto.randomUUID())
      setFailure(problem instanceof Error ? problem.message : "That did not go through")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={newCaptainOpen()}
      onClose={closeNewCaptain}
      title="New Captain"
      busy={busy()}
      width="w-[var(--w-dialog)]"
      onSubmit={() => void create()}
      footer={
        <>
          <Show when={failure()}>{(text) => <span class="min-w-0 truncate text-sm text-failed">{text()}</span>}</Show>
          <span class="mr-auto" />
          <button
            type="submit"
            disabled={!ready()}
            class="im-press flex h-8 items-center gap-1.5 rounded-sm bg-primary px-3 text-sm font-medium text-on-primary disabled:opacity-40"
          >
            {busy() ? "Creating…" : "Create Captain"}
            <span class="kbd border-on-primary/30 text-on-primary">⌘↵</span>
          </button>
        </>
      }
    >
      <div class="flex flex-col items-center gap-2 pb-2 pt-1">
        <CaptainAvatar name={draft().name.trim() === "" ? "Captain" : draft().name} size={72} />
        <input
          autofocus
          aria-label="Name"
          value={draft().name}
          maxlength={80}
          disabled={busy()}
          placeholder="Captain"
          onInput={(event) => set({ name: event.currentTarget.value })}
          class="mt-2 w-full bg-transparent text-center text-title font-title text-ink outline-none placeholder:text-icon"
        />
        <input
          aria-label="Goal"
          value={draft().description}
          maxlength={200}
          disabled={busy()}
          placeholder="What is it for? One line, shown under its name"
          onInput={(event) => set({ description: event.currentTarget.value })}
          class="w-full bg-transparent text-center text-base text-ink-2 outline-none placeholder:text-icon"
        />
      </div>
      <div class="flex flex-col border-t border-line-1">
        <ProjectRow value={projectId()} busy={busy()} onChange={setProjectId} />
        <ModelRow current={model()} busy={busy()} onPick={(key) => set({ model: key })} />
        <Show when={model() === undefined && !coordinator.loading}>
          <p class="pt-2 text-sm text-ink-3">This project's coordinator has no model yet, so pick one before creating.</p>
        </Show>
        <ui-collapsible class="block" on:openchange={(event) => setMore(event.detail.value)}>
          <ui-collapsible-trigger>
            <button type="button" class={`${ROW} w-full border-b-0 text-left`}>
              <span class={ROW_LABEL}>Alias and rules</span>
              <span class="flex items-center gap-1.5 text-sm text-ink-3">
                optional
                <span class="im-chevron" data-open={more() ? "" : undefined} aria-hidden="true">
                  <ChevronRight size={14} stroke-width={1.5} />
                </span>
              </span>
            </button>
          </ui-collapsible-trigger>
          <ui-collapsible-panel class="im-grow">
            <div class="flex flex-col gap-4 pb-1 pt-2">
              <Field label="Alias" hint="Its address, #/c/<alias>">
                <input
                  class={`${FIELD_INPUT} h-[34px] font-mono text-sm`}
                  value={draft().alias}
                  maxlength={40}
                  disabled={busy()}
                  placeholder={slugify(draft().name) || "bosun"}
                  onInput={(event) => set({ alias: event.currentTarget.value })}
                />
              </Field>
              <Field label="Rules" hint="The Captain's own standing rules, read on every turn">
                <textarea
                  class={`${FIELD_INPUT} min-h-[88px] resize-y py-2 text-sm`}
                  value={draft().rules}
                  maxlength={STANDING_LIMIT}
                  disabled={busy()}
                  placeholder="Report back once a day. Never merge without asking."
                  onInput={(event) => set({ rules: event.currentTarget.value })}
                />
              </Field>
              <Field label="Crew rules" hint="Every crew thread reads these. The Captain may rewrite them.">
                <textarea
                  class={`${FIELD_INPUT} min-h-[88px] resize-y py-2 text-sm`}
                  value={draft().crewRules}
                  maxlength={STANDING_LIMIT}
                  disabled={busy()}
                  placeholder="Open a pull request for every change. Keep reports short."
                  onInput={(event) => set({ crewRules: event.currentTarget.value })}
                />
              </Field>
            </div>
          </ui-collapsible-panel>
        </ui-collapsible>
      </div>
    </Dialog>
  )
}
