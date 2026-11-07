import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { currentEndpoint, disablePush, enablePush, type PushChange } from "../../lib/push.ts"
import { notifyNow, notifyPrefs, pushTest, setNotifyPrefs, type NotifyKind } from "../../state/settings.ts"
import { Button, Chip, Failure, MissingOp, Note, Panel, Toggle } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

const EVENTS: readonly { readonly key: NotifyKind; readonly title: string; readonly detail: string }[] = [
  { key: "waiting", title: "A thread is waiting on you", detail: "The choices show as buttons" },
  { key: "finished", title: "A report lands", detail: "Only for threads you started" },
  { key: "failed", title: "Something fails", detail: "With what broke and Retry" },
]

function permissionNow(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

export function Notifications(): JSX.Element {
  const [permission, setPermission] = createSignal(permissionNow())
  const [endpoint, setEndpoint] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [sent, setSent] = createSignal(false)

  const [saving, setSaving] = createSignal<NotifyKind | undefined>(undefined)
  const [tested, setTested] = createSignal<string | undefined>(undefined)

  const sendTest = async (): Promise<void> => {
    setTested(undefined)
    setError(undefined)
    try {
      const sent = await pushTest()
      setTested(sent === 0 ? "No subscribed browser answered. Turn push on here first." : `Sent to ${sent} browser${sent === 1 ? "" : "s"}.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The test notification was not sent.")
    }
  }

  onMount(() => {
    void currentEndpoint().then((found) => setEndpoint(found))
    void notifyPrefs.reload()
  })

  const change = async (kind: NotifyKind, next: boolean): Promise<void> => {
    setSaving(kind)
    setError(undefined)
    try {
      await setNotifyPrefs({ [kind]: next })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The preference was not saved.")
    } finally {
      setSaving(undefined)
    }
  }

  const apply = (change: PushChange): void => {
    switch (change.kind) {
      case "subscribed":
        setEndpoint(change.endpoint)
        setSent(true)
        return
      case "unsubscribed":
        setEndpoint(undefined)
        setSent(false)
        return
      case "failed":
        setError(change.message)
        return
    }
  }

  const turnOn = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      apply(await enablePush())
      setPermission(permissionNow())
    } finally {
      setBusy(false)
    }
  }

  const turnOff = async (): Promise<void> => {
    const current = endpoint()
    if (current === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      apply(await disablePush(current))
      setPermission(permissionNow())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex max-w-[820px] flex-col gap-6">
      <Show when={error()}>
        {(message) => <Failure message={message()} onRetry={() => void turnOn()} />}
      </Show>

      <Group title="Push to this browser">
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
              <span class="font-mono text-[10.5px] text-fg-4">{endpoint()?.replace(/^https:\/\//u, "").slice(0, 42)}…</span>
              <Button size="sm" variant="quiet" disabled={busy()} onClick={() => void turnOff()}>Turn off</Button>
            </Show>
            <Show when={sent()}>
              <span class="text-[11.5px] text-fg-3">Delivery is confirmed when a push watcher runs.</span>
            </Show>
          </div>
        </Row>
        <Row title="Send test" detail="Delivers one notification to every subscribed browser">
          <div class="flex items-center gap-2">
            <Show when={tested()}>
              {(result) => <span class="text-[12px] text-fg-3">{result()}</span>}
            </Show>
            <Button size="sm" variant="quiet" disabled={busy()} onClick={() => void sendTest()}>
              Send test
            </Button>
          </div>
        </Row>
      </Group>

      <Group title="Tell me when">
        <For each={EVENTS}>
          {(event) => (
            <Row title={event.title} detail={event.detail}>
              <Toggle
                on={notifyNow()[event.key]}
                disabled={saving() !== undefined}
                label={event.title}
                onChange={(next) => void change(event.key, next)}
              />
            </Row>
          )}
        </For>
        <Row title="A schedule runs" detail="Results still land in chat">
          <MissingOp op="schedule.notify" detail="A schedule's run notifies only when it opens a thread." />
        </Row>
        <Row title="Spend passes the alert" detail="Needs a spend alert setting">
          <span class="text-[12.5px] text-fg-3">Not in this build</span>
        </Row>
        <div class="pt-2">
          <Note>Push is skipped while this tab is open: the socket already shows the change.</Note>
        </div>
      </Group>

      <Group title="Quiet hours">
        <Row title="Quiet hours" detail="Waiting-on-you still comes through after two hours paused">
          <div class="flex items-center gap-2">
            <Glyph name="clock" size={13} class="text-fg-3" />
            <span class="font-mono text-[12px] text-fg-3">Not configured</span>
          </div>
        </Row>
        <div class="pt-2">
          <MissingOp op="push.quiet-hours" />
        </div>
      </Group>

      <Group title="Other devices">
        <Panel>
          <Show
            when={endpoint() !== undefined}
            fallback={<div class="px-3.5 py-3 text-[12.5px] text-fg-3">No subscription from this browser yet.</div>}
          >
            <div class="flex items-center gap-2.5 px-3.5 py-2.5">
              <Glyph name="monitor" size={14} class="text-fg-3" />
              <span class="min-w-0 flex-1 text-[12.5px] text-fg">This browser</span>
              <Chip tone="ok">Subscribed</Chip>
            </div>
          </Show>
        </Panel>
        <div class="pt-2">
          <MissingOp op="push.list" detail="Subscriptions are stored by endpoint; nothing lists them back." />
        </div>
      </Group>
    </div>
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
