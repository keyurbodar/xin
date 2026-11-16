import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import {
  deleteCredential,
  errorMessage,
  models,
  providers,
  saveCredential,
  type ModelInfo,
  type ModelsList,
  type ProviderSummary,
} from "../../state/settings.ts"
import { providerHealth, testCredential, type CredentialTest, type ProviderHealth } from "../../state/providers.ts"
import { Button, Chip, Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { IntegrationRow } from "../ui/integration-row.tsx"
import { lazyView } from "../ui/lazy-view.tsx"
import { Signal } from "../ui/signal.tsx"
import { providerDetail, providerStatus } from "../../lib/integrations.ts"
import { loadUiSdk } from "../../lib/ui-sdk-lazy.ts"
import { Card, CheckboxField, Group, SelectField, TextField } from "./parts.tsx"

const FallbackList = lazyView(
  () => import("./fallbacks.tsx").then((module) => module.FallbackList),
  () => <Pending label="Reading fallbacks" />,
)

const APIS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "openai-completions", label: "OpenAI completions" },
  { value: "openai-responses", label: "OpenAI responses" },
  { value: "anthropic-messages", label: "Anthropic messages" },
  { value: "google-generative-ai", label: "Google generative AI" },
]

const EMPTY_MODELS: ModelsList = { models: [], omitted: 0 }

export function Models(): JSX.Element {
  const [adding, setAdding] = createSignal(false)

  onMount(() => {
    void models.reload()
    void providerHealth.reload()
  })

  const list = (): ModelsList => {
    const state = models.state()
    return state.kind === "ready" ? state.value : EMPTY_MODELS
  }

  return (
    <>
      <Show when={failureOf(models.state())}>
        {(message) => <Failure message={message()} onRetry={() => void models.reload()} />}
      </Show>

      <Group title="Providers" detail="Only providers with a key answer, so only they can list models">
        <Show when={models.state().kind === "loading"}>
          <Pending label="Reading providers" />
        </Show>
        <Show when={models.state().kind === "ready"}>
          <div class="flex flex-col gap-2">
            <Card>
              <Show
                when={providers(list()).length > 0}
                fallback={<div class="px-4 py-3 text-small text-ink-3">No provider has a key yet. Add one to see its models.</div>}
              >
                <For each={providers(list())}>{(provider) => <ProviderRow provider={provider} />}</For>
              </Show>
            </Card>
            <div class="flex items-center gap-2">
              <Button size="sm" onClick={() => setAdding((open) => !open)}>
                <Glyph name="plus" size={14} />
                Add provider
              </Button>
              <Show when={list().omitted > 0}>
                <span class="text-mini text-ink-3">{list().omitted} more models are not listed</span>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={adding()}>
          <AddProvider onDone={() => setAdding(false)} />
        </Show>
      </Group>

      <Group title="Fallback models" detail="When a run fails on a provider error, it moves to the first model here it has not tried">
        <FallbackList />
      </Group>

      <Group title="Catalog" detail="The list comes from your providers; nothing is hard-coded">
        <Card>
          <div class="grid grid-cols-[minmax(0,1fr)_96px_64px_56px_72px] gap-2 px-4 py-2 max-sm:grid-cols-[minmax(0,1fr)_64px]">
            <span class="text-mini font-title text-ink-3">Model</span>
            <span class="text-mini font-title text-ink-3 max-sm:hidden">Provider</span>
            <span class="text-mini font-title text-ink-3">Context</span>
            <span class="text-mini font-title text-ink-3 max-sm:hidden">Images</span>
            <span class="text-mini font-title text-ink-3 max-sm:hidden">Reasoning</span>
          </div>
          <Show
            when={list().models.length > 0}
            fallback={<div class="px-4 py-3 text-small text-ink-3">The catalog is empty.</div>}
          >
            <For each={list().models}>{(model) => <CatalogRow model={model} />}</For>
          </Show>
        </Card>
      </Group>

      <Note>Per-role defaults are set in General. A project or thread can override them when it switches model.</Note>
    </>
  )
}

function ProviderRow(props: { provider: ProviderSummary }): JSX.Element {
  const [editing, setEditing] = createSignal(false)
  const [key, setKey] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [testing, setTesting] = createSignal(false)
  const [tested, setTested] = createSignal<CredentialTest | undefined>(undefined)

  const health = (): ProviderHealth | undefined => {
    const state = providerHealth.state()
    return state.kind === "ready" ? state.value.get(props.provider.id) : undefined
  }

  const test = async (): Promise<void> => {
    if (testing()) return
    setTesting(true)
    setTested(undefined)
    try {
      setTested(await testCredential(props.provider.id))
    } catch (failure: unknown) {
      setTested({ ok: false, error: errorMessage(failure) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (key().trim() === "" || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await saveCredential(props.provider.id, key().trim())
      void providerHealth.reload()
      setKey("")
      setEditing(false)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteCredential(props.provider.id)
      setConfirming(false)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="px-4 py-3" data-provider={props.provider.id}>
      <IntegrationRow
        mark={
          <span class="grid h-[var(--h-control)] w-[var(--h-control)] shrink-0 place-items-center rounded-sm bg-secondary font-mono text-small uppercase text-ink-2 shadow-ring">
            {props.provider.id.slice(0, 1)}
          </span>
        }
        name={props.provider.id}
        detail={providerDetail(props.provider)}
        status={providerStatus(error())}
        actions={
          <Show when={!confirming()}>
            <Show when={health()}>{(known) => <HealthDot provider={props.provider.id} health={known()} />}</Show>
            <Button size="sm" variant="quiet" busy={testing()} onClick={() => void test()}>{testing() ? "Testing" : "Test"}</Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing((open) => !open)}>Edit</Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>Remove</Button>
          </Show>
        }
      />

      <p role="status" data-credential-test={props.provider.id} class="m-0 empty:hidden">
        <Show when={tested()}>
          {(result) => {
            const outcome = result()
            return (
              <span class="mt-2 flex items-start gap-2 text-mini">
                <span class="mt-px flex shrink-0">
                  <Signal state={outcome.ok ? "done" : "failed"} size={12} />
                </span>
                <span class="min-w-0 break-words" classList={{ "text-ink-2": outcome.ok, "text-failed": !outcome.ok }}>
                  {outcome.ok ? `The key answered in ${outcome.latencyMs.toLocaleString("en-US")} ms` : outcome.error}
                </span>
              </span>
            )
          }}
        </Show>
      </p>

      <Show when={error()}>
        {(message) => (
          <div class="mt-2">
            <Failure message={message()} />
          </div>
        )}
      </Show>

      <Show when={editing()}>
        <div class="mt-2.5 flex items-center gap-2">
          <TextField
            mono
            type="password"
            value={key()}
            onInput={(event) => setKey(event.currentTarget.value)}
            placeholder={`New ${props.provider.id} API key`}
            autocomplete="off"
            spellcheck={false}
            aria-label={`${props.provider.id} API key`}
          />
          <Button size="sm" variant="primary" disabled={busy() || key().trim() === ""} onClick={() => void save()}>{busy() ? "Testing key" : "Save key"}</Button>
        </div>
      </Show>

      <Show when={confirming()}>
        <div class="mt-2.5 flex flex-wrap items-center gap-2 rounded-md bg-failed-soft px-3 py-2">
          <span class="min-w-0 flex-1 text-small text-ink-2">
            Removing the key hides {props.provider.id}'s models from every picker.
          </span>
          <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
          <Button size="sm" variant="danger" disabled={busy()} onClick={() => void remove()}>{busy() ? "Removing" : "Remove key"}</Button>
        </div>
      </Show>
    </div>
  )
}

/** The provider's newest response outcome as a dot; its tooltip carries the error. */
function HealthDot(props: { provider: string; health: ProviderHealth }): JSX.Element {
  onMount(() => void loadUiSdk("tooltip"))
  const failing = (): boolean => props.health.state === "failing"
  return (
    <ui-tooltip>
      <ui-tooltip-trigger>
        <button
          type="button"
          data-health={props.health.state}
          aria-label={`${props.provider} health: ${failing() ? "failing" : "answering"}`}
          class="grid h-[var(--h-control-sm)] w-[var(--h-control-sm)] place-items-center rounded-sm outline-none focus-visible:shadow-[0_0_0_3px_var(--color-primary-soft)]"
        >
          <span aria-hidden="true" class="size-2 rounded-full" classList={{ "bg-done": !failing(), "bg-failed": failing() }} />
        </button>
      </ui-tooltip-trigger>
      <ui-tooltip-content
        side="top"
        side-offset="6"
        class="im-tip max-w-[280px] break-words rounded-sm bg-inverse px-2 py-1 text-mini text-on-inverse shadow-[var(--shadow-popover)]"
      >
        {failing() ? (props.health.error ?? "The last request failed") : "The last request answered"}
      </ui-tooltip-content>
    </ui-tooltip>
  )
}

function AddProvider(props: { onDone: () => void }): JSX.Element {
  const [id, setId] = createSignal("")
  const [key, setKey] = createSignal("")
  const [custom, setCustom] = createSignal(false)
  const [baseUrl, setBaseUrl] = createSignal("")
  const [api, setApi] = createSignal("openai-completions")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const valid = (): boolean => {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id().trim()) || key().trim() === "") return false
    if (!custom()) return true
    try {
      return new URL(baseUrl().trim()).protocol === "https:"
    } catch {
      return false
    }
  }

  const submit = async (): Promise<void> => {
    if (!valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await saveCredential(
        id().trim(),
        key().trim(),
        custom() ? { baseUrl: baseUrl().trim(), api: api() } : undefined,
      )
      void providerHealth.reload()
      props.onDone()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 rounded-lg p-4 shadow-ring">
      <div class="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 max-sm:grid-cols-1 max-sm:gap-1.5">
        <span class="text-small text-ink-2">Provider id</span>
        <TextField
          mono
          value={id()}
          onInput={(event) => setId(event.currentTarget.value)}
          placeholder="openai"
          spellcheck={false}
          aria-label="Provider id"
        />
        <span class="text-small text-ink-2">API key</span>
        <TextField
          mono
          type="password"
          value={key()}
          onInput={(event) => setKey(event.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
          aria-label="API key"
        />
      </div>
      <CheckboxField label="Custom endpoint" checked={custom()} onChange={setCustom} />
      <Show when={custom()}>
        <div class="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 max-sm:grid-cols-1 max-sm:gap-1.5">
          <span class="text-small text-ink-2">Base URL</span>
          <TextField
            mono
            value={baseUrl()}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="https://api.example.com/v1"
            spellcheck={false}
            aria-label="Base URL"
          />
          <span class="text-small text-ink-2">API</span>
          <SelectField ariaLabel="API shape" value={api()} required onChange={setApi} choices={APIS} />
        </div>
      </Show>
      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <Note>A provider id that is not built in needs a custom endpoint, or its key has nothing to attach to.</Note>
        <span class="ml-auto" />
        <Button size="sm" variant="quiet" onClick={props.onDone}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={busy() || !valid()} onClick={() => void submit()}>{busy() ? "Testing key" : "Add provider"}</Button>
      </div>
    </div>
  )
}

function CatalogRow(props: { model: ModelInfo }): JSX.Element {
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_96px_64px_56px_72px] items-center gap-2 px-4 py-2 text-small max-sm:grid-cols-[minmax(0,1fr)_64px]">
      <span class="min-w-0">
        <span class="block truncate text-ink">{props.model.name}</span>
        <span class="block truncate font-mono text-micro text-icon">{props.model.modelId}</span>
      </span>
      <span class="truncate text-mini text-ink-2 max-sm:hidden">{props.model.provider}</span>
      <span class="font-mono text-mini text-ink-2">
        {props.model.contextWindow === 0 ? "—" : `${Math.round(props.model.contextWindow / 1000)}k`}
      </span>
      <Chip tone={props.model.vision ? "ok" : "default"} class="max-sm:hidden">{props.model.vision ? "Yes" : "No"}</Chip>
      <Chip class="max-sm:hidden">{props.model.reasoning ? "Yes" : "No"}</Chip>
    </div>
  )
}
