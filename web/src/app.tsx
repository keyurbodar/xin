import { createSignal, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { probe, setToken, token } from "./lib/auth.ts"
import { connect, connectionState, reauthorize } from "./state/connection.ts"
import { subscribeHome } from "./state/home.ts"
import { subscribeCaptains } from "./state/captains.ts"
import { navigate, route } from "./lib/router.ts"
import { Shell } from "./components/shell/shell.tsx"
import { BootLoader } from "./components/ui/loaders.tsx"
import { SignIn } from "./screens/signin.tsx"
import { WelcomeScreen } from "./screens/welcome.tsx"
import { BootFailedScreen } from "./screens/boot-failed.tsx"
import { cutOff, OfflineScreen } from "./screens/offline.tsx"

type Gate =
  | { readonly kind: "checking" }
  | { readonly kind: "signin" }
  | { readonly kind: "ready" }
  | { readonly kind: "boot_failed"; readonly failure: string }

function isPushMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === "ingle-push"
}

export function App(): JSX.Element {
  const [gate, setGate] = createSignal<Gate>({ kind: "checking" })
  const offline = cutOff()
  let entered = false

  /** A stored token that still works skips the form, and the address bar stops claiming to be on it. */
  const enter = (): void => {
    setGate({ kind: "ready" })
    if (route().parts[0] === "signin") navigate("/")
    if (entered) {
      reauthorize()
      return
    }
    entered = true
    const streams = connect()
    subscribeHome(streams)
    subscribeCaptains(streams)
    // A push only goes out when no socket is open, so hearing one means this tab should try again now.
    navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
      if (isPushMessage(event.data) && connectionState() !== "open") reauthorize()
    })
  }

  /** An unreachable Worker still enters: the shell paints and the offline screen takes over once the socket gives up. */
  const start = async (): Promise<void> => {
    if (token() === "") {
      setGate({ kind: "signin" })
      return
    }
    const answer = await probe(token())
    if (answer.kind === "unauthorized") setGate({ kind: "signin" })
    else if (answer.kind === "boot_failed") setGate({ kind: "boot_failed", failure: answer.failure })
    else enter()
  }

  const signOut = (): void => {
    setToken("")
    setGate({ kind: "signin" })
  }

  const bootFailure = (): string | undefined => {
    const current = gate()
    return current.kind === "boot_failed" ? current.failure : undefined
  }

  onMount(() => void start())

  return (
    <Switch fallback={<div class="grid h-full place-items-center"><BootLoader label="Starting Ingle" /></div>}>
      <Match when={gate().kind === "signin"}>
        <SignIn onSignedIn={() => void start()} />
      </Match>
      <Match when={bootFailure()}>
        {(failure) => <BootFailedScreen failure={failure()} onRecovered={() => void start()} onSignedOut={signOut} />}
      </Match>
      <Match when={gate().kind === "ready"}>
        <div class="contents" inert={offline()}>
          <Show when={route().parts[0] === "welcome"} fallback={<Shell />}>
            <WelcomeScreen />
          </Show>
        </div>
        <Show when={offline()}>
          <OfflineScreen
            onBootFailed={(failure) => setGate({ kind: "boot_failed", failure })}
            onSignedOut={signOut}
          />
        </Show>
      </Match>
    </Switch>
  )
}
