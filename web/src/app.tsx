import { createSignal, onMount, Show, type JSX } from "solid-js"
import { token, verifyToken } from "./lib/auth.ts"
import { connect } from "./state/connection.ts"
import { subscribeHome } from "./state/home.ts"
import { Shell } from "./components/shell/shell.tsx"
import { SignIn } from "./screens/signin.tsx"

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
    <Show when={authed() !== undefined} fallback={<div class="grid h-full place-items-center" />}>
      <Show when={authed()} fallback={<SignIn onSignedIn={enter} />}>
        <Shell />
      </Show>
    </Show>
  )
}
