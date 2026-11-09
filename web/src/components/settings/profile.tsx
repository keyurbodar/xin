import { createResource, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { cmd } from "../../lib/api.ts"
import { setToken, token } from "../../lib/auth.ts"
import { ago } from "../../lib/format.ts"
import { navigate } from "../../lib/router.ts"
import { reauthorize, sessionId } from "../../state/connection.ts"
import { errorMessage } from "../../state/extensions.ts"
import { closeSessions, owner, ownerName, rotateSession, sessions, type Session } from "../../state/settings.ts"
import { Markdown } from "../chat/markdown.tsx"
import { Button, Chip, Failure, Note, Panel, Pending, failureOf } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

/** A socket's only identity is the origin its browser sent; the scheme is noise in a row. */
function originLabel(origin: string): string {
  const stripped = origin.replace(/^https?:\/\//u, "").replace(/\/$/u, "")
  return stripped === "" ? "No origin sent" : stripped
}

/** `own_••••••••Q7x2`: enough of both ends to recognise a token, nothing to reuse. */
function masked(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length)
  return `${value.slice(0, 4)}${"•".repeat(16)}${value.slice(-4)}`
}

export function Profile(): JSX.Element {
  const [profile, { refetch }] = createResource(() => cmd<{ readonly profile_md: string }>("memory.profile", {}))
  const written = (): string => (profile.latest?.profile_md ?? "").trim()
  const signedIn = (): boolean => current() !== ""

  const [confirming, setConfirming] = createSignal(false)
  const [closing, setClosing] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [note, setNote] = createSignal<string | undefined>(undefined)
  const [revealed, setRevealed] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [savingProfile, setSavingProfile] = createSignal(false)
  const [rotating, setRotating] = createSignal(false)
  const [fresh, setFresh] = createSignal<string>()
  const [released, setReleased] = createSignal(false)
  const [current, setCurrent] = createSignal(token())
  const [qr, setQr] = createSignal<string>()

  onMount(() => {
    void owner.reload()
    void sessions.reload()
  })

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

  /** This tab's socket is the one the home greeted by id, so the row is exact even with several tabs open. */
  const marked = (session: Session): boolean => session.id === sessionId()

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

  /** Mints the new token and drops every socket. This browser adopts it unless the owner is leaving. */
  const rotate = async (signOut: boolean): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const next = await rotateSession()
      setFresh(next)
      setRotating(false)
      setConfirming(false)
      setReleased(signOut)
      if (signOut) {
        setNote("Every device is signed out. Copy the new token before this browser goes.")
        return
      }
      setToken(next)
      setCurrent(next)
      reauthorize()
      setNote("This browser is on the new token. Every other device is signed out.")
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  /** Adopts the freshly minted token here, after a rotation that signed this browser out. */
  const adopt = (): void => {
    const next = fresh()
    if (next === undefined) return
    setToken(next)
    reauthorize()
    setFresh(undefined)
    setRevealed(false)
    setNote("Signed in with the new token.")
  }

  const startEditing = (): void => {
    setDraft(written())
    setEditing(true)
    setNote(undefined)
  }

  /** The dreamer's own store is the single source; this replaces it whole, the way it writes. */
  const saveProfile = async (): Promise<void> => {
    setSavingProfile(true)
    setError(undefined)
    setNote(undefined)
    try {
      await cmd("memory.profile.write", { markdown: draft() })
      await refetch()
      setEditing(false)
      setNote(draft().trim() === "" ? "Profile cleared." : "Profile saved.")
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setSavingProfile(false)
    }
  }

  /** Empties the store, which is what clearing the box does on the server side too. */
  const clearProfile = async (): Promise<void> => {
    setDraft("")
    await saveProfile()
  }

  /** The code carries the sign-in link, token included, so the phone lands signed in. */
  const toggleQr = async (): Promise<void> => {
    if (qr() !== undefined) {
      setQr(undefined)
      return
    }
    setError(undefined)
    try {
      const link = `${location.origin}/#/signin?token=${encodeURIComponent(current())}`
      const { toString } = await import("qrcode")
      setQr(
        await toString(link, {
          type: "svg",
          margin: 1,
          width: 168,
          errorCorrectionLevel: "M",
          color: { dark: "#fdfcfb", light: "#00000000" },
        }),
      )
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    }
  }

  const leave = (): void => {
    setToken("")
    window.location.reload()
  }

  const copy = async (value: string): Promise<void> => {
    setError(undefined)
    try {
      await navigator.clipboard.writeText(value)
      setNote("Token copied.")
    } catch {
      setRevealed(true)
      setNote("The browser refused the clipboard; the token is shown in full.")
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
          when={editing()}
          fallback={
            <>
              <Show
                when={written() !== ""}
                fallback={
                  <Panel>
                    <p class="px-3.5 py-3 text-[12.5px] text-fg-3">
                      Nothing yet. The dreamer writes durable facts about you here once a conversation has given it
                      something to keep.
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
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="quiet" onClick={startEditing}>
                  <Glyph name="pencil" size={13} />
                  Edit
                </Button>
                <Show when={note()}>
                  {(message) => <span class="text-[11.5px] text-fg-3">{message()}</span>}
                </Show>
              </div>
              <Note>
                The dreamer writes this after conversations. Editing it replaces what it keeps, so the next pass starts
                from your version.
              </Note>
            </>
          }
        >
          <Panel>
            <textarea
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              maxLength={20_000}
              rows={10}
              spellcheck={false}
              aria-label="Profile markdown"
              class="w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[12px] leading-relaxed text-fg outline-none"
            />
          </Panel>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={savingProfile()} onClick={() => void saveProfile()}>
              {savingProfile() ? "Saving" : "Save profile"}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="quiet" disabled={savingProfile() || written() === ""} onClick={() => void clearProfile()}>
              Clear
            </Button>
            <span class="ml-auto text-[11.5px] text-fg-3">{draft().length} of 20,000</span>
          </div>
        </Show>
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
                <span class="min-w-0 truncate font-mono text-[12.5px] tracking-[0.08em] text-fg">
                  {revealed() ? current() : masked(current())}
                </span>
                <button
                  type="button"
                  class="ml-auto text-fg-3 hover:text-fg-2"
                  aria-label={revealed() ? "Hide token" : "Show token"}
                  onClick={() => setRevealed(!revealed())}
                >
                  <Glyph name="eye" size={14} />
                </button>
                <button
                  type="button"
                  class="text-fg-3 hover:text-fg-2"
                  aria-label="Copy token"
                  onClick={() => void copy(current())}
                >
                  <Glyph name="copy" size={14} />
                </button>
              </Show>
            </div>
            <Show when={fresh()}>
              {(next) => (
                <div class="flex flex-col gap-2 rounded-[2px] border border-line bg-page p-2.5">
                  <span class="text-[11.5px] text-fg-3">
                    The new token, shown once. Copy it for any device you want to keep.
                  </span>
                  <span class="truncate font-mono text-[12px] text-fg">{next()}</span>
                  <div class="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void copy(next())}>
                      <Glyph name="copy" size={13} />
                      Copy
                    </Button>
                    <Show
                      when={released()}
                      fallback={
                        <Button size="sm" variant="primary" onClick={() => setFresh(undefined)}>
                          Done
                        </Button>
                      }
                    >
                      <Button size="sm" variant="primary" onClick={adopt}>
                        Keep this browser signed in
                      </Button>
                      <Button size="sm" variant="quiet" onClick={leave}>
                        Sign this browser out
                      </Button>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show when={qr()}>
              {(svg) => (
                <div class="flex items-start gap-3 rounded-[2px] border border-line bg-page p-3">
                  <div class="shrink-0 rounded-[2px] bg-page p-1" innerHTML={svg()} />
                  <p class="text-[11.5px] leading-snug text-fg-3">
                    Scan from a phone. The code carries this token, so that phone is signed in with it and nothing else
                    changes.
                  </p>
                </div>
              )}
            </Show>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="quiet" onClick={() => void toggleQr()}>
                <Glyph name="qr-code" size={14} />
                {qr() === undefined ? "Show QR for phone" : "Hide QR"}
              </Button>
              <Show
                when={rotating()}
                fallback={
                  <Button size="sm" onClick={() => setRotating(true)}>
                    <Glyph name="rotate-ccw" size={14} />
                    Rotate token
                  </Button>
                }
              >
                <span class="text-[12px] text-fg-2">Every other device has to sign in with the new token.</span>
                <Button size="sm" variant="quiet" onClick={() => setRotating(false)}>Keep</Button>
                <Button size="sm" variant="primary" disabled={busy()} onClick={() => void rotate(false)}>
                  {busy() ? "Rotating" : "Rotate"}
                </Button>
              </Show>
              <Show when={note()}>
                {(message) => <span class="text-[11.5px] text-fg-3">{message()}</span>}
              </Show>
            </div>
            <Note>
              There are no passwords. Rotating replaces the token for this home, closes every live socket, and leaves the
              old token dead. The token in this browser is swapped for you.
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
        <Row title="Sign out everywhere" detail="Rotates the token: every device, including this one, has to sign in again">
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
              <span class="text-[12px] text-fg-2">
                The new token is shown once, so you can keep a device or leave.
              </span>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep</Button>
              <Button size="sm" variant="danger" disabled={busy()} onClick={() => void rotate(true)}>
                {busy() ? "Rotating" : "Sign out everywhere"}
              </Button>
            </Show>
          </div>
        </Row>
        <Note>
          Rotating is the revocation path: the token is the whole identity, so replacing it signs out every other device at
          once.
        </Note>
      </Group>
    </div>
  )
}
