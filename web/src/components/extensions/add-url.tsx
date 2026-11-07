import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { errorMessage, installSpec, packages } from "../../state/extensions.ts"
import { Button, Failure, MONO_INPUT, Note } from "./chrome.tsx"
import { Glyph } from "./glyph.tsx"

const SPEC = /^(?:github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9._+/-]+)?|(?:git\+)?https:\/\/\S+|(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9.^~><=*xX|-]+)?)$/u

export function AddUrl(props: { onClose: () => void }): JSX.Element {
  const [spec, setSpec] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [added, setAdded] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void packages.reload()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const valid = (): boolean => SPEC.test(spec().trim())

  const submit = async (): Promise<void> => {
    if (!valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await installSpec(spec().trim())
      setAdded(spec().trim())
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const pending = (): readonly string[] => {
    const state = packages.state()
    return state.kind === "ready" ? state.value.pending.add : []
  }

  return (
    <div class="fixed inset-0 z-50 grid place-items-center p-6">
      <button type="button" aria-label="Close add from URL" onClick={props.onClose} class="absolute inset-0 bg-black/65" />
      <section class="enter-sheet relative flex w-full max-w-[520px] flex-col rounded-[4px] border border-line-inner bg-raised shadow-2xl">
        <header class="flex items-center border-b border-line px-4 py-3.5">
          <span class="text-[15px] font-medium text-fg">Add from URL</span>
          <button type="button" onClick={props.onClose} aria-label="Close" class="ml-auto text-fg-3 hover:text-fg">
            <Glyph name="x" size={16} />
          </button>
        </header>

        <div class="flex flex-col gap-3.5 px-4 py-4">
          <div class="flex h-[34px] items-center gap-2 rounded-[2px] border border-line-inner bg-page px-2.5">
            <Glyph name="git-branch" size={14} class="text-fg-3" />
            <input
              value={spec()}
              onInput={(event) => setSpec(event.currentTarget.value)}
              placeholder="github.com/owner/plugin#main or npm-name@1.2.0"
              spellcheck={false}
              aria-label="Package spec"
              class="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-fg placeholder:text-fg-4 focus:outline-none"
            />
          </div>
          <Show when={spec().trim() !== "" && !valid()}>
            <span class="text-[11.5px] text-bad">
              Use github:owner/repo, an https git URL, or a package name with an optional version.
            </span>
          </Show>

          <div class="flex items-start gap-2.5 rounded-[4px] border border-warn/30 bg-warn-bg px-3 py-2.5">
            <Glyph name="warning" size={14} class="mt-0.5 shrink-0 text-warn" />
            <div>
              <span class="block text-[12.5px] text-warn">Not from an index</span>
              <p class="mt-0.5 text-[11.5px] leading-snug text-fg-2">
                The package is recorded as pending and builds on the next update. Its rows stay off until you enable them in
                Installed.
              </p>
            </div>
          </div>

          <Show when={added()}>
            {(name) => (
              <div class="flex items-start gap-2 rounded-[4px] border border-ok/30 bg-ok-bg px-3 py-2.5">
                <Glyph name="check" size={13} class="mt-0.5 shrink-0 text-ok" />
                <div>
                  <span class="block font-mono text-[11.5px] text-fg">{name()}</span>
                  <span class="block text-[11.5px] text-fg-3">Recorded. It appears after the next update.</span>
                </div>
              </div>
            )}
          </Show>

          <Show when={pending().length > 0}>
            <div>
              <span class="label mb-1.5 block">Pending packages</span>
              <div class="overflow-hidden rounded-[4px] border border-line">
                <For each={pending()}>
                  {(entry) => (
                    <div class="border-b border-line px-3 py-2 font-mono text-[11.5px] text-fg-2 last:border-0">{entry}</div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            {(message) => <Failure message={message()} />}
          </Show>

          <Note>
            Adding records the spec only. Review the rows it mounts in Installed, then enable what you want; updates can be
            pressed later under Settings › System.
          </Note>
        </div>

        <footer class="flex items-center gap-2 border-t border-line px-4 py-3">
          <span class="text-[11.5px] text-fg-3">Builds keep going if you close this</span>
          <span class="ml-auto" />
          <Button label="Close" variant="ghost" onClick={props.onClose} />
          <Button
            label={busy() ? "Recording" : added() === undefined ? "Add package" : "Add another"}
            variant="primary"
            disabled={busy() || !valid()}
            onClick={() => {
              setAdded(undefined)
              void submit()
            }}
          />
        </footer>
      </section>
    </div>
  )
}
