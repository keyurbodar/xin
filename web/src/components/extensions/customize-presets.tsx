import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { deletePrompt, errorMessage, presets, prompts, putPrompt, type PresetRow, type Prompt } from "../../state/extensions.ts"
import { Button, Chip, Empty, Failure, Note, Panel, Pending, failureOf } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function Prompts(): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const [creating, setCreating] = createSignal(false)

  onMount(() => {
    void prompts.reload()
  })

  const list = (): readonly Prompt[] => {
    const state = prompts.state()
    return state.kind === "ready" ? state.value : []
  }

  const current = (): Prompt | undefined => list().find((prompt) => prompt.name === selected())

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Prompts</span>
          <span class="text-[12px] text-fg-3">{list().length}</span>
          <span class="ml-auto" />
          <Button size="sm" variant="quiet" onClick={() => setCreating(true)}>
            <Glyph name="plus" size={13} />
            New
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={prompts.state().kind === "loading"}>
            <div class="p-3">
              <Pending label="Reading prompts" />
            </div>
          </Show>
          <Show when={failureOf(prompts.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void prompts.reload()} />
              </div>
            )}
          </Show>
          <For each={list()}>
            {(prompt) => (
              <button
                type="button"
                onClick={() => {
                  setCreating(false)
                  setSelected(prompt.name)
                }}
                class="flex w-full items-start gap-2.5 border-b border-line px-3.5 py-2.5 text-left hover:bg-hover"
                classList={{ "bg-hover": !creating() && selected() === prompt.name }}
              >
                <span class="mt-0.5 shrink-0 rounded-[2px] border border-line-inner bg-page px-1.5 py-0.5 font-mono text-[11px] text-fg-2">
                  /{prompt.name}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] text-fg">{prompt.description ?? prompt.name}</span>
                  <span class="line-clamp-1 block text-[11.5px] text-fg-3">{prompt.text}</span>
                </span>
              </button>
            )}
          </For>
          <Show when={prompts.state().kind === "ready" && list().length === 0}>
            <div class="p-3">
              <Empty
                title="No prompts yet."
                detail="A prompt is a slash command. Type /name in a chat and Xin sends its text, followed by anything you type after the name."
              />
            </div>
          </Show>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={creating()}
          fallback={
            <Show
              keyed
              when={current()}
              fallback={
                <div class="px-6 py-6">
                  <Empty
                    title="Pick a prompt."
                    detail="Each prompt becomes a slash command in the composer, as in /weekly sent to a project chat."
                  />
                </div>
              }
            >
              {(prompt) => (
                <PromptEditor
                  prompt={prompt}
                  onSaved={(name) => setSelected(name)}
                  onDeleted={() => setSelected(undefined)}
                />
              )}
            </Show>
          }
        >
          <PromptEditor onSaved={(name) => {
            setCreating(false)
            setSelected(name)
          }} onDeleted={() => setCreating(false)} />
        </Show>
      </div>
    </>
  )
}

function PromptEditor(props: {
  prompt?: Prompt
  onSaved: (name: string) => void
  onDeleted: () => void
}): JSX.Element {
  const [name, setName] = createSignal(props.prompt?.name ?? "")
  const [description, setDescription] = createSignal(props.prompt?.description ?? "")
  const [text, setText] = createSignal(props.prompt?.text ?? "")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [confirming, setConfirming] = createSignal(false)

  const valid = (): boolean => /^[a-z][a-z0-9-]*$/u.test(name()) && text().trim() !== ""

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const trimmed = description().trim()
      await putPrompt(name(), text(), trimmed === "" ? undefined : trimmed)
      props.onSaved(name())
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    const target = props.prompt
    if (target === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await deletePrompt(target.name)
      props.onDeleted()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="flex items-center gap-3 border-b border-line px-6 py-4">
        <Glyph name="scroll-text" size={16} class="text-fg-3" />
        <div class="min-w-0 flex-1">
          <span class="block truncate text-[16px] font-medium text-fg">
            {props.prompt === undefined ? "New prompt" : `/${props.prompt.name}`}
          </span>
          <span class="block text-[12px] text-fg-3">A slash command in every chat</span>
        </div>
        <Show when={props.prompt}>
          <Show
            when={confirming()}
            fallback={
              <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>
                <Glyph name="trash" size={14} />
                Delete
              </Button>
            }
          >
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
            <Button size="sm" variant="danger" disabled={busy()} onClick={() => void remove()}>
              {busy() ? "Deleting" : "Delete prompt"}
            </Button>
          </Show>
        </Show>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div class="flex max-w-[640px] flex-col gap-4">
          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>
          <label class="flex flex-col gap-1.5">
            <span class="label">Name</span>
            <div class="flex h-8 items-center gap-1.5 rounded-[2px] border border-line-inner bg-page px-2.5">
              <span class="font-mono text-[12px] text-fg-3">/</span>
              <input
                value={name()}
                onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
                disabled={props.prompt !== undefined}
                placeholder="weekly"
                spellcheck={false}
                class="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-4 disabled:opacity-60"
              />
            </div>
            <span class="text-[11.5px] text-fg-3">Lowercase letters, digits and dashes. A name cannot be renamed; make a new prompt instead.</span>
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="label">Description</span>
            <input
              value={description()}
              onInput={(event) => setDescription(event.currentTarget.value)}
              placeholder="Summarise the week across threads"
              class="h-8 rounded-[2px] border border-line-inner bg-page px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4"
            />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="label">Text</span>
            <Panel>
              <textarea
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                rows={8}
                maxLength={8_000}
                spellcheck={false}
                placeholder="Summarise this week across every thread in the project. Group by outcome, then list what still waits."
                class="w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[12px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
              />
            </Panel>
          </label>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={!valid() || busy()} onClick={() => void save()}>
              {busy() ? "Saving" : "Save prompt"}
            </Button>
            <span class="ml-auto text-[11.5px] text-fg-3">{text().length} of 8,000</span>
          </div>
        </div>
      </div>
    </>
  )
}

function toolsOf(preset: { readonly tools: "all" | readonly string[] }): readonly string[] {
  return preset.tools === "all" ? [] : preset.tools
}

export function Presets(): JSX.Element {
  const [selected, setSelected] = createSignal<string | undefined>(undefined)
  const list = (): readonly PresetRow[] => {
    const state = presets.state()
    return state.kind === "ready" ? state.value.presets : []
  }
  const current = () => list().find((preset) => preset.id === selected())

  return (
    <>
      <div class="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div class="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <span class="label">Presets</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={presets.state().kind === "loading"}>
            <Pending label="Reading presets" />
          </Show>
          <Show when={failureOf(presets.state())}>
            {(message) => (
              <div class="p-3">
                <Failure message={message()} onRetry={() => void presets.reload()} />
              </div>
            )}
          </Show>
          <For each={list()}>
            {(preset) => (
              <button
                type="button"
                onClick={() => setSelected(preset.id)}
                class="flex w-full items-start gap-2.5 border-b border-line px-3.5 py-3 text-left hover:bg-hover"
                classList={{ "bg-hover": selected() === preset.id }}
              >
                <Glyph name="layers" size={15} class="mt-0.5 shrink-0 text-fg-3" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium text-fg">{preset.name}</span>
                    <Show when={preset.isDefault}>
                      <Chip>Default</Chip>
                    </Show>
                  </span>
                  <span class="line-clamp-2 block text-[11.5px] leading-snug text-fg-3">
                    {preset.description ?? (preset.tools === "all" ? "Every tool row." : `${preset.tools.length} tools`)}
                  </span>
                </span>
              </button>
            )}
          </For>
          <Show when={presets.state().kind === "ready" && list().length === 0}>
            <div class="p-3">
              <Empty title="No presets." detail="Presets bundle tool access for a thread." />
            </div>
          </Show>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={current()}
          fallback={
            <div class="px-6 py-6">
              <Empty title="Pick a preset." detail="A thread cannot raise its own preset; the composer chip chooses one per message." />
            </div>
          }
        >
          {(preset) => (
            <>
              <header class="flex items-center gap-3 border-b border-line px-6 py-4">
                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
                  <Glyph name="layers" size={18} />
                </span>
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-[16px] font-medium text-fg">{preset().name}</span>
                  <span class="mono-meta block">{preset().id}</span>
                </div>
                <Show when={preset().isDefault}>
                  <Chip>Default for new threads</Chip>
                </Show>
              </header>
              <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div class="flex max-w-[520px] flex-col gap-4">
                  <Show when={preset().description}>
                    {(description) => <p class="text-[13px] leading-relaxed text-fg-2">{description()}</p>}
                  </Show>
                  <Panel>
                    <div class="border-b border-line px-3.5 py-2.5">
                      <span class="label">Tools</span>
                    </div>
                    <div class="px-3.5 py-3">
                      <Show
                        when={preset().tools !== "all"}
                        fallback={<span class="text-[12.5px] text-fg-2">Every tool row.</span>}
                      >
                        <div class="flex flex-wrap gap-1.5">
                          <For each={toolsOf(preset())}>
                            {(tool) => <Chip>{tool}</Chip>}
                          </For>
                        </div>
                      </Show>                    </div>
                  </Panel>
                  <Note>
                    The preset is picked per thread in the composer. Selecting one for a conversation goes through
                    preset.select, which needs a conversation id this screen does not own.
                  </Note>
                  <Note>
                    Presets are declared in the presets row's config, so the list is edited in Advanced, not here.
                  </Note>
                </div>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  )
}

