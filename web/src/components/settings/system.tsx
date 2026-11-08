import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { bytes, count } from "../../lib/format.ts"
import {
  errorMessage,
  systemLogs,
  systemMetrics,
  systemRestart,
  systemUpdate,
  systemVersion,
  type SystemMetrics,
  type SystemVersion,
} from "../../state/settings.ts"
import { Button, Chip, Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

/** Elapsed time since the home woke: minutes and seconds under an hour, hours above it. */
function uptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours === 0 ? `${minutes}m ${seconds}s` : `${hours}h ${minutes}m`
}

type ServiceFigure = { readonly label: string; readonly figure: string; readonly tone: "ok" | "warn" | "unknown" }

export function System(): JSX.Element {
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [note, setNote] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void systemVersion.reload()
    void systemMetrics.reload()
  })

  /** Writes a plain text file the browser saves; an empty ring still makes a file that says so. */
  const downloadLogs = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const entries = await systemLogs()
      const body = entries
        .map((entry) => `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${entry.text}`)
        .join("\n")
      const blob = new Blob([body === "" ? "No warnings or errors were logged since this home woke.\n" : `${body}\n`], {
        type: "text/plain",
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `xin-logs-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.txt`
      link.click()
      URL.revokeObjectURL(url)
      setNote(entries.length === 0 ? "Nothing was logged." : `${count(entries.length, "line")} downloaded.`)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const value = (): SystemVersion | undefined => {
    const state = systemVersion.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const metrics = (): SystemMetrics | undefined => {
    const state = systemMetrics.state()
    return state.kind === "ready" ? state.value : undefined
  }

  /** Every figure comes from the home; a figure it has not answered yet reads as a dash, never as a zero. */
  const figures = (): readonly ServiceFigure[] => {
    const live = metrics()
    if (live === undefined) {
      return [
        { label: "Plugin rows", figure: "—", tone: "unknown" },
        { label: "Storage", figure: "—", tone: "unknown" },
        { label: "Sockets", figure: "—", tone: "unknown" },
        { label: "Push", figure: "—", tone: "unknown" },
        { label: "Uptime", figure: "—", tone: "unknown" },
      ]
    }
    return [
      {
        label: "Plugin rows",
        figure: `${live.rows.active} active of ${live.rows.total}`,
        tone: live.rows.active === live.rows.total ? "ok" : "warn",
      },
      { label: "Storage", figure: `${bytes(live.storageBytes)} used`, tone: "ok" },
      { label: "Sockets", figure: `${live.sockets} connected`, tone: "ok" },
      { label: "Push", figure: count(live.pushDevices, "device"), tone: "ok" },
      { label: "Uptime", figure: `${uptime(live.uptimeMs)} since this home woke`, tone: "ok" },
    ]
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

  const counts = (): { readonly failed: readonly string[]; readonly missing: readonly string[] } => {
    const rows = value()?.rows ?? []
    return {
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
          <div class="flex items-center gap-2 rounded-[8px] border border-line bg-raised px-3.5 py-2.5 text-[13px] text-fg-2">
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
              <div class="flex items-start gap-2.5 rounded-[12px] border border-warn/30 bg-warn-bg px-3 py-2.5">
                <Glyph name="warning" size={14} class="mt-0.5 shrink-0 text-warn" />
                <div>
                  <span class="block text-[13.5px] font-medium text-warn">Degraded</span>
                  <p class="mt-0.5 text-[11.5px] text-fg-2">
                    {counts().failed.length + counts().missing.length} plugin rows are not running. Threads that need them will
                    say so; nothing is lost.
                  </p>
                </div>
              </div>
            </Show>

            <Group title="Update">
              <div class="my-3 rounded-[8px] border border-line bg-raised p-3">
                <div class="flex items-center gap-2">
                  <span class="text-[13.5px] font-medium text-fg">Build packages</span>
                  <span class="font-mono text-[11px] text-fg-4">{version().build}</span>
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

            <Group title="Services" detail="Read from this home">
              <Show when={systemMetrics.state().kind === "loading"}>
                <Pending label="Reading this home" />
              </Show>
              <Show when={failureOf(systemMetrics.state())}>
                {(message) => <Failure message={message()} onRetry={() => void systemMetrics.reload()} />}
              </Show>
              <div class="divide-y divide-line">
                <For each={figures()}>
                  {(service) => (
                    <div class="-mx-2 flex items-center gap-2.5 rounded-[8px] px-2 py-2 text-[13.5px] transition-colors hover:bg-hover">
                      <span
                        class="h-1.5 w-1.5 rounded-[4px]"
                        classList={{
                          "bg-ok": service.tone === "ok",
                          "bg-warn": service.tone === "warn",
                          "bg-fg-4": service.tone === "unknown",
                        }}
                      />
                      <span class="min-w-0 flex-1 text-fg">{service.label}</span>
                      <span class="font-mono text-[11.5px] text-fg-3 tabular-nums">{service.figure}</span>
                    </div>
                  )}
                </For>
              </div>
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
              <div class="flex items-center gap-2 pb-3 pt-1">
                <Button size="sm" variant="quiet" onClick={() => void systemMetrics.reload()}>
                  <Glyph name="refresh" size={14} />
                  Refresh
                </Button>
              </div>
            </Group>

            <Group title="Version">
              <div>
                <div class="flex items-center gap-2 border-b border-line py-2 text-[13.5px]">
                  <span class="text-fg-3">Running</span>
                  <span class="ml-auto font-mono text-[11.5px] text-fg-2">{version().build}</span>
                </div>
                <div class="flex items-center gap-2 py-2 text-[13.5px]">
                  <span class="text-fg-3">Bundles</span>
                  <span class="ml-auto min-w-0 text-right font-mono text-[11.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
                    {version().bundles.length === 0 ? "none" : version().bundles.join(", ")}
                  </span>
                </div>
              </div>
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
                    <span class="text-[12.5px] text-fg-2">Restart takes about 20 s. Running threads resume from their last step.</span>
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
              <div class="py-3">
                <div class="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="quiet" disabled={busy()} onClick={() => void downloadLogs()}>
                    <Glyph name="download" size={14} />
                    {busy() ? "Reading logs" : "Download logs"}
                  </Button>
                  <span class="text-[11.5px] text-fg-3">
                    Every warning and error this home logged since it woke, newest last.
                  </span>
                  <Show when={note()}>
                    {(message) => <span class="text-[11.5px] text-fg-3">{message()}</span>}
                  </Show>
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
