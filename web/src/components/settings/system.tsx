import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { errorMessage, systemRestart, systemUpdate, systemVersion, type SystemVersion } from "../../state/settings.ts"
import { Button, Chip, Failure, MissingOp, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

export function System(): JSX.Element {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [note, setNote] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void systemVersion.reload()
  })

  const value = (): SystemVersion | undefined => {
    const state = systemVersion.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const restart = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await systemRestart(false)
      setNote("Restarting. This page reconnects on its own.")
      setConfirming(false)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const update = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const outcome = await systemUpdate()
      setNote(
        outcome.application === "deploying"
          ? "Deploying. Threads keep running; the new build takes over on its own."
          : `Update did not start: ${outcome.detail}`,
      )
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const counts = (): { readonly active: number; readonly failed: readonly string[]; readonly missing: readonly string[] } => {
    const rows = value()?.rows ?? []
    return {
      active: rows.filter((row) => row.state === "active").length,
      failed: rows.filter((row) => row.state === "failed").map((row) => row.id),
      missing: rows.filter((row) => row.state === "missing").map((row) => row.id),
    }
  }

  return (
    <div class="flex max-w-[820px] flex-col gap-6">
      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>
      <Show when={note()}>
        {(message) => (
          <div class="flex items-center gap-2 rounded-[4px] border border-line-inner bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-2">
            <Glyph name="info" size={13} class="text-fg-3" />
            {message()}
          </div>
        )}
      </Show>

      <Show when={systemVersion.state().kind === "loading"}>
        <Pending label="Reading the build" />
      </Show>
      <Show when={failureOf(systemVersion.state())}>
        {(message) => <Failure message={message()} onRetry={() => void systemVersion.reload()} />}
      </Show>

      <Show when={value()}>
        {(version) => (
          <>
            <Show when={version().degraded}>
              <div class="flex items-start gap-2.5 rounded-[4px] border border-warn/30 bg-warn-bg px-3 py-2.5">
                <Glyph name="warning" size={14} class="mt-0.5 shrink-0 text-warn" />
                <div>
                  <span class="block text-[12.5px] text-warn">Degraded</span>
                  <p class="mt-0.5 text-[11.5px] text-fg-2">
                    {counts().failed.length + counts().missing.length} plugin rows are not running. Threads that need them will
                    say so; nothing is lost.
                  </p>
                </div>
              </div>
            </Show>

            <Group title="Update">
              <div class="rounded-[4px] border border-line-inner bg-hover p-3">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium text-fg">Build packages</span>
                  <span class="font-mono text-[12px] text-fg-3">{version().build}</span>
                  <span class="ml-auto" />
                  <Button size="sm" onClick={() => void update()}>
                    <Glyph name="refresh" size={14} />
                    {busy() ? "Working" : "Update now"}
                  </Button>
                </div>
                <p class="mt-2 text-[11.5px] leading-relaxed text-fg-3">
                  Hands the pending packages to the deployer. Threads keep running; a restart takes about 20 s.
                </p>
              </div>
            </Group>

            <Group title="Services">
              <Panel>
                <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
                  <span class="h-1.5 w-1.5 rounded-[1px]" classList={{ "bg-ok": !version().degraded, "bg-warn": version().degraded }} />
                  <span class="min-w-0 flex-1 text-fg">Plugin rows</span>
                  <span class="font-mono text-[11.5px] text-fg-3">
                    {counts().active} active of {version().rows.length}
                  </span>
                </div>
                <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
                  <span class="h-1.5 w-1.5 rounded-[1px] bg-ok" />
                  <span class="min-w-0 flex-1 text-fg">Bundles</span>
                  <span class="font-mono text-[11.5px] text-fg-3">{version().bundles.length}</span>
                </div>
                <div class="flex items-center gap-2.5 px-3.5 py-2 text-[12.5px]">
                  <span class="h-1.5 w-1.5 rounded-[1px]" classList={{ "bg-ok": !version().degraded, "bg-bad": version().degraded }} />
                  <span class="min-w-0 flex-1 text-fg">Runtime</span>
                  <span class="font-mono text-[11.5px] text-fg-3">{version().degraded ? "degraded" : "up"}</span>
                </div>
              </Panel>
              <Show when={counts().failed.length + counts().missing.length > 0}>
                <div class="flex flex-col gap-1 pt-1">
                  <For each={[...counts().failed, ...counts().missing]}>
                    {(id) => (
                      <div class="flex items-center gap-2">
                        <Chip tone="bad">Not running</Chip>
                        <span class="font-mono text-[11.5px] text-fg-2">{id}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <div class="pt-2">
                <MissingOp op="system.metrics" detail="Uptime, memory and push delivery are not exposed as figures." />
              </div>
            </Group>

            <Group title="Version">
              <Panel>
                <div class="flex items-center gap-2 border-b border-line px-3.5 py-2 text-[12.5px] last:border-0">
                  <span class="text-fg-3">Running</span>
                  <span class="ml-auto font-mono text-[11.5px] text-fg-2">{version().build}</span>
                </div>
                <div class="flex items-center gap-2 px-3.5 py-2 text-[12.5px]">
                  <span class="text-fg-3">Bundles</span>
                  <span class="ml-auto min-w-0 truncate font-mono text-[11.5px] text-fg-2">
                    {version().bundles.length === 0 ? "none" : version().bundles.join(", ")}
                  </span>
                </div>
              </Panel>
            </Group>

            <Group title="Restart">
              <Row title="Restart now" detail="Threads keep running while the client reconnects">
                <div class="flex flex-wrap items-center gap-2">
                  <Show
                    when={confirming()}
                    fallback={
                      <Button size="sm" onClick={() => setConfirming(true)}>
                        <Glyph name="refresh" size={14} />
                        Restart now
                      </Button>
                    }
                  >
                    <span class="text-[12px] text-fg-2">Restart takes about 20 s. Running threads resume from their last step.</span>
                    <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy()}
                      onClick={() => void restart()}
                    >
                      {busy() ? "Restarting" : "Restart"}
                    </Button>
                  </Show>
                </div>
              </Row>
              <div class="pt-1">
                <div class="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled
                  >
                    <Glyph name="download" size={14} />
                    Download logs
                  </Button>
                  <MissingOp op="system.logs" />
                </div>
              </div>
            </Group>

            <Note>
              The word "degraded" comes from the row states in the build, not from a colour alone. Restart is the only primary
              action on this pane.
            </Note>
          </>
        )}
      </Show>
    </div>
  )
}
