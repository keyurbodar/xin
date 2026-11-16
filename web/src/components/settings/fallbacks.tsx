import { GripVertical, X } from "lucide-solid"
import { createResource, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { fallbacks, MAX_FALLBACKS, saveFallbacks } from "../../state/providers.ts"
import { errorMessage, modelName, searchModels, type ModelInfo, type ModelRef } from "../../state/settings.ts"
import { ModelPicker } from "../composer/model-picker.tsx"
import { Button, Failure, Pending, failureOf } from "../extensions/chrome.tsx"
import { Card, CardBlock, Saved } from "./parts.tsx"

const keyOf = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`
const orderOf = (list: readonly ModelRef[]): string => list.map(keyOf).join("\n")
const nameOf = (ref: ModelRef): string => modelName(ref.provider, ref.modelId) ?? ref.modelId
const HANDLE = "[data-fallback-handle]"
const REMOVE = "[data-fallback-remove]"

/**
 * The owner's fallback order, edited as a draft and written with one `owner.fallbacks.set`. A row's handle moves it
 * with the arrow keys or a drag; the picker offers catalog models not already listed, up to the cap.
 */
export function FallbackList(): JSX.Element {
  const [saved, setSaved] = createSignal<readonly ModelRef[]>([])
  const [draft, setDraft] = createSignal<readonly ModelRef[]>([])
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [done, setDone] = createSignal(false)
  const [said, setSaid] = createSignal("")
  const [dragging, setDragging] = createSignal<number | undefined>(undefined)
  const [query, setQuery] = createSignal("")
  const [found] = createResource(query, searchModels)
  let list: HTMLOListElement | undefined
  let picker: HTMLDivElement | undefined
  let stopDrag: (() => void) | undefined

  onMount(() => {
    void fallbacks.reload().then(() => {
      const state = fallbacks.state()
      if (state.kind !== "ready") return
      setSaved(state.value)
      setDraft(state.value)
    })
  })
  onCleanup(() => stopDrag?.())

  const dirty = (): boolean => orderOf(draft()) !== orderOf(saved())
  const full = (): boolean => draft().length >= MAX_FALLBACKS
  const choices = (): readonly ModelInfo[] => {
    const listed = new Set(draft().map(keyOf))
    return (found.latest?.models ?? []).filter((model) => !listed.has(keyOf(model)))
  }

  const change = (next: readonly ModelRef[], announcement: string): void => {
    setDraft(next)
    setDone(false)
    setSaid(announcement)
  }

  const focusRow = (selector: string, index: number): void => {
    queueMicrotask(() => list?.querySelectorAll<HTMLElement>(selector)[index]?.focus())
  }

  const add = (model: ModelInfo): void => {
    if (full()) return
    const next = [...draft(), { provider: model.provider, modelId: model.modelId }]
    change(next, `${model.name} added, position ${next.length} of ${next.length}`)
    if (next.length >= MAX_FALLBACKS) focusRow(HANDLE, next.length - 1)
  }

  const move = (from: number, to: number): void => {
    const current = draft()
    const moving = current[from]
    if (moving === undefined || to < 0 || to >= current.length || to === from) return
    const next = current.filter((_, index) => index !== from)
    next.splice(to, 0, moving)
    change(next, `${nameOf(moving)} moved to position ${to + 1} of ${next.length}`)
    focusRow(HANDLE, to)
  }

  const remove = (index: number): void => {
    const removed = draft()[index]
    if (removed === undefined) return
    const next = draft().filter((_, at) => at !== index)
    change(next, `${nameOf(removed)} removed`)
    if (next.length > 0) focusRow(REMOVE, Math.min(index, next.length - 1))
    else queueMicrotask(() => picker?.querySelector<HTMLButtonElement>("button")?.focus())
  }

  const save = async (): Promise<void> => {
    if (saving() || !dirty()) return
    setSaving(true)
    setError(undefined)
    try {
      const stored = await saveFallbacks(draft())
      setSaved(stored)
      setDraft(stored)
      setDone(true)
      setSaid("Fallback order saved")
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const drag = (index: number, event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    stopDrag?.()
    let at = index
    const follow = (moved: PointerEvent): void => {
      const rows = [...(list?.querySelectorAll<HTMLElement>("[data-fallback-row]") ?? [])]
      const target = rows.findIndex((row) => {
        const box = row.getBoundingClientRect()
        return moved.clientY >= box.top && moved.clientY < box.bottom
      })
      if (target === -1 || target === at) return
      move(at, target)
      at = target
      setDragging(target)
    }
    const stop = (): void => {
      setDragging(undefined)
      stopDrag = undefined
      window.removeEventListener("pointermove", follow)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
    stopDrag = stop
    setDragging(index)
    window.addEventListener("pointermove", follow)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  return (
    <>
      <Show when={failureOf(fallbacks.state())}>
        {(message) => <Failure message={message()} onRetry={() => void fallbacks.reload()} />}
      </Show>
      <Show when={fallbacks.state().kind === "loading"}>
        <Pending label="Reading fallbacks" />
      </Show>
      <Show when={fallbacks.state().kind === "ready"}>
        <div class="flex flex-col gap-2">
          <Card>
            <CardBlock class="p-0">
              <Show
                when={draft().length > 0}
                fallback={<p class="m-0 px-4 py-3 text-small text-ink-3">No fallbacks. A run that fails on a provider error stays failed.</p>}
              >
                <ol ref={list} aria-label="Fallback order" class="m-0 flex list-none flex-col p-0 [&>li+li]:border-t [&>li]:border-line-1">
                  <For each={draft()}>
                    {(ref, index) => (
                      <li
                        data-fallback-row={keyOf(ref)}
                        data-dragging={dragging() === index() ? "" : undefined}
                        class="flex items-center gap-2 px-2 py-1.5 data-[dragging]:bg-hover"
                      >
                        <button
                          type="button"
                          data-fallback-handle=""
                          aria-label={`Move ${nameOf(ref)}, position ${index() + 1} of ${draft().length}`}
                          aria-describedby="fallback-move-hint"
                          onKeyDown={(event) => {
                            if (event.key === "ArrowUp") move(index(), index() - 1)
                            else if (event.key === "ArrowDown") move(index(), index() + 1)
                            else if (event.key === "Home") move(index(), 0)
                            else if (event.key === "End") move(index(), draft().length - 1)
                            else return
                            event.preventDefault()
                          }}
                          onPointerDown={(event) => drag(index(), event)}
                          class="grid h-[var(--h-control-sm)] w-[var(--h-control-sm)] shrink-0 cursor-grab touch-none place-items-center rounded-sm text-icon outline-none hover:text-ink focus-visible:shadow-[0_0_0_3px_var(--color-primary-soft)]"
                        >
                          <GripVertical size={14} stroke-width={1.5} aria-hidden="true" />
                        </button>
                        <span class="w-5 shrink-0 font-mono text-mini text-ink-3">{index() + 1}</span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-small text-ink">{nameOf(ref)}</span>
                          <span class="block truncate font-mono text-micro text-icon">{ref.provider}</span>
                        </span>
                        <button
                          type="button"
                          data-fallback-remove=""
                          aria-label={`Remove ${nameOf(ref)}`}
                          onClick={() => remove(index())}
                          class="grid h-[var(--h-control-sm)] w-[var(--h-control-sm)] shrink-0 place-items-center rounded-sm text-icon outline-none hover:bg-secondary hover:text-ink focus-visible:shadow-[0_0_0_3px_var(--color-primary-soft)]"
                        >
                          <X size={14} stroke-width={1.5} aria-hidden="true" />
                        </button>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </CardBlock>
          </Card>
          <p id="fallback-move-hint" class="sr-only">
            Arrow keys move it up or down, Home and End to the top or bottom. The handle also drags.
          </p>
          <p role="status" class="sr-only">
            {said()}
          </p>
          <Show when={error()}>{(message) => <Failure message={message()} />}</Show>
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={!full()}
              fallback={<span class="text-mini text-ink-3">{MAX_FALLBACKS} of {MAX_FALLBACKS}. Remove one to add another.</span>}
            >
              <div ref={picker} class="contents">
                <ModelPicker
                  label="Add a fallback"
                  current={undefined}
                  models={choices()}
                  omitted={found.latest?.omitted ?? 0}
                  query={query()}
                  onSearch={setQuery}
                  onPick={add}
                />
              </div>
              <span class="font-mono text-micro text-icon">
                {draft().length} / {MAX_FALLBACKS}
              </span>
            </Show>
            <span class="ml-auto" />
            <Saved show={done() && !dirty()} />
            <Button size="sm" variant="quiet" idle={!dirty() || saving()} onClick={() => change(saved(), "Changes discarded")}>
              Discard
            </Button>
            <Button size="sm" variant="primary" idle={!dirty()} busy={saving()} onClick={() => void save()}>
              {saving() ? "Saving" : "Save order"}
            </Button>
          </div>
        </div>
      </Show>
    </>
  )
}
