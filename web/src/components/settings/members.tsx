import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import { ago, originLabel } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { sessionId } from "../../state/connection.ts"
import { errorMessage } from "../../state/extensions.ts"
import { closeSessions, owner, ownerName, sessions, type Session } from "../../state/settings.ts"
import { Button, Chip, Failure, Note, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Card, Group } from "./parts.tsx"

export function Members(): JSX.Element {
  const [closing, setClosing] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void owner.reload()
    void sessions.reload()
  })

  const initial = (): string | undefined => {
    const state = owner.state()
    if (state.kind !== "ready") return undefined
    return [...state.value.name.trim()][0]?.toUpperCase()
  }

  const list = (): readonly Session[] => {
    const state = sessions.state()
    return state.kind === "ready" ? state.value.toSorted((left, right) => right.since - left.since) : []
  }

  /** This tab's socket is the one the home greeted by id, so the row is exact even with several tabs open. */
  const mine = (session: Session): boolean => session.id === sessionId()

  const disconnect = async (id: string): Promise<void> => {
    setClosing(id)
    setError(undefined)
    try {
      await closeSessions(id)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setClosing(undefined)
    }
  }

  return (
    <>
      <Group title="Owner" detail="One per home">
        <Card>
        <div class="flex items-center gap-3 px-4 py-3">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-body font-title text-ink">
            <Show when={initial()} fallback={<Glyph name="user" size={16} class="text-ink-3" />}>
              {(letter) => letter()}
            </Show>
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-small font-title text-ink">{ownerName()}</span>
              <Chip>You</Chip>
            </div>
            <span class="mt-0.5 block text-mini text-ink-3">Owner · full access through the owner token</span>
          </div>
          <Button size="sm" variant="quiet" class="im-press" onClick={() => navigate("/settings/general")}>
            Edit name
          </Button>
        </div>
        </Card>
        <Note>
          Ingle has no invites or roles: anyone holding the owner token acts as you. So the devices signed in with it are
          the other members of this home, and they are listed below.
        </Note>
      </Group>

      <Group title="Signed-in devices" detail="Live connections to this home">
        <Show when={error()}>{(message) => <Failure message={message()} />}</Show>
        <Show when={sessions.state().kind === "loading"}>
          <Pending label="Reading connections" />
        </Show>
        <Show when={failureOf(sessions.state())}>
          {(message) => <Failure message={message()} onRetry={() => void sessions.reload()} />}
        </Show>
        <Show when={sessions.state().kind === "ready"}>
          <Card>
            <Show
              when={list().length > 0}
              fallback={<p class="px-4 py-3 text-small text-ink-3">No device is connected right now.</p>}
            >
              <For each={list()}>
                {(session) => (
                  <div class="flex items-center gap-3 px-4 py-2.5">
                    <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-ink-2 shadow-ring">
                      <Glyph name="monitor" size={14} />
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-small text-ink">{originLabel(session.origin)}</span>
                        <Show when={mine(session)}>
                          <Chip tone="ok">This browser</Chip>
                        </Show>
                      </div>
                      <span class="mt-0.5 block text-mini text-ink-3">
                        {session.since === 0 ? "Connected before the last restart" : `Connected ${ago(session.since)} ago`}
                      </span>
                    </div>
                    <Show when={!mine(session)}>
                      <Button
                        size="sm"
                        variant="quiet"
                        class="im-press"
                        disabled={closing() === session.id}
                        onClick={() => void disconnect(session.id)}
                      >
                        {closing() === session.id ? "Disconnecting" : "Disconnect"}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Card>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="quiet" class="im-press" onClick={() => void sessions.reload()}>
              <Glyph name="refresh" size={14} />
              Refresh
            </Button>
            <Button size="sm" class="im-press" onClick={() => navigate("/settings/profile")}>
              <Glyph name="key" size={14} />
              Rotate the token
            </Button>
          </div>
        </Show>
        <Note>
          Disconnect closes that connection, but a device that still holds the token dials back in. Rotating the token is
          what keeps a device out: every connection closes and only the browser that rotated gets the new one.
        </Note>
      </Group>
    </>
  )
}
