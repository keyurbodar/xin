import { createSignal, For, Show, type JSX } from "solid-js"
import { Box, Check, KeyRound } from "lucide-solid"
import { Field, INPUT_BOX, PrimaryButton, QuietButton, Spinner, StatusLine, StepCard, TextInput } from "./controls.tsx"
import {
  connectProvider,
  forgetProvider,
  messageOf,
  nextStep,
  onboardingProvider,
  skipStep,
  type ProviderInput,
} from "../../state/onboarding.ts"
import type { ModelInfo, ModelPrice } from "../../state/settings.ts"

type ChoiceId = "anthropic" | "openai" | "openrouter" | "other"
type CustomApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai"

const CHOICES: readonly { readonly id: ChoiceId; readonly name: string; readonly detail: string }[] = [
  { id: "anthropic", name: "Anthropic", detail: "Text, vision, tools" },
  { id: "openai", name: "OpenAI", detail: "Text, vision, tools" },
  { id: "openrouter", name: "OpenRouter", detail: "Many providers, one key" },
  { id: "other", name: "Other", detail: "Any OpenAI-compatible URL" },
]

const APIS: readonly { readonly id: CustomApi; readonly label: string }[] = [
  { id: "openai-completions", label: "OpenAI chat completions" },
  { id: "openai-responses", label: "OpenAI responses" },
  { id: "anthropic-messages", label: "Anthropic messages" },
  { id: "google-generative-ai", label: "Google generative AI" },
]

const VISIBLE_MODELS = 5

function choiceOf(provider: string | undefined): ChoiceId {
  return CHOICES.find((choice) => choice.id === provider)?.id ?? (provider === undefined ? "anthropic" : "other")
}

function apiFrom(value: string): CustomApi {
  return APIS.find((entry) => entry.id === value)?.id ?? "openai-completions"
}

function priceMarks(price: ModelPrice | undefined): string {
  if (price === undefined) return ""
  const perMillion = (price.input + price.output) / 2
  if (perMillion <= 0) return ""
  if (perMillion < 2) return "$"
  return perMillion < 10 ? "$$" : "$$$"
}

function contextLabel(tokens: number): string {
  if (tokens <= 0) return ""
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`
  return `${Math.round(tokens / 1000)}k context`
}

export function ProviderStep(): JSX.Element {
  const saved = onboardingProvider
  const restored = saved()?.provider
  const [choice, setChoice] = createSignal<ChoiceId>(choiceOf(restored))
  const [providerId, setProviderId] = createSignal(choiceOf(restored) === "other" ? (restored ?? "") : "")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [api, setApi] = createSignal<CustomApi>("openai-completions")
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)

  const listed = (): readonly ModelInfo[] => saved()?.models ?? []
  const provider = (): string => (choice() === "other" ? providerId().trim() : choice())

  const touch = (): void => {
    if (saved() !== undefined) forgetProvider()
    setFailure(undefined)
  }

  const submit = async (): Promise<void> => {
    if (busy()) return
    if (saved() !== undefined) {
      nextStep()
      return
    }
    const id = provider()
    if (id === "") {
      setFailure("Give the provider its catalog id, for example groq.")
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
    <StepCard
      width="max-w-[480px]"
      step="Step 2 of 4"
      title="Connect a model provider"
      intro="Add a key from any provider. Every model the catalog lists for it becomes available. You can add more later."
    >
      <div role="radiogroup" aria-label="Provider" class="-mt-1 flex flex-col">
        <For each={CHOICES}>
          {(item) => (
            <button
              type="button"
              role="radio"
              aria-checked={choice() === item.id}
              onClick={() => {
                if (choice() === item.id) return
                setChoice(item.id)
                touch()
              }}
              class="im-press im-hover flex h-[58px] items-center gap-3 rounded-md border px-2.5 text-left"
              classList={{
                "border-line-2 bg-panel": choice() === item.id,
                "border-transparent": choice() !== item.id,
              }}
            >
              <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-ink-2">
                <Box size={14} stroke-width={1.75} aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-base text-ink">{item.name}</span>
                <span class="block text-sm text-ink-3">{item.detail}</span>
              </span>
              <Show when={choice() === item.id}>
                <Check size={16} stroke-width={1.75} class="im-arrive shrink-0 text-accent-ink" aria-hidden="true" />
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show when={choice() === "other"}>
        <Field label="Provider id" hint="The catalog id, for example groq.">
          <TextInput
            value={providerId()}
            onInput={(value) => {
              setProviderId(value)
              touch()
            }}
            placeholder="groq"
            mono
            ariaLabel="Provider id"
          />
        </Field>
        <Field label="Base URL" aside="optional" hint="Only for an endpoint the catalog doesn’t know.">
          <TextInput
            value={baseUrl()}
            onInput={(value) => {
              setBaseUrl(value)
              touch()
            }}
            placeholder="https://api.example.com/v1"
            mono
            ariaLabel="Base URL"
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
              class="h-9 w-full rounded-md border border-line-2 bg-panel px-2.5 text-base text-ink focus:border-accent focus:outline-none"
            >
              <For each={APIS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
            </select>
          </Field>
        </Show>
      </Show>

      <Field label="API key" hint="Stored encrypted in your Durable Object. Only the Captains and their threads use it.">
        <form
          class={INPUT_BOX}
          classList={{ "border-failed": failure() !== undefined, "border-line-2": failure() === undefined }}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <KeyRound size={14} stroke-width={1.75} class="shrink-0 text-icon" aria-hidden="true" />
          <input
            type="password"
            value={key()}
            onInput={(event) => {
              setKey(event.currentTarget.value)
              touch()
            }}
            placeholder={saved() === undefined ? "Paste a key" : "Key saved"}
            autocomplete="off"
            spellcheck={false}
            aria-label="API key"
            aria-invalid={failure() !== undefined}
            disabled={busy() || saved() !== undefined}
            class="h-full min-w-0 flex-1 bg-transparent font-mono text-base text-ink placeholder:font-sans placeholder:text-placeholder focus:outline-none"
          />
          <Show when={busy()}>
            <span class="text-ink-3">
              <Spinner />
            </span>
          </Show>
          <Show when={saved() !== undefined && !busy()}>
            <span class="im-arrive inline-flex h-5 items-center gap-1 rounded-sm bg-done-soft px-1.5 text-xs text-done-text">
              <Check size={12} stroke-width={2} aria-hidden="true" />
              Saved
            </span>
          </Show>
        </form>
        <Show when={saved() !== undefined}>
          <button
            type="button"
            onClick={() => {
              forgetProvider()
              setFailure(undefined)
            }}
            class="self-start text-sm text-ink-3 underline decoration-line-3 underline-offset-2 hover:text-ink-2"
          >
            Use a different key
          </button>
        </Show>
      </Field>

      <StatusLine tone="error" text={failure()} />

      <Show when={saved()}>
        {(result) => (
          <div class="im-content flex flex-col">
            <div class="flex h-7 items-center justify-between border-b border-line-1 text-sm">
              <span class="font-medium text-ink-2">From the catalog</span>
              <span class="text-ink-3">
                {listed().length} {listed().length === 1 ? "model" : "models"}
              </span>
            </div>
            <Show
              when={listed().length > 0}
              fallback={
                <p class="pt-2 text-sm text-ink-3">The catalog lists no models for {result().provider} yet.</p>
              }
            >
              <ul class="im-stagger pt-1">
                <For each={listed().slice(0, VISIBLE_MODELS)}>
                  {(model, index) => (
                    <li class="flex h-7 items-center gap-2.5 text-base" style={{ "--i": String(index()) }}>
                      <Check size={14} stroke-width={1.75} class="shrink-0 text-done" aria-hidden="true" />
                      <span class="min-w-0 flex-1 truncate">{model.name}</span>
                      <span class="shrink-0 text-sm text-ink-3">{contextLabel(model.contextWindow)}</span>
                      <span class="w-7 shrink-0 text-right text-sm text-ink-3">{priceMarks(model.cost)}</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={listed().length > VISIBLE_MODELS}>
                <p class="pt-1 text-sm text-ink-3">and {listed().length - VISIBLE_MODELS} more</p>
              </Show>
            </Show>
          </div>
        )}
      </Show>

      <div class="flex items-center gap-2 pt-1">
        <span class="mr-auto" />
        <QuietButton label="Skip for now" onClick={() => skipStep(1)} />
        <PrimaryButton
          label={saved() === undefined ? "Save key" : "Continue"}
          busy={busy()}
          disabled={saved() === undefined && (key().trim() === "" || provider() === "")}
          onClick={() => void submit()}
        />
      </div>
    </StepCard>
  )
}
