import { Match, Switch, type JSX } from "solid-js"
import { OnboardingFrame } from "../components/onboarding/chrome.tsx"
import { ProviderStep } from "../components/onboarding/provider-step.tsx"
import { CaptainStep } from "../components/onboarding/captain-step.tsx"
import { ThreadStep } from "../components/onboarding/thread-step.tsx"
import { NotificationsDialog } from "../components/onboarding/notifications-dialog.tsx"
import {
  goToStep,
  onboardingCaptain,
  onboardingIndex,
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
  return (
    <OnboardingFrame
      current={onboardingIndex()}
      done={done}
      onSelect={(index) => {
        if (index <= onboardingIndex() || done(index - 1)) goToStep(index)
      }}
    >
      <Switch>
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
