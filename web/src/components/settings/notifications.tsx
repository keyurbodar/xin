import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { currentEndpoint, disablePush, enablePush, type PushChange } from "../../lib/push.ts"
import { Button, Chip, Failure, MissingOp, Note, Panel, Toggle } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

const EVENTS: readonly { readonly title: string; readonly detail: string; readonly on: boolean }[] = [
  { title: "A thread is waiting on you", detail: "The choices show as buttons", on: true },
  { title: "A report lands", detail: "Only for threads you started", on: true },
  { title: "Something fails", detail: "With what broke and Retry", on: true },
  { title: "A schedule runs", detail: "Off: results still land in chat", on: false },
  { title: "Spend passes the alert", detail: "Needs a spend alert setting", on: true },
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

  onMount(() => {
    void currentEndpoint().then((found) => setEndpoint(found))
  })

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
            <Button size="sm" variant="quiet" disabled>Send test</Button>
            <MissingOp op="push.test" />
          </div>
        </Row>
      </Group>

      <Group title="Tell me when">
        <For each={EVENTS}>
          {(event) => (
            <Row title={event.title} detail={event.detail}>
              <Toggle on={event.on} disabled label={event.title} onChange={() => undefined} />
            </Row>
          )}
        </For>
        <div class="pt-2">
          <Note>Which events push is decided by the backend's notifier. This build exposes no preference rows to change it.</Note>
          <div class="mt-1.5">
            <MissingOp op="push.prefs" detail="Only push.subscribe and push.unsubscribe exist today." />
          </div>
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
