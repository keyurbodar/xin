import { createResource, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { setToken, token } from "../../lib/auth.ts"
import { ago, count } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { errorMessage } from "../../state/extensions.ts"
import { closeSessions, owner, ownerName, sessions, type Session } from "../../state/settings.ts"
import { Markdown } from "../chat/markdown.tsx"
import { Button, Chip, Failure, MissingOp, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

/** A socket's only identity is the origin its browser sent; the scheme is noise in a row. */
function originLabel(origin: string): string {
  const stripped = origin.replace(/^https?:\/\//u, "").replace(/\/$/u, "")
  return stripped === "" ? "No origin sent" : stripped
}

/** True when this tab's page origin is the one the socket reported. */
function isThisBrowser(session: Session): boolean {
  if (session.origin === "") return false
  return session.origin.replace(/\/$/u, "") === window.location.origin
}

export function Profile(): JSX.Element {
  const [profile, { refetch }] = createResource(() => cmd<{ readonly profile_md: string }>("memory.profile", {}))
  const written = (): string => (profile.latest?.profile_md ?? "").trim()
  const [replacing, setReplacing] = createSignal(false)
  const signedIn = (): boolean => token() !== ""

  const [confirming, setConfirming] = createSignal(false)
  const [closing, setClosing] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [note, setNote] = createSignal<string | undefined>(undefined)

  onMount(() => {
    void owner.reload()
    void sessions.reload()
  })

  const replace = (): void => {
    setToken("")
    window.location.reload()
  }

  /** The first letter of a stored name. No name means no letter, so the row shows a glyph instead. */
  const initial = (): string | undefined => {
    const state = owner.state()
    if (state.kind !== "ready") return undefined
    const letters = [...state.value.name.trim()]
    return letters.length === 0 ? undefined : letters[0]?.toUpperCase()
  }

  const list = (): readonly Session[] => {
    const state = sessions.state()
    return state.kind === "ready" ? state.value : []
  }

  /** Several tabs on one origin look identical, so only a lone match may claim to be this browser. */
  const marked = (session: Session): boolean => isThisBrowser(session) && list().filter(isThisBrowser).length === 1

  const signOut = async (id: string): Promise<void> => {
    setClosing(id)
    setError(undefined)
    setNote(undefined)
    try {
      await closeSessions(id)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setClosing(undefined)
    }
  }

  const signOutAll = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const closed = await closeSessions()
      setNote(closed === 0 ? "No socket was open." : `${count(closed, "socket")} closed.`)
      setConfirming(false)
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex max-w-[820px] flex-col gap-6">
      <div class="flex items-center gap-3.5">
        <span class="grid h-11 w-11 place-items-center rounded-full bg-line-inner text-[16px] text-fg-2">
          <Show when={initial()} fallback={<Glyph name="user" size={18} class="text-fg-3" />}>
            {(letter) => <span>{letter()}</span>}
          </Show>
        </span>
        <div class="min-w-0">
          <span class="block text-[15px] text-fg">{ownerName()}</span>
          <span class="block text-[12px] text-fg-3">Owner · local home</span>
        </div>
        <div class="ml-auto">
          <Button size="sm" variant="quiet" onClick={() => navigate("/settings/general")}>
            <Glyph name="pencil" size={13} />
            Edit
          </Button>
        </div>
      </div>

      <Show when={error()}>
        {(message) => <Failure message={message()} />}
      </Show>

      <Group title="What Xin knows about you" detail="Written by the dreamer from your conversations">
        <Show when={profile.error}>
          {(failure) => <Failure message={errorMessage(failure())} onRetry={() => void refetch()} />}
        </Show>
        <Show
          when={written() !== ""}
          fallback={
            <Panel>
              <p class="px-3.5 py-3 text-[12.5px] text-fg-3">
                Nothing yet. The dreamer writes durable facts about you here once a conversation has given it something to
                keep.
              </p>
            </Panel>
          }
        >
          <Panel>
            <div class="px-3.5 py-3">
              <Markdown small text={written()} />
            </div>
          </Panel>
        </Show>
        <div class="pt-2">
          <MissingOp op="owner.profile.write" detail="The profile is derived, not typed: no field here edits it." />
        </div>
      </Group>

      <Group title="Owner token">
        <Row title="Owner token" detail="Signs you in on a new device; anyone with it has full access">
          <div class="flex flex-col gap-2.5">
            <div class="flex h-9 items-center gap-2.5 rounded-[2px] border border-line bg-page px-3">
              <Glyph name="key" size={14} class="text-fg-3" />
              <Show
                when={signedIn()}
                fallback={<span class="font-mono text-[12.5px] text-fg-3">No token in this browser</span>}
              >
                <span class="font-mono text-[12.5px] tracking-[0.08em] text-fg">own_••••••••••••••••••••</span>
                <Chip tone="ok" class="ml-auto">
                  Set
                </Chip>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Show
                when={replacing()}
                fallback={
                  <Button size="sm" onClick={() => setReplacing(true)}>
                    <Glyph name="rotate-ccw" size={14} />
                    Replace token
                  </Button>
                }
              >
                <span class="text-[12px] text-fg-2">This signs you out and reloads the sign-in screen.</span>
                <Button size="sm" variant="quiet" onClick={() => setReplacing(false)}>Keep</Button>
                <Button size="sm" variant="primary" onClick={replace}>Sign out and replace</Button>
              </Show>
            </div>
            <Note>
              The token is never rendered here. The stored copy stays in this browser; replacing it goes through the sign-in
              flow, which verifies the new token before saving it.
            </Note>
          </div>
        </Row>
      </Group>

      <Group title="Signed in" detail="Live sockets on this home">
        <Show when={sessions.state().kind === "loading"}>
          <Pending label="Reading sessions" />
        </Show>
        <Show when={failureOf(sessions.state())}>
          {(message) => <Failure message={message()} onRetry={() => void sessions.reload()} />}
        </Show>
        <Show when={sessions.state().kind === "ready"}>
          <Panel>
            <Show
              when={list().length > 0}
              fallback={<p class="px-3.5 py-3 text-[12.5px] text-fg-3">No other session is connected.</p>}
            >
              <For each={list()}>
                {(session) => (
                  <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 last:border-0">
                    <Glyph name="monitor" size={14} class="text-fg-3" />
                    <div class="min-w-0 flex-1">
                      <span class="block truncate text-[12.5px] text-fg">{originLabel(session.origin)}</span>
                      <span class="block text-[11.5px] text-fg-3">
                        {session.since === 0 ? "connected before a restart" : `connected ${ago(session.since)}`}
                      </span>
                    </div>
                    <Show when={marked(session)}>
                      <Chip tone="ok">This browser</Chip>
                    </Show>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={closing() === session.id}
                      onClick={() => void signOut(session.id)}
                    >
                      {closing() === session.id ? "Signing out" : "Sign out"}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </Panel>
        </Show>
      </Group>

      <Group title="Danger">
        <Row title="Sign out everywhere" detail="Closes every live socket; the owner token still works">
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={confirming()}
              fallback={
                <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                  <Glyph name="rotate-ccw" size={14} />
                  Sign out everywhere
                </Button>
              }
            >
              <span class="text-[12px] text-fg-2">Every connected browser drops its socket and reconnects on its own.</span>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy()}
                onClick={() => void signOutAll()}
              >
                {busy() ? "Closing" : "Sign out everywhere"}
              </Button>
            </Show>
            <Show when={note()}>
              {(message) => <span class="text-[11.5px] text-fg-3">{message()}</span>}
            </Show>
          </div>
        </Row>
        <Note>
          Closing a session drops its live socket. The owner token is the whole identity, so rotate it in the deployment to
          revoke it.
        </Note>
      </Group>
    </div>
  )
}
