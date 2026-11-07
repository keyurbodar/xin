import { createSignal, onMount, Show, type JSX } from "solid-js"
import { token, verifyToken } from "./lib/auth.ts"
import { connect } from "./state/connection.ts"
import { subscribeHome } from "./state/home.ts"
import { route } from "./lib/router.ts"
import { Shell } from "./components/shell/shell.tsx"
import { SignIn } from "./screens/signin.tsx"
import { LandingScreen } from "./screens/landing.tsx"
import { WelcomeScreen } from "./screens/welcome.tsx"

export function App(): JSX.Element {
  const [authed, setAuthed] = createSignal<boolean | undefined>(undefined)

  const enter = (): void => {
    const streams = connect()
    subscribeHome(streams)
    setAuthed(true)
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
