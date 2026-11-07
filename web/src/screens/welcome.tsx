import { Match, Switch, type JSX } from "solid-js"
import { OnboardingTopBar, type RailItem } from "../components/onboarding/chrome.tsx"
import { ProviderStep } from "../components/onboarding/provider-step.tsx"
import { ProjectStep } from "../components/onboarding/project-step.tsx"
import { MessageStep } from "../components/onboarding/message-step.tsx"
import { NotificationsStep } from "../components/onboarding/notifications-step.tsx"
import {
  ONBOARDING_STEPS,
  goToStep,
  onboardingIndex,
  onboardingProject,
  onboardingProvider,
  onboardingPush,
  onboardingStep,
} from "../state/onboarding.ts"

export function WelcomeScreen(): JSX.Element {
  const items = (): readonly RailItem[] =>
    ONBOARDING_STEPS.map(
      (step, index): RailItem => ({
        label: step.label,
        state:
          index === onboardingIndex()
            ? "current"
            : index < onboardingIndex() || complete(index)
              ? "done"
              : "todo",
      }),
    )

  return (
    <div class="flex h-full flex-col bg-page text-fg">
      <OnboardingTopBar
        items={items()}
        onSelect={(index) => {
          if (index <= onboardingIndex()) goToStep(index)
        }}
      />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Switch>
          <Match when={onboardingStep() === "provider"}>
            <ProviderStep />
          </Match>
          <Match when={onboardingStep() === "project"}>
            <ProjectStep />
          </Match>
          <Match when={onboardingStep() === "message"}>
            <MessageStep />
          </Match>
          <Match when={onboardingStep() === "notifications"}>
            <NotificationsStep />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function complete(index: number): boolean {
  switch (index) {
    case 0:
      return onboardingProvider() !== undefined
    case 1:
      return onboardingProject() !== undefined
    case 3:
      return onboardingPush().kind === "on"
    default:
      return false
  }
}
