import "@ui-sdk/web/textarea"
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import {
  errorMessage,
  models,
  owner,
  providers,
  roles,
  ROLE_LABEL,
  setDefault,
  setOwner,
  type ModelInfo,
  type ModelRole,
  type ModelsList,
  type OwnerSettings,
} from "../../state/settings.ts"
import { Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Card, CardBlock, Group, Row, Saved, SelectField, TextField, type Choice } from "./parts.tsx"
import { motionChoice, motionOf, setMotionChoice } from "../../lib/theme.ts"

const BLANK: OwnerSettings = { name: "", instructions: "" }

const LIMIT: Readonly<Record<keyof OwnerSettings, number>> = { name: 120, instructions: 4000 }

type Field = keyof OwnerSettings

const SAVE_DELAY = 700
const TICK_FOR = 2400

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

  const [draft, setDraft] = createSignal<OwnerSettings | undefined>(undefined)
  const [savedField, setSavedField] = createSignal<Field | undefined>(undefined)
  const [saveError, setSaveError] = createSignal<string | undefined>(undefined)
  const edits: Record<Field, number> = { name: 0, instructions: 0 }
  let timer: number | undefined

  onMount(() => {
    void models.reload()
    void owner.reload()
  })

  onCleanup(() => {
    if (timer === undefined) return
    void flush()
  })

  const list = (): readonly ModelInfo[] => {
    const state = models.state()
    return state.kind === "ready" ? state.value.models : []
  }

  const stored = (): OwnerSettings => {
    const state = owner.state()
    return state.kind === "ready" ? state.value : BLANK
  }

  const valueOf = (field: Field): string => draft()?.[field] ?? stored()[field]

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    const current = draft()
    if (current === undefined) return
    const base = stored()
    const patch: { name?: string; instructions?: string } = {}
    const touched: Field[] = []
    for (const field of ["name", "instructions"] as const) {
      if (current[field] === base[field]) continue
      patch[field] = current[field]
      touched.push(field)
    }
    const last = touched[touched.length - 1]
    if (last === undefined) return
    const at = { ...edits }
    setSaveError(undefined)
    try {
      const next = await setOwner(patch)
      setDraft((now) => {
        if (now === undefined) return undefined
        const merged = { ...now }
        for (const field of touched) if (edits[field] === at[field]) merged[field] = next[field]
        return merged
      })
      setSavedField(last)
      window.setTimeout(() => setSavedField((now) => (now === last ? undefined : now)), TICK_FOR)
    } catch (failure: unknown) {
      setSaveError(errorMessage(failure))
    }
  }

  const edit = (field: Field, next: string): void => {
    const clipped = next.slice(0, LIMIT[field])
    edits[field] += 1
    setDraft((now) => {
      const base = now ?? stored()
      return field === "name" ? { ...base, name: clipped } : { ...base, instructions: clipped }
    })
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => void flush(), SAVE_DELAY)
  }

  const readable = (): boolean => owner.state().kind === "ready"

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
    <>
      <Show when={error()}>{(message) => <Failure message={message()} />}</Show>
      <Show when={saveError()}>{(message) => <Failure message={message()} onRetry={() => void flush()} />}</Show>
      <Show when={owner.state().kind === "loading"}>
        <Pending label="Reading your settings" />
      </Show>
      <Show when={failureOf(owner.state())}>
        {(message) => <Failure message={message()} onRetry={() => void owner.reload()} />}
      </Show>

      <Group title="Model defaults" detail="Projects and threads can override these">
        <Show when={models.state().kind === "loading"}>
          <Pending label="Reading the catalog" />
        </Show>
        <Show when={failureOf(models.state())}>
          {(message) => <Failure message={message()} onRetry={() => void models.reload()} />}
        </Show>
        <Show when={models.state().kind === "ready"}>
          <Card>
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
                  <Saved show={savedRole() === role} />
                  <SelectField
                    ariaLabel={ROLE_LABEL[role]}
                    value={chosen()[role] ?? ""}
                    placeholder="Catalog default"
                    choices={choicesOf(list())}
                    onChange={(value) => void choose(role, value)}
                  />
                </Row>
              )}
            </For>
            <CardBlock class="flex flex-wrap gap-1.5 px-4 py-3">
              <For each={providers(catalog())}>
                {(provider) => (
                  <span class="rounded-xs px-1.5 py-0.5 font-mono text-micro text-ink-3 shadow-ring">
                    {provider.id} · {provider.models.length}
                  </span>
                )}
              </For>
            </CardBlock>
          </Card>
          <Note>
            A model that is not in the catalog cannot be set. The picker lists what your providers answered with; nothing
            here is hard-coded. Setting a default writes it straight away, and the picker opens on Catalog default because
            no op reads the current defaults back.
          </Note>
        </Show>
      </Group>

      <Group title="Workspace">
        <Card>
          <Row title="Your name" detail="How the coordinator greets you">
            <Saved show={savedField() === "name"} />
            <TextField
              type="text"
              aria-label="Your name"
              class="w-[240px] max-w-full"
              value={valueOf("name")}
              maxLength={LIMIT.name}
              disabled={!readable()}
              onInput={(event) => edit("name", event.currentTarget.value)}
              onBlur={() => void flush()}
            />
          </Row>
          <Row title="Time zone" detail="Used by schedules and timestamps">
            <span class="font-mono text-small text-ink-2">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          </Row>
          <Row title="Reduce motion" detail="On this device. System follows the operating system’s setting">
            <SelectField
              ariaLabel="Reduce motion"
              value={motionChoice() === "system" ? "" : motionChoice()}
              placeholder="System"
              onChange={(next) => setMotionChoice(motionOf(next))}
              choices={[{ value: "reduce", label: "On" }]}
            />
          </Row>
        </Card>
      </Group>

      <Group
        title="Instructions for every project"
        detail="Read by the coordinator and every thread, before project instructions"
      >
        <Card>
          <CardBlock class="flex flex-col">
            <ui-textarea class="flex">
              <textarea
                rows={7}
                aria-label="Instructions for every project"
                class="w-full resize-y bg-transparent px-4 py-3 text-body text-ink outline-none disabled:opacity-40"
                value={valueOf("instructions")}
                maxLength={LIMIT.instructions}
                disabled={!readable()}
                onInput={(event) => edit("instructions", event.currentTarget.value)}
                onBlur={() => void flush()}
              />
            </ui-textarea>
          </CardBlock>
          <CardBlock class="flex items-baseline gap-2 px-4 py-2">
            <Show when={owner.state().kind !== "loading" && valueOf("instructions").trim() === ""}>
              <span class="text-mini text-ink-3">No workspace instructions are stored.</span>
            </Show>
            <Saved show={savedField() === "instructions"} />
            <span class="ml-auto font-mono text-micro text-icon">
              {valueOf("instructions").length.toLocaleString("en-US")} / 4,000 · Markdown works
            </span>
          </CardBlock>
        </Card>
        <Note>
          Every conversation's system prompt carries this block first, before the instructions of the project it belongs
          to. Changes save as you type.
        </Note>
      </Group>
    </>
  )
}
