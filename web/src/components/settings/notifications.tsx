import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { originLabel } from "../../lib/format.ts"
import { currentEndpoint, disablePush, enablePush, type PushChange } from "../../lib/push.ts"
import {
  notifyNow,
  notifyPrefs,
  pushDevices,
  pushTest,
  quietHours,
  removePushDevice,
  setNotifyPrefs,
  setQuietHours,
  usage,
  type NotifyKind,
  type PushDevice,
  type QuietHours,
} from "../../state/settings.ts"
import { Button, Chip, Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Card, Group, MONO_FIELD, Row, Switch } from "./parts.tsx"

const EVENTS: readonly { readonly key: NotifyKind; readonly title: string; readonly detail: string }[] = [
  { key: "waiting", title: "A thread is waiting on you", detail: "The choices show as buttons" },
  { key: "finished", title: "A report lands", detail: "Only for threads you started" },
  { key: "failed", title: "Something fails", detail: "With what broke and Retry" },
]

const MINUTES_IN_DAY = 24 * 60

const TIME_FIELD = `${MONO_FIELD.replace("w-full", "w-[68px]")} text-center tabular-nums`

type Problem = { readonly message: string; readonly retry?: (() => void) | undefined }

function permissionNow(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

function wrap(minutes: number): number {
  return ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY
}

/** Minutes since UTC midnight on the browser's wall clock; getTimezoneOffset() runs the other way. */
function toLocal(minutes: number): number {
  return wrap(minutes - new Date().getTimezoneOffset())
}

function toUtc(minutes: number): number {
  return wrap(minutes + new Date().getTimezoneOffset())
}

function clockText(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

function dollars(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
}

function minutesOf(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  if (match === null) return undefined
  const [, hourText, minuteText] = match
  if (hourText === undefined || minuteText === undefined) return undefined
  const hours = Number(hourText)
  const minutes = Number(minuteText)
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** The scheme is noise in a row; the host is what tells one device from another. */
function Saving(props: { show: boolean }): JSX.Element {
  return (
    <Show when={props.show}>
      <span class="text-mini text-ink-3">Saving</span>
    </Show>
  )
}

function DeviceRow(props: {
  device: PushDevice
  thisBrowser: boolean
  busy: boolean
  removing: boolean
  onRemove: () => void
}): JSX.Element {
  return (
    <div class="flex items-center gap-2.5 px-4 py-2.5">
      <Glyph name="monitor" size={16} class="shrink-0 text-ink-3" />
      <span class="min-w-0 flex-1 truncate font-mono text-mini text-ink-2" title={props.device.origin}>
        {originLabel(props.device.origin)}
      </span>
      <Show when={props.thisBrowser}>
        <Chip tone="ok">This browser</Chip>
      </Show>
      <Button size="sm" variant="quiet" disabled={props.busy} onClick={props.onRemove}>
        {props.removing ? "Removing" : "Remove"}
      </Button>
    </div>
  )
}

export function Notifications(): JSX.Element {
  const [permission, setPermission] = createSignal(permissionNow())
  const [endpoint, setEndpoint] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<Problem | undefined>(undefined)
  const [sent, setSent] = createSignal(false)

  const [saving, setSaving] = createSignal<string | undefined>(undefined)
  const [removing, setRemoving] = createSignal<string | undefined>(undefined)
  const [tested, setTested] = createSignal<string | undefined>(undefined)

  const quiet = (): QuietHours | undefined => {
    const state = quietHours.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const devices = (): readonly PushDevice[] | undefined => {
    const state = pushDevices.state()
    return state.kind === "ready" ? state.value : undefined
  }

  const spendDetail = (): string => {
    const state = usage.state()
    if (state.kind === "ready" && state.value.recorded) return `${dollars(state.value.alert)} a day or 80% of the cap`
    return "$8 a day or 80% of the cap"
  }

  const shownTime = (which: "start" | "end"): string => {
    const value = quiet()
    if (value === undefined) return ""
    return clockText(toLocal(which === "start" ? value.start : value.end))
  }

  const fail = (failure: unknown, fallback: string, retry?: () => void): void => {
    const message = failure instanceof Error && failure.message !== "" ? failure.message : fallback
    setProblem(retry === undefined ? { message } : { message, retry })
  }

  const sendTest = async (): Promise<void> => {
    setTested(undefined)
    setProblem(undefined)
    try {
      const delivered = await pushTest()
      setTested(
        delivered === 0
          ? "No subscribed browser answered. Turn push on here first."
          : `Sent to ${delivered} browser${delivered === 1 ? "" : "s"}.`,
      )
    } catch (failure) {
      fail(failure, "The test notification was not sent.", () => void sendTest())
    }
  }

  const change = async (kind: NotifyKind, next: boolean): Promise<void> => {
    setSaving(kind)
    setProblem(undefined)
    try {
      await setNotifyPrefs({ [kind]: next })
    } catch (failure) {
      fail(failure, "The preference was not saved.", () => void change(kind, next))
    } finally {
      setSaving(undefined)
    }
  }

  const saveQuiet = async (patch: Partial<QuietHours>): Promise<void> => {
    setSaving("quiet")
    setProblem(undefined)
    try {
      await setQuietHours(patch)
    } catch (failure) {
      fail(failure, "The quiet hours were not saved.", () => void saveQuiet(patch))
    } finally {
      setSaving(undefined)
    }
  }

  const commitTime = async (which: "start" | "end", field: HTMLInputElement): Promise<void> => {
    const typed = minutesOf(field.value)
    if (typed === undefined) {
      field.value = shownTime(which)
      return
    }
    await saveQuiet(which === "start" ? { start: toUtc(typed) } : { end: toUtc(typed) })
    field.value = shownTime(which)
  }

  const apply = (result: PushChange, retry: () => void): void => {
    switch (result.kind) {
      case "subscribed":
        setEndpoint(result.endpoint)
        setSent(true)
        return
      case "unsubscribed":
        setEndpoint(undefined)
        setSent(false)
        return
      case "failed":
        setProblem({ message: result.message, retry })
        return
    }
  }

  const turnOn = async (): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      const result = await enablePush()
      apply(result, () => void turnOn())
      setPermission(permissionNow())
      if (result.kind === "subscribed") await pushDevices.reload()
    } finally {
      setBusy(false)
    }
  }

  const turnOff = async (): Promise<void> => {
    const current = endpoint()
    if (current === undefined) return
    setBusy(true)
    setProblem(undefined)
    try {
      const result = await disablePush(current)
      apply(result, () => void turnOff())
      setPermission(permissionNow())
      if (result.kind === "unsubscribed") await pushDevices.reload()
    } finally {
      setBusy(false)
    }
  }

  const removeDevice = async (target: string): Promise<void> => {
    setRemoving(target)
    setProblem(undefined)
    try {
      if (target === endpoint()) apply(await disablePush(target), () => void removeDevice(target))
      else await removePushDevice(target)
      setPermission(permissionNow())
      await pushDevices.reload()
    } catch (failure) {
      fail(failure, "The device was not removed.", () => void removeDevice(target))
    } finally {
      setRemoving(undefined)
    }
  }

  onMount(() => {
    void currentEndpoint().then((found) => setEndpoint(found))
    void notifyPrefs.reload()
    void quietHours.reload()
    void pushDevices.reload()
    void usage.reload()
  })

  return (
    <>
      <Show when={problem()}>
        {(failure) => <Failure message={failure().message} onRetry={failure().retry} />}
      </Show>

      <Group title="Push to this browser">
        <Card>
        <Row title="This browser" detail={permissionDetail(permission())}>
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={endpoint() !== undefined}
              fallback={
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy() || permission() === "unsupported"}
                  onClick={() => void turnOn()}
                >
                  <Glyph name="bell" size={14} />
                  {busy() ? "Enabling" : "Enable push"}
                </Button>
              }
            >
              <Chip tone="ok">Subscribed</Chip>
              <span class="font-mono text-micro text-icon">{endpoint()?.replace(/^https:\/\//u, "").slice(0, 42)}…</span>
              <Button size="sm" variant="quiet" disabled={busy()} onClick={() => void turnOff()}>Turn off</Button>
            </Show>
            <Show when={sent()}>
              <span class="text-mini text-ink-3">Delivery is confirmed when a push watcher runs.</span>
            </Show>
          </div>
        </Row>
        <Row title="Send test" detail="Delivers one notification to every subscribed browser">
          <div class="flex items-center gap-2">
            <Show when={tested()}>
              {(result) => <span class="text-small text-ink-3">{result()}</span>}
            </Show>
            <Button size="sm" variant="quiet" disabled={busy()} onClick={() => void sendTest()}>
              Send test
            </Button>
          </div>
        </Row>
        </Card>
      </Group>

      <Group title="Tell me when">
        <Card>
        <For each={EVENTS}>
          {(event) => (
            <Row title={event.title} detail={event.detail}>
              <div class="flex items-center gap-2.5">
                <Switch
                  on={notifyNow()[event.key]}
                  disabled={saving() !== undefined}
                  label={event.title}
                  onChange={(next) => void change(event.key, next)}
                />
                <Saving show={saving() === event.key} />
              </div>
            </Row>
          )}
        </For>
        <Row title="Spend passes the alert" detail={spendDetail()}>
          <div class="flex items-center gap-2.5">
            <Switch
              on={notifyNow()["spend"]}
              disabled={saving() !== undefined}
              label="Spend passes the alert"
              onChange={(next) => void change("spend", next)}
            />
            <Saving show={saving() === "spend"} />
          </div>
        </Row>
        <Row title="A schedule runs" detail="Off: results still land in chat">
          <div class="flex items-center gap-2.5">
            <Switch
              on={notifyNow()["schedule"]}
              disabled={saving() !== undefined}
              label="A schedule runs"
              onChange={(next) => void change("schedule", next)}
            />
            <Saving show={saving() === "schedule"} />
          </div>
        </Row>
        </Card>
          <Note>
            Push is skipped while this tab is open: the socket already shows the change. During quiet hours a report waits
            for the window to end; a question comes through once it has waited two hours.
          </Note>
      </Group>

      <Group title="Quiet hours">
        <Show when={failureOf(quietHours.state())}>
          {(message) => <Failure message={message()} onRetry={() => void quietHours.reload()} />}
        </Show>
        <Card>
        <Row title="Quiet hours" detail="Shown on this browser's clock">
          <Show
            when={quiet()}
            fallback={
              <span class="text-small text-ink-3">
                {quietHours.state().kind === "loading" ? "Reading quiet hours…" : "Not loaded"}
              </span>
            }
          >
            {(value) => (
              <div class="flex items-center gap-2">
                <ui-input class="flex">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  autocomplete="off"
                  spellcheck={false}
                  class={TIME_FIELD}
                  aria-label="Quiet hours start"
                  disabled={saving() === "quiet"}
                  value={shownTime("start")}
                  onChange={(event) => void commitTime("start", event.currentTarget)}
                />
                </ui-input>
                <span class="text-small text-ink-3">to</span>
                <ui-input class="flex">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  autocomplete="off"
                  spellcheck={false}
                  class={TIME_FIELD}
                  aria-label="Quiet hours end"
                  disabled={saving() === "quiet"}
                  value={shownTime("end")}
                  onChange={(event) => void commitTime("end", event.currentTarget)}
                />
                </ui-input>
                <div class="ml-2 flex items-center gap-2">
                  <Saving show={saving() === "quiet"} />
                  <Switch
                    on={value().enabled}
                    disabled={saving() === "quiet"}
                    label="Quiet hours"
                    onChange={(next) => void saveQuiet({ enabled: next })}
                  />
                </div>
              </div>
            )}
          </Show>
        </Row>
        </Card>
        <Note>Waiting-on-you still comes through.</Note>
      </Group>

      <Group title="Other devices">
        <Show when={failureOf(pushDevices.state())}>
          {(message) => <Failure message={message()} onRetry={() => void pushDevices.reload()} />}
        </Show>
        <Show when={pushDevices.state().kind !== "failed"}>
          <Card>
            <Show when={pushDevices.state().kind === "loading"}>
              <Pending label="Reading devices" />
            </Show>
            <Show when={devices()}>
              {(list) => (
                <Show
                  when={list().length > 0}
                  fallback={<div class="px-4 py-3 text-small text-ink-3">No device has a push subscription.</div>}
                >
                  <For each={list()}>
                    {(device) => (
                      <DeviceRow
                        device={device}
                        thisBrowser={device.endpoint === endpoint()}
                        busy={removing() !== undefined}
                        removing={removing() === device.endpoint}
                        onRemove={() => void removeDevice(device.endpoint)}
                      />
                    )}
                  </For>
                </Show>
              )}
            </Show>
          </Card>
        </Show>
      </Group>
    </>
  )
}

function permissionDetail(permission: NotificationPermission | "unsupported"): string {
  switch (permission) {
    case "granted":
      return "Allowed · the browser has not blocked this site"
    case "denied":
      return "Blocked in the browser; change it in site settings"
    case "default":
      return "Not asked yet"
    case "unsupported":
      return "This browser has no notification support"
  }
}
