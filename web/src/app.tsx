import { createSignal, ErrorBoundary, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { probe, setToken, token } from "./lib/auth.ts"
import { connect, connectionState, reauthorize } from "./state/connection.ts"
import { subscribeHome } from "./state/home.ts"
import { subscribeCaptains } from "./state/captains.ts"
import { navigate, route } from "./lib/router.ts"
import { Shell } from "./components/shell/shell.tsx"
import { BootLoader } from "./components/ui/loaders.tsx"
import { lazyView } from "./components/ui/lazy-view.tsx"
import { Stopped } from "./components/ui/stopped.tsx"
import { BootFailedScreen } from "./screens/boot-failed.tsx"
import { SignIn } from "./screens/signin.tsx"
import { needsOnboarding } from "./lib/onboarding.ts"
import { cutOff, OfflineScreen } from "./screens/offline.tsx"
import { pullRemote } from "./appearance/store.ts"

const bootLoader = (): JSX.Element => (
  <div class="grid h-full place-items-center">
    <BootLoader label="Starting Ingle" />
  </div>
)
const WelcomeScreen = lazyView(() => import("./screens/welcome.tsx").then((module) => module.WelcomeScreen), bootLoader)

/** Onboarding behind its own boundary, so a chunk that fails to load offers Try again instead of the boot loader forever. */
export function WelcomeRoute(): JSX.Element {
  return (
    <ErrorBoundary fallback={(error: unknown, reset) => <Stopped title="Setup didn't load" error={error} onRetry={reset} class="h-full" />}>
      <WelcomeScreen />
    </ErrorBoundary>
  )
}

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
    void pullRemote()
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
        <SignIn
          onSignedIn={async () => {
            await start()
            if (await needsOnboarding()) navigate("/welcome")
          }}
        />
      </Match>
      <Match when={bootFailure()}>
        {(failure) => <BootFailedScreen failure={failure()} onRecovered={() => void start()} onSignedOut={signOut} />}
      </Match>
      <Match when={gate().kind === "ready"}>
        <div class="contents" inert={offline()}>
          <Show when={route().parts[0] === "welcome"} fallback={<Shell />}>
            <WelcomeRoute />
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
