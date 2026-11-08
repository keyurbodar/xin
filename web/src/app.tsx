import { createSignal, onMount, Show, type JSX } from "solid-js"
import { token, verifyToken } from "./lib/auth.ts"
import { connect, connectionState, reauthorize } from "./state/connection.ts"
import { subscribeHome } from "./state/home.ts"
import { navigate, route } from "./lib/router.ts"
import { Shell } from "./components/shell/shell.tsx"
import { SignIn } from "./screens/signin.tsx"
import { LandingScreen } from "./screens/landing.tsx"
import { WelcomeScreen } from "./screens/welcome.tsx"

function isPushMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === "xin-push"
}

export function App(): JSX.Element {
  const [authed, setAuthed] = createSignal<boolean | undefined>(undefined)

  /** A stored token that still works skips the form, and the address bar stops claiming to be on it. */
  const enter = (): void => {
    const streams = connect()
    subscribeHome(streams)
    setAuthed(true)
    if (route().parts[0] === "signin") navigate("/")
    // A push only goes out when no socket is open, so hearing one means this tab should try again now.
    navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
      if (isPushMessage(event.data) && connectionState() !== "open") reauthorize()
    })
  }

  onMount(() => {
    void (async () => {
      if (token() !== "" && (await verifyToken(token()))) enter()
      else setAuthed(false)
    })()
  })

  return (
    <Show when={route().parts[0] !== "landing"} fallback={<LandingScreen />}>
      <Show when={authed() !== undefined} fallback={<div class="grid h-full place-items-center" />}>
        <Show when={authed()} fallback={<SignIn onSignedIn={enter} />}>
          <Show when={route().parts[0] === "welcome"} fallback={<Shell />}>
            <WelcomeScreen />
          </Show>
        </Show>
      </Show>
    </Show>
  )
}
