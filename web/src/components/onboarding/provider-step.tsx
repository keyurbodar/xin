import { createSignal, For, Show, type JSX } from "solid-js"
import { Icon } from "../ui/icon.tsx"
import { navigate } from "../../lib/router.ts"
import { Field, GhostButton, PrimaryButton, Spinner, StatusLine, StepHeading, TextInput } from "./controls.tsx"
import {
  connectProvider,
  forgetProvider,
  messageOf,
  nextStep,
  onboardingProvider,
  type ProviderInput,
} from "../../state/onboarding.ts"
import type { ModelInfo } from "../../state/settings.ts"

type ChoiceId = "anthropic" | "openai" | "other"
type CustomApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai"

const CHOICES: readonly { readonly id: ChoiceId; readonly name: string; readonly detail: string }[] = [
  { id: "anthropic", name: "Anthropic", detail: "Text, vision, tools" },
  { id: "openai", name: "OpenAI", detail: "Reasoning models" },
  { id: "other", name: "Other", detail: "Any OpenAI-compatible URL" },
]

const APIS: readonly { readonly id: CustomApi; readonly label: string }[] = [
  { id: "openai-completions", label: "OpenAI chat completions" },
  { id: "openai-responses", label: "OpenAI responses" },
  { id: "anthropic-messages", label: "Anthropic messages" },
  { id: "google-generative-ai", label: "Google generative AI" },
]

const VISIBLE_MODELS = 5

export function ProviderStep(): JSX.Element {
  const restored = onboardingProvider()?.provider
  const [choice, setChoice] = createSignal<ChoiceId>(
    restored === "anthropic" ? "anthropic" : restored === "openai" ? "openai" : restored === undefined ? "anthropic" : "other",
  )
  const [providerId, setProviderId] = createSignal(
    restored !== undefined && restored !== "anthropic" && restored !== "openai" ? restored : "",
  )
  const [baseUrl, setBaseUrl] = createSignal("")
  const [api, setApi] = createSignal<CustomApi>("openai-completions")
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)

  const saved = onboardingProvider
  const models = (): readonly ModelInfo[] => saved()?.models ?? []
  const visible = (): readonly ModelInfo[] => models().slice(0, VISIBLE_MODELS)
  const hidden = (): number => Math.max(0, models().length - VISIBLE_MODELS)

  const provider = (): string => {
    switch (choice()) {
      case "anthropic":
        return "anthropic"
      case "openai":
        return "openai"
      case "other":
        return providerId().trim()
    }
  }

  const touch = (): void => {
    if (saved() !== undefined) forgetProvider()
    setFailure(undefined)
  }

  const catalogStatus = (): string => {
    if (busy()) return "checking the key…"
    if (saved() !== undefined) return `${models().length} ${models().length === 1 ? "model" : "models"}`
    return "waiting for a key"
  }

  const savedLine = (): string | undefined => {
    if (saved() === undefined) return undefined
    const count = models().length
    return count === 0
      ? `Key saved for ${saved()?.provider}. The catalog lists no models for it yet.`
      : `Key works. ${count} ${count === 1 ? "model is" : "models are"} ready.`
  }

  const submit = async (): Promise<void> => {
    if (busy()) return
    if (saved() !== undefined) {
      nextStep()
      return
    }
    const id = provider()
    if (id === "") {
      setFailure("Give the provider a catalog id, for example openrouter.")
      return
    }
    if (key().trim() === "") {
      setFailure("Paste an API key.")
      return
    }
    const input: ProviderInput =
      choice() === "other" && baseUrl().trim() !== ""
        ? { kind: "custom", provider: id, key: key().trim(), baseUrl: baseUrl().trim(), api: api() }
        : { kind: "key", provider: id, key: key().trim() }
    setBusy(true)
    setFailure(undefined)
    try {
      await connectProvider(input)
      setKey("")
    } catch (error) {
      setFailure(messageOf(error, "That key could not be saved."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="im-content px-6 pb-16 pt-12 md:pt-[72px]">
      <div class="mx-auto flex w-full max-w-[560px] flex-col gap-[18px]">
        <StepHeading
          step="Step 1 of 4"
          title="Connect a model provider"
          intro="Add a key from any provider. Every model the catalog lists for it becomes available. You can add more providers later."
        />

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <For each={CHOICES}>
            {(item) => (
              <button
                type="button"
                onClick={() => {
                  setChoice(item.id)
                  touch()
                }}
                class="flex flex-col gap-1.5 rounded-sm border p-3 text-left"
                classList={{
                  "border-ink bg-hover": choice() === item.id,
                  "border-line-2 bg-panel hover:border-line-3": choice() !== item.id,
                }}
              >
                <span class="text-base font-medium">{item.name}</span>
                <span class="text-xs leading-[1.4] text-ink-3">{item.detail}</span>
              </button>
            )}
          </For>
        </div>

        <Show when={choice() === "other"}>
          <Field label="Provider id" hint="The catalog id, for example openrouter.">
            <TextInput
              value={providerId()}
              onInput={(value) => {
                setProviderId(value)
                touch()
              }}
              placeholder="openrouter"
              mono
              ariaLabel="Provider id"
              onEnter={() => void submit()}
            />
          </Field>
          <Field label="API base URL" hint="Optional. Fill this for an OpenAI-compatible endpoint the catalog does not know.">
            <TextInput
              value={baseUrl()}
              onInput={(value) => {
                setBaseUrl(value)
                touch()
              }}
              placeholder="https://api.example.com/v1"
              mono
              ariaLabel="API base URL"
            />
          </Field>
          <Show when={baseUrl().trim() !== ""}>
            <Field label="API">
              <select
                value={api()}
                onChange={(event) => {
                  setApi(apiFrom(event.currentTarget.value))
                  touch()
                }}
                aria-label="API"
                class="h-10 w-full rounded-sm border border-line-2 bg-panel px-2.5 text-base text-ink focus:border-primary focus:outline-none"
              >
                <For each={APIS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
              </select>
            </Field>
          </Show>
        </Show>

        <Field label="API key" hint="Stored encrypted on this instance. Only the coordinator and threads use it.">
          <div class="flex h-10 items-center gap-2 rounded-sm border border-line-2 bg-panel px-3 focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(255,90,0,0.18)]">
            <Icon name="key" size={14} class="shrink-0 text-ink-3" />
            <input
              type="password"
              value={key()}
              onInput={(event) => {
                setKey(event.currentTarget.value)
                touch()
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder={saved() === undefined ? "sk-…" : "saved"}
              autocomplete="off"
              spellcheck={false}
              aria-label="API key"
              class="h-full min-w-0 flex-1 bg-transparent font-mono text-sm text-ink placeholder:text-icon focus:outline-none"
              disabled={busy() || saved() !== undefined}
            />
            <Show when={busy()}>
              <Spinner tone="light" />
            </Show>
            <Show when={saved() !== undefined && !busy()}>
              <Icon name="check" size={14} class="shrink-0 text-done" />
            </Show>
          </div>
          <Show when={saved() !== undefined}>
            <button
              type="button"
              onClick={() => {
                forgetProvider()
                setFailure(undefined)
              }}
              class="self-start text-xs text-ink-3 underline decoration-line-3 underline-offset-2 hover:text-ink-2"
            >
              Use a different key
            </button>
          </Show>
        </Field>

        <StatusLine tone={failure() === undefined ? "ok" : "error"} text={failure() ?? savedLine()} />

        <div class="overflow-hidden rounded-sm border border-line-1">
          <div class="flex h-8 items-center gap-2 border-b border-line-1 bg-card px-3">
            <span class="label flex-1">From the catalog</span>
            <span class="font-mono text-2xs text-ink-3">{catalogStatus()}</span>
          </div>
          <Show
            when={models().length > 0}
            fallback={
              <div class="px-3 py-3 text-sm text-ink-3">
                {saved() === undefined ? "Models appear here once the key works." : "No models are listed for this provider yet."}
              </div>
            }
          >
            <For each={visible()}>
              {(model) => (
                <div class="flex h-9 items-center gap-2.5 border-b border-line-1 px-3 text-sm last:border-0">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-2xs bg-done" />
                  <span class="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                  <span class="shrink-0 font-mono text-2xs text-icon">{contextLabel(model.contextWindow)}</span>
                  <Show when={model.reasoning}>
                    <span class="shrink-0 font-mono text-2xs uppercase tracking-[0.06em] text-ink-3">reasoning</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={hidden() > 0}>
              <div class="flex h-8 items-center px-3 font-mono text-2xs text-icon">+{hidden()} more</div>
            </Show>
          </Show>
        </div>

        <div class="flex items-center justify-between gap-3">
          <GhostButton label="Back" onClick={() => navigate("/")} />
          <div class="flex items-center gap-2">
            <GhostButton label="Skip for now" onClick={nextStep} />
            <PrimaryButton
              label={saved() === undefined ? "Save key" : "Continue"}
              busy={busy()}
              disabled={saved() === undefined && key().trim() === ""}
              onClick={() => void submit()}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function apiFrom(value: string): CustomApi {
  switch (value) {
    case "openai-responses":
      return "openai-responses"
    case "anthropic-messages":
      return "anthropic-messages"
    case "google-generative-ai":
      return "google-generative-ai"
    default:
      return "openai-completions"
  }
}

function contextLabel(tokens: number): string {
  if (tokens <= 0) return "—"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}
