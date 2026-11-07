import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { errorMessage, installFromMarket, offeredVersion, type InstallResult, type MarketDetail } from "../../state/extensions.ts"
import { Button, Chip, Failure, Note } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

export function InstallSheet(props: {
  name: string
  detail: MarketDetail
  title: string
  author?: string | undefined
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [result, setResult] = createSignal<InstallResult | undefined>(undefined)

  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const version = (): string => offeredVersion(props.detail)?.version ?? "latest"

  const install = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      setResult(await installFromMarket(props.name))
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="fixed inset-0 z-50">
      <button type="button" aria-label="Close install review" onClick={props.onClose} class="absolute inset-0 bg-black/65" />
      <section class="enter-sheet absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l border-line-inner bg-raised shadow-2xl">
        <header class="flex items-center gap-3 border-b border-line px-5 py-4">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-hover text-fg">
            <Glyph name="package" size={18} />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-[15px] font-medium text-fg">Install {props.title}</h2>
            <span class="block truncate text-[12px] text-fg-3">
              v{version()}
              <Show when={props.author}>
                {(author) => <span> · {author()}</span>}
              </Show>
            </span>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            class="text-fg-3 transition-none hover:text-fg"
          >
            <Glyph name="x" size={16} />
          </button>
        </header>

        <div class="flex border-b border-line px-5">
          <Step n="1" label="Review" state="active" />
          <Step n="2" label="Install" state={result() === undefined ? "pending" : "done"} />
          <Step n="3" label="Configure" state="pending" />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div class="flex flex-col gap-5">
            <Show when={result() === undefined}>
              <section>
                <span class="label mb-2 block">What will mount</span>
                <Show
                  when={props.detail.rows.length > 0}
                  fallback={<Note>This package mounts no rows of its own; it only records the package.</Note>}
                >
                  <div class="overflow-hidden rounded-[4px] border border-line">
                    <For each={props.detail.rows}>
                      {(row) => (
                        <div class="flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-0">
                          <Glyph name="layers" size={14} class="shrink-0 text-fg-2" />
                          <div class="min-w-0 flex-1">
                            <code class="block truncate font-mono text-[12px] text-fg">{row.id}</code>
                            <span class="block truncate text-[11.5px] text-fg-3">{row.plugin}</span>
                          </div>
                          <Chip>{row.disabled ? "Starts off" : "Starts on"}</Chip>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>

              <Show when={props.detail.requires.length > 0}>
                <section>
                  <span class="label mb-2 block">Also records</span>
                  <div class="overflow-hidden rounded-[4px] border border-line">
                    <For each={props.detail.requires}>
                      {(spec) => (
                        <div class="flex items-center gap-2 border-b border-line px-3 py-2 last:border-0">
                          <Glyph name="package" size={13} class="text-fg-3" />
                          <code class="font-mono text-[12px] text-fg-2">{spec}</code>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              <section>
                <span class="label mb-2 block">After install</span>
                <div class="overflow-hidden rounded-[4px] border border-line bg-page px-3 py-2.5">
                  <Line text="Fetch" detail={`${props.name}@${version()}`} />
                  <Line text="Mount" detail={`${props.detail.rows.length} rows, composed by the loader`} />
                  <Line text="Configure" detail="row settings live in Customize" />
                  <Show when={props.detail.kind === "code"}>
                    <Line text="Build" detail="code plugins are recorded and build on the next update" />
                  </Show>
                </div>
                <div class="mt-2">
                  <Note>
                    Nothing runs until you press Install. Keys are added per row afterwards; they are never shown to models.
                  </Note>
                </div>
              </section>

              <Show when={error()}>
                {(message) => <Failure message={message()} />}
              </Show>
            </Show>

            <Show when={result()}>
              {(installed) => (
                <section class="flex flex-col gap-3">
                  <div class="flex items-center gap-2">
                    <Show
                      when={installed().application === "applied"}
                      fallback={<Chip tone="warn">{installed().application === "pending" ? "Pending build" : "Failed"}</Chip>}
                    >
                      <Chip tone="ok">Applied</Chip>
                    </Show>
                    <span class="text-[13px] text-fg">{installed().package}</span>
                  </div>
                  <Show when={installed().application === "pending"}>
                    <Note>
                      Recorded as a pending package. It builds on the next update; track that under Settings › System.
                    </Note>
                  </Show>
                  <Show when={installed().rows.length > 0}>
                    <div class="overflow-hidden rounded-[4px] border border-line">
                      <For each={installed().rows}>
                        {(row) => (
                          <div class="flex items-center gap-2 border-b border-line px-3 py-2 last:border-0">
                            <code class="font-mono text-[12px] text-fg">{row.id}</code>
                            <span class="min-w-0 flex-1 truncate text-[11.5px] text-bad">{row.error ?? ""}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              )}
            </Show>
          </div>
        </div>

        <footer class="flex items-center gap-2 border-t border-line px-5 py-3">
          <span class="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <Glyph name="lock" size={12} />
            You can close this while it runs
          </span>
          <span class="ml-auto" />
          <Button label={result() === undefined ? "Cancel" : "Close"} variant="ghost" onClick={props.onClose} />
          <Show when={result() === undefined}>
            <Button
              label={busy() ? "Installing" : "Install"}
              icon="arrow-right"
              variant="primary"
              disabled={busy()}
              onClick={() => void install()}
            />
          </Show>
        </footer>
      </section>
    </div>
  )
}

function Step(props: { n: string; label: string; state: "active" | "pending" | "done" }): JSX.Element {
  return (
    <span
      class="flex flex-1 items-center gap-1.5 border-b-2 py-2.5 text-[12px]"
      classList={{
        "border-fg text-fg": props.state === "active",
        "border-transparent text-fg-2": props.state === "done",
        "border-transparent text-fg-4": props.state === "pending",
      }}
    >
      <span
        class="inline-flex h-4 w-4 items-center justify-center rounded-[2px] border font-mono text-[10.5px]"
        classList={{
          "border-fg bg-fg text-page": props.state === "done",
          "border-line-inner": props.state !== "done",
        }}
      >
        {props.state === "done" ? <Glyph name="check" size={10} /> : props.n}
      </span>
      {props.label}
    </span>
  )
}

function Line(props: { text: string; detail: string }): JSX.Element {
  return (
    <div class="flex items-center gap-2 font-mono text-[11.5px] leading-[1.8]">
      <span class="w-3 text-fg-4">›</span>
      <span class="text-fg-2">{props.text}</span>
      <span class="min-w-0 flex-1 truncate text-fg-3">{props.detail}</span>
    </div>
  )
}
