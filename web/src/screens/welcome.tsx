import { createSignal, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { OnboardingFrame } from "../components/onboarding/chrome.tsx"
import { ProviderStep } from "../components/onboarding/provider-step.tsx"
import { CaptainStep } from "../components/onboarding/captain-step.tsx"
import { ThreadStep } from "../components/onboarding/thread-step.tsx"
import { NotificationsDialog } from "../components/onboarding/notifications-dialog.tsx"
import {
  goToStep,
  onboardingCaptain,
  loadProgress,
  messageOf,
  onboardingIndex,
  onboardingLoaded,
  onboardingProvider,
  onboardingReported,
  onboardingStep,
} from "../state/onboarding.ts"

function done(index: number): boolean {
  switch (index) {
    case 0:
      return true
    case 1:
      return onboardingProvider() !== undefined || onboardingIndex() > 1
    case 2:
      return onboardingCaptain() !== undefined
    case 3:
      return onboardingReported()
    default:
      return false
  }
}

export function WelcomeScreen(): JSX.Element {
  const [failure, setFailure] = createSignal<string | undefined>(undefined)
  const load = (): void => {
    setFailure(undefined)
    loadProgress().catch((error: unknown) => setFailure(messageOf(error, "Setup could not read this instance.")))
  }
  onMount(load)

  return (
    <OnboardingFrame
      current={onboardingIndex()}
      done={done}
      onSelect={(index) => {
        if (index <= onboardingIndex() || done(index - 1)) goToStep(index)
      }}
    >
      <Show when={failure()}>
        {(message) => (
          <section class="im-arrive w-full max-w-[440px] rounded-lg border border-line-1 bg-card px-7 py-6">
            <p role="alert" class="text-base text-failed">
              {message()}
            </p>
            <button
              type="button"
              onClick={load}
              class="im-press mt-4 h-8 rounded-md bg-secondary px-3 text-base text-ink hover:bg-hover"
            >
              Try again
            </button>
          </section>
        )}
      </Show>
      <Switch>
        <Match when={!onboardingLoaded()}>{null}</Match>
        <Match when={onboardingStep() === "provider"}>
          <ProviderStep />
        </Match>
        <Match when={onboardingStep() === "captain"}>
          <CaptainStep />
        </Match>
        <Match when={onboardingStep() === "thread"}>
          <ThreadStep />
        </Match>
      </Switch>
      <NotificationsDialog />
    </OnboardingFrame>
  )
}
