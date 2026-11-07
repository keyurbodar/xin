import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  errorMessage,
  models,
  providers,
  roles,
  ROLE_LABEL,
  setDefault,
  type ModelInfo,
  type ModelRole,
  type ModelsList,
} from "../../state/settings.ts"
import { Failure, MissingOp, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Group, Row, Saved, SelectField, type Choice } from "./parts.tsx"

function catalog(): ModelsList {
  const state = models.state()
  return state.kind === "ready" ? state.value : { models: [], omitted: 0 }
}

function choicesOf(list: readonly ModelInfo[]): readonly Choice[] {
  return list.map((model) => ({
    value: `${model.provider}/${model.modelId}`,
    label: model.name,
    group: model.provider,
  }))
}

export function General(): JSX.Element {
  const [savedRole, setSavedRole] = createSignal<ModelRole | undefined>(undefined)
  const [chosen, setChosen] = createSignal<Partial<Record<ModelRole, string>>>({})
  const [error, setError] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void models.reload()
  })

  const list = (): readonly ModelInfo[] => {
    const state = models.state()
    return state.kind === "ready" ? state.value.models : []
  }

  const choose = async (role: ModelRole, value: string): Promise<void> => {
    setError(undefined)
    if (value === "") return
    const slash = value.indexOf("/")
    if (slash <= 0) return
    const provider = value.slice(0, slash)
    const modelId = value.slice(slash + 1)
    try {
      await setDefault(role, { provider, modelId })
      setChosen((current) => {
        const next = { ...current }
        next[role] = value
        return next
      })
      setSavedRole(role)
      window.setTimeout(() => setSavedRole((current) => (current === role ? undefined : current)), 2400)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    }
  }

  return (
    <div class="flex max-w-[820px] flex-col gap-6">
      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>

      <Group title="Model defaults" detail="Projects and threads can override these">
        <Show when={models.state().kind === "loading"}>
          <Pending label="Reading the catalog" />
        </Show>
        <Show when={failureOf(models.state())}>
          {(message) => <Failure message={message()} onRetry={() => void models.reload()} />}
        </Show>
        <Show when={models.state().kind === "ready"}>
          <For each={roles}>
            {(role) => (
              <Row
                title={ROLE_LABEL[role]}
                detail={
                  role === "chat"
                    ? "Runs the project coordinator."
                    : role === "thread"
                      ? "Runs delegated threads."
                      : "Names threads and writes summaries."
                }
              >
                <div class="flex items-center gap-2">
                  <SelectField
                    ariaLabel={ROLE_LABEL[role]}
                    value={chosen()[role] ?? ""}
                    placeholder="Catalog default"
                    choices={choicesOf(list())}
                    onChange={(value) => void choose(role, value)}
                  />
                  <Saved show={savedRole() === role} />
                </div>
              </Row>
            )}
          </For>
          <div class="flex flex-col gap-3 pt-2">
            <div class="flex flex-wrap gap-1.5">
              <For each={providers(catalog())}>
                {(provider) => (
                  <span class="rounded-[2px] border border-line-inner px-1.5 py-0.5 font-mono text-[10.5px] text-fg-3">
                    {provider.id} · {provider.models.length}
                  </span>
                )}
              </For>
            </div>
            <Note>
              A model that is not in the catalog cannot be set. The picker lists what your providers answered with; nothing here
              is hard-coded. Setting a default writes it straight away, and the picker opens on Catalog default because no op
              reads the current defaults back.
            </Note>
          </div>
        </Show>
      </Group>

      <Group title="Workspace">
        <Row title="Workspace name" detail="In the tab title and notifications">
          <span class="text-[12.5px] text-fg-2">Not stored yet</span>
        </Row>
        <Row title="Your name" detail="How the coordinator greets you">
          <span class="text-[12.5px] text-fg-2">Owner</span>
        </Row>
        <Row title="Time zone" detail="Used by schedules and timestamps">
          <span class="font-mono text-[12px] text-fg-2">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
        </Row>
        <Row title="Density" detail="Rows and spacing across the app">
          <span class="text-[12.5px] text-fg-2">Default</span>
        </Row>
        <div class="pt-2">
          <MissingOp
            op="owner.profile"
            detail="The client reads the browser's time zone and locale; name, avatar and density have no server field."
          />
        </div>
      </Group>

      <Group title="Instructions for every project" detail="Read before project instructions">
        <div class="rounded-[4px] border border-dashed border-line-inner px-3.5 py-4">
          <p class="text-[12.5px] text-fg-2">No workspace instructions are stored.</p>
          <p class="mt-1 text-[11.5px] text-fg-3">
            Project instructions live with each project. The dreamer keeps a profile of durable facts, shown under Profile;
            a workspace-level instruction block is a separate, owner-written field the server does not have.
          </p>
          <div class="mt-2">
            <MissingOp op="owner.instructions" />
          </div>
        </div>
      </Group>
    </div>
  )
}
