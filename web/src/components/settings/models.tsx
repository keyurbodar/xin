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
import { Button, Chip, Failure, INPUT, MONO_INPUT, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Group } from "./parts.tsx"

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
  })

  const list = (): ModelsList => {
    const state = models.state()
    return state.kind === "ready" ? state.value : EMPTY_MODELS
  }

  return (
    <div class="flex max-w-[900px] flex-col gap-6">
      <Show when={failureOf(models.state())}>
        {(message) => <Failure message={message()} onRetry={() => void models.reload()} />}
      </Show>

      <Group title="Providers" detail="Only providers with a key answer, so only they can list models">
        <Show when={models.state().kind === "loading"}>
          <Pending label="Reading providers" />
        </Show>
        <Show when={models.state().kind === "ready"}>
          <div class="flex flex-col gap-2">
            <Panel>
              <Show
                when={providers(list()).length > 0}
                fallback={
                  <div class="px-3.5 py-3 text-[12.5px] text-fg-3">
                    No provider has a key yet. Add one to see its models.
                  </div>
                }
              >
                <For each={providers(list())}>{(provider) => <ProviderRow provider={provider} />}</For>
              </Show>
            </Panel>
            <div class="flex items-center gap-2">
              <Button label="Add provider" icon="plus" onClick={() => setAdding((open) => !open)} />
              <Show when={list().omitted > 0}>
                <span class="text-[11.5px] text-fg-3">{list().omitted} more models are not listed</span>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={adding()}>
          <AddProvider onDone={() => setAdding(false)} />
        </Show>
      </Group>

      <Group title="Catalog" detail="The list comes from your providers; nothing is hard-coded">
        <Panel>
          <div class="grid grid-cols-[minmax(0,1fr)_120px_100px_80px_90px] gap-2 border-b border-line px-3.5 py-2">
            <span class="label">Model</span>
            <span class="label">Provider</span>
            <span class="label">Context</span>
            <span class="label">Images</span>
            <span class="label">Reasoning</span>
          </div>
          <Show
            when={list().models.length > 0}
            fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">The catalog is empty.</div>}
          >
            <For each={list().models}>{(model) => <CatalogRow model={model} />}</For>
          </Show>
        </Panel>
      </Group>

      <Note>Per-role defaults are set in General. A project or thread can override them when it switches model.</Note>
    </div>
  )
}

function ProviderRow(props: { provider: ProviderSummary }): JSX.Element {
  const [editing, setEditing] = createSignal(false)
  const [key, setKey] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const save = async (): Promise<void> => {
    if (key().trim() === "" || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await saveCredential(props.provider.id, key().trim())
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
    <div class="border-b border-line px-3.5 py-3 last:border-0">
      <div class="flex items-center gap-3">
        <span class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover font-mono text-[12px] uppercase text-fg-2">
          {props.provider.id.slice(0, 1)}
        </span>
        <div class="min-w-0 flex-1">
          <span class="block truncate text-[12.5px] font-medium text-fg">{props.provider.id}</span>
          <span class="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <span class="h-1.5 w-1.5 rounded-[1px] bg-ok" />
            Connected · {props.provider.models.length} {props.provider.models.length === 1 ? "model" : "models"}
          </span>
        </div>
        <span class="font-mono text-[11px] text-fg-4">stored sealed</span>
        <Show when={!confirming()}>
          <Button label="Edit" variant="ghost" onClick={() => setEditing((open) => !open)} />
          <Button label="Remove" variant="ghost" onClick={() => setConfirming(true)} />
        </Show>
      </div>

      <Show when={error()}>
        {(message) => (
          <div class="mt-2">
            <Failure message={message()} />
          </div>
        )}
      </Show>

      <Show when={editing()}>
        <div class="mt-2.5 flex items-center gap-2">
          <input
            type="password"
            value={key()}
            onInput={(event) => setKey(event.currentTarget.value)}
            placeholder={`New ${props.provider.id} API key`}
            autocomplete="off"
            spellcheck={false}
            class={MONO_INPUT}
            aria-label={`${props.provider.id} API key`}
          />
          <Button label={busy() ? "Saving" : "Save key"} variant="primary" disabled={busy() || key().trim() === ""} onClick={() => void save()} />
        </div>
      </Show>

      <Show when={confirming()}>
        <div class="mt-2.5 flex items-center gap-2 rounded-[4px] border border-bad/30 bg-bad-bg px-3 py-2">
          <span class="min-w-0 flex-1 text-[12px] text-fg-2">
            Removing the key hides {props.provider.id}'s models from every picker.
          </span>
          <Button label="Keep" variant="ghost" onClick={() => setConfirming(false)} />
          <Button label={busy() ? "Removing" : "Remove key"} variant="danger" disabled={busy()} onClick={() => void remove()} />
        </div>
      </Show>
    </div>
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
      props.onDone()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 rounded-[4px] border border-line bg-surface p-3.5">
      <div class="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span class="text-[12.5px] text-fg-2">Provider id</span>
        <input
          value={id()}
          onInput={(event) => setId(event.currentTarget.value)}
          placeholder="openai"
          spellcheck={false}
          class={MONO_INPUT}
          aria-label="Provider id"
        />
        <span class="text-[12.5px] text-fg-2">API key</span>
        <input
          type="password"
          value={key()}
          onInput={(event) => setKey(event.currentTarget.value)}
          autocomplete="off"
          spellcheck={false}
          class={MONO_INPUT}
          aria-label="API key"
        />
      </div>
      <label class="flex items-center gap-2 text-[12.5px] text-fg-2">
        <input
          type="checkbox"
          checked={custom()}
          onChange={(event) => setCustom(event.currentTarget.checked)}
          class="h-3.5 w-3.5 accent-accent"
        />
        Custom endpoint
      </label>
      <Show when={custom()}>
        <div class="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span class="text-[12.5px] text-fg-2">Base URL</span>
          <input
            value={baseUrl()}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
            placeholder="https://api.example.com/v1"
            spellcheck={false}
            class={MONO_INPUT}
            aria-label="Base URL"
          />
          <span class="text-[12.5px] text-fg-2">API</span>
          <select
            value={api()}
            onChange={(event) => setApi(event.currentTarget.value)}
            class={`${INPUT} max-w-[260px]`}
            aria-label="API shape"
          >
            <For each={APIS}>{(entry) => <option value={entry.value}>{entry.label}</option>}</For>
          </select>
        </div>
      </Show>
      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>
      <div class="flex items-center gap-2">
        <Note>A provider id that is not built in needs a custom endpoint, or its key has nothing to attach to.</Note>
        <span class="ml-auto" />
        <Button label="Cancel" variant="ghost" onClick={props.onDone} />
        <Button label={busy() ? "Saving" : "Add provider"} variant="primary" disabled={busy() || !valid()} onClick={() => void submit()} />
      </div>
    </div>
  )
}

function CatalogRow(props: { model: ModelInfo }): JSX.Element {
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_120px_100px_80px_90px] items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
      <span class="min-w-0">
        <span class="block truncate text-fg">{props.model.name}</span>
        <span class="block truncate font-mono text-[10.5px] text-fg-4">{props.model.modelId}</span>
      </span>
      <span class="truncate text-[11.5px] text-fg-2">{props.model.provider}</span>
      <span class="font-mono text-[11.5px] text-fg-2">
        {props.model.contextWindow === 0 ? "—" : `${Math.round(props.model.contextWindow / 1000)}k`}
      </span>
      <Chip tone={props.model.vision ? "ok" : "default"}>{props.model.vision ? "Yes" : "No"}</Chip>
      <Chip>{props.model.reasoning ? "Yes" : "No"}</Chip>
    </div>
  )
}
