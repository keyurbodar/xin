import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { ChevronDown, GitBranch } from "lucide-solid"
import { BrandMark } from "../ui/brand-mark.tsx"
import { Field, PrimaryButton, QuietButton, StatusLine, StepCard, TextInput } from "./controls.tsx"
import {
  canSkip,
  createFirstCaptain,
  messageOf,
  nextStep,
  onboardingCaptain,
  previousStep,
  skipStep,
} from "../../state/onboarding.ts"
import { captainModel, OWN_SUGGESTIONS, TEMPLATES, type ModelRef, type Template } from "../../lib/onboarding.ts"
import { models, type ModelInfo } from "../../state/settings.ts"

const refKey = (model: ModelRef): string => `${model.provider}/${model.modelId}`

export function CaptainStep(): JSX.Element {
  const created = onboardingCaptain
  const [template, setTemplate] = createSignal<Template | undefined>(created() === undefined ? TEMPLATES[0] : undefined)
  const [name, setName] = createSignal(created()?.name ?? TEMPLATES[0]?.name ?? "")
  const [goal, setGoal] = createSignal(created()?.description ?? TEMPLATES[0]?.goal ?? "")
  const [repository, setRepository] = createSignal("")
  const createdModel = created()?.model
  const [model, setModel] = createSignal(createdModel === undefined ? "" : refKey(createdModel))
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)
  const [commandId, setCommandId] = createSignal(crypto.randomUUID())

  onMount(() => {
    if (models.state().kind !== "ready") void models.reload()
  })

  const keyed = (): readonly ModelInfo[] => {
    const state = models.state()
    return state.kind === "ready" ? state.value.models.filter((entry) => entry.keyed) : []
  }
  const chosen = (): ModelInfo | undefined => captainModel(keyed(), model())
  const chosenKey = (): string => {
    const picked = chosen()
    return picked === undefined ? "" : refKey(picked)
  }
  const modelLabel = (): string => chosen()?.name ?? createdModel?.modelId ?? "No model yet"

  const touch = (): void => {
    setFailure(undefined)
    setCommandId(crypto.randomUUID())
  }

  const apply = (next: Template): void => {
    setTemplate(next)
    setName(next.name)
    setGoal(next.goal)
    touch()
  }

  const submit = async (): Promise<void> => {
    if (busy()) return
    if (created() !== undefined) {
      nextStep()
      return
    }
    if (name().trim() === "") {
      setFailure("Give the Captain a name.")
      return
    }
    const picked = chosen()
    setBusy(true)
    setFailure(undefined)
    try {
      await createFirstCaptain(
        {
          name: name(),
          goal: goal(),
          repository: repository(),
          model: picked === undefined ? undefined : { provider: picked.provider, modelId: picked.modelId },
          suggestions: template()?.suggestions ?? OWN_SUGGESTIONS,
        },
        commandId(),
      )
      nextStep()
    } catch (error) {
      setFailure(messageOf(error, "The Captain could not be created."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepCard
      width="max-w-[520px]"
      step="Step 3 of 4"
      title="Create your first Captain"
      intro="A Captain runs one body of work: its own crew of threads, notes and schedules. Start from an example or write your own."
    >
      <Show when={created() === undefined}>
        <div class="-mt-1 flex flex-wrap gap-2" role="group" aria-label="Examples">
          <For each={TEMPLATES}>
            {(item) => (
              <button
                type="button"
                aria-pressed={template() === item}
                onClick={() => apply(item)}
                class="im-press h-7 rounded-md px-2.5 text-base transition-colors duration-150"
                classList={{
                  "bg-primary-soft text-accent-ink": template() === item,
                  "bg-secondary text-ink-2 hover:text-ink": template() !== item,
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_150px]">
        <Field label="Name">
          <TextInput
            value={name()}
            onInput={(value) => {
              setName(value)
              touch()
            }}
            placeholder="Bosun"
            maxLength={80}
            ariaLabel="Captain name"
            disabled={created() !== undefined}
            autofocus
          />
        </Field>
        <Field label="Model">
          <label class="relative flex h-9 items-center rounded-md border border-line-2 bg-panel focus-within:border-accent">
            <select
              value={chosenKey()}
              onChange={(event) => {
                setModel(event.currentTarget.value)
                touch()
              }}
              aria-label="Model"
              disabled={created() !== undefined}
              class="h-full w-full min-w-0 appearance-none truncate bg-transparent pl-3 pr-7 text-base text-ink focus:outline-none disabled:opacity-60"
            >
              <Show when={keyed().length === 0}>
                <option value="">No model yet</option>
              </Show>
              <For each={keyed()}>{(entry) => <option value={refKey(entry)}>{entry.name}</option>}</For>
            </select>
            <ChevronDown size={14} stroke-width={1.75} class="pointer-events-none absolute right-2.5 text-icon" aria-hidden="true" />
          </label>
        </Field>
      </div>

      <Field label="Goal" hint="The Captain reads this before every reply. You can change it any time.">
        <textarea
          value={goal()}
          onInput={(event) => {
            setGoal(event.currentTarget.value)
            setTemplate(undefined)
            touch()
          }}
          rows={3}
          maxLength={200}
          spellcheck={false}
          aria-label="Goal"
          disabled={created() !== undefined}
          placeholder="What should this Captain keep moving?"
          class="min-h-[76px] w-full resize-none rounded-md border border-line-2 bg-panel px-3 py-2 text-base text-ink placeholder:text-placeholder transition-[border-color,box-shadow] duration-150 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-primary-soft disabled:opacity-60"
        />
      </Field>

      <Show when={created() === undefined}>
        <Field label="Repository" aside="optional">
          <TextInput
            value={repository()}
            onInput={(value) => {
              setRepository(value)
              touch()
            }}
            placeholder="owner/repo"
            mono
            ariaLabel="Repository"
            leading={<GitBranch size={14} stroke-width={1.75} class="shrink-0 text-icon" aria-hidden="true" />}
          />
        </Field>
      </Show>

      <div class="flex items-center gap-3 rounded-md border border-line-1 bg-panel px-3 py-2.5">
        <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-ink">
          <BrandMark class="h-4 w-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-base text-ink">{name().trim() === "" ? "Untitled Captain" : name().trim()}</span>
          <span class="block truncate text-sm text-ink-3">
            {created() === undefined ? "New" : "Created"} · no threads yet · {modelLabel()}
          </span>
        </span>
        <span class="hidden shrink-0 text-sm text-ink-3 sm:block">Preview in the sidebar</span>
      </div>

      <StatusLine
        tone="muted"
        text={
          created() === undefined && keyed().length === 0
            ? "No model has a key yet, so the Captain can’t answer until you add one in Settings → Models + providers."
            : undefined
        }
      />
      <StatusLine tone="error" text={failure()} />

      <div class="flex items-center gap-2 pt-1">
        <QuietButton label="Back" back onClick={previousStep} />
        <span class="mr-auto" />
        <Show when={canSkip(2)}>
          <QuietButton label="Skip for now" onClick={() => void skipStep(2)} />
        </Show>
        <PrimaryButton
          label={created() === undefined ? "Create Captain" : "Continue"}
          busy={busy()}
          disabled={created() === undefined && name().trim() === ""}
          onClick={() => void submit()}
        />
      </div>
    </StepCard>
  )
}
