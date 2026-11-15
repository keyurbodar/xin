import { createSignal } from "solid-js"
import { cmd } from "../lib/api.ts"
import {
  ensureCaptain,
  firstOpenStep,
  readProgress,
  type CaptainInput,
  type CaptainResult,
  type SendKey,
} from "../lib/onboarding.ts"
import { enablePush as enableBrowserPush } from "../lib/push.ts"
import { models, saveCredential, type ModelInfo } from "./settings.ts"

export type OnboardingStepId = "signin" | "provider" | "captain" | "thread"

export const ONBOARDING_STEPS: readonly { readonly id: OnboardingStepId; readonly label: string }[] = [
  { id: "signin", label: "Sign in" },
  { id: "provider", label: "Model key" },
  { id: "captain", label: "First Captain" },
  { id: "thread", label: "First thread" },
]

export type ProviderResult = {
  readonly provider: string
  readonly models: readonly ModelInfo[]
}

export type ProviderInput =
  | { readonly kind: "key"; readonly provider: string; readonly key: string }
  | {
      readonly kind: "custom"
      readonly provider: string
      readonly key: string
      readonly baseUrl: string
      readonly api: string
    }

export type PushOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "on"; readonly endpoint: string }
  | { readonly kind: "off"; readonly message: string }

const [stepIndex, setStepIndex] = createSignal(1)
const [loaded, setLoaded] = createSignal(false)
const [connectedProvider, setConnectedProvider] = createSignal<ProviderResult | undefined>(undefined)
const [firstCaptain, setFirstCaptain] = createSignal<CaptainResult | undefined>(undefined)
const [firstReport, setFirstReport] = createSignal(false)
const [notifyOpen, setNotifyOpen] = createSignal(false)
const [pushOutcome, setPushOutcome] = createSignal<PushOutcome>({ kind: "idle" })

export const onboardingIndex = stepIndex
export const onboardingLoaded = loaded
export const onboardingProvider = connectedProvider
export const onboardingCaptain = firstCaptain
export const onboardingReported = firstReport
export const onboardingPush = pushOutcome
export const notificationsOpen = notifyOpen

export function onboardingStep(): OnboardingStepId {
  return ONBOARDING_STEPS[stepIndex()]?.id ?? "provider"
}

export function goToStep(index: number): void {
  setStepIndex(Math.max(1, Math.min(ONBOARDING_STEPS.length - 1, index)))
}

export function nextStep(): void {
  goToStep(stepIndex() + 1)
}

export function previousStep(): void {
  goToStep(stepIndex() - 1)
}

export function forgetProvider(): void {
  setConnectedProvider(undefined)
}

export function openNotifications(open: boolean): void {
  setNotifyOpen(open)
}

export function markFirstReport(): void {
  if (firstReport()) return
  setFirstReport(true)
  if (pushOutcome().kind !== "on") setNotifyOpen(true)
}

export async function connectProvider(input: ProviderInput): Promise<ProviderResult> {
  switch (input.kind) {
    case "key":
      await saveCredential(input.provider, input.key)
      break
    case "custom":
      await saveCredential(input.provider, input.key, { baseUrl: input.baseUrl, api: input.api })
      break
  }
  const state = models.state()
  const listed = state.kind === "ready" ? state.value.models.filter((model) => model.provider === input.provider) : []
  const result: ProviderResult = { provider: input.provider, models: listed }
  setConnectedProvider(result)
  return result
}

export async function loadProgress(): Promise<void> {
  const progress = await readProgress()
  if (progress.provider !== undefined) {
    if (models.state().kind !== "ready") await models.reload()
    const state = models.state()
    const listed = state.kind === "ready" ? state.value.models.filter((model) => model.provider === progress.provider) : []
    setConnectedProvider({ provider: progress.provider, models: listed })
  }
  setFirstCaptain(progress.captain)
  setFirstReport(progress.reported)
  setStepIndex(firstOpenStep(progress))
  setLoaded(true)
}

export async function createFirstCaptain(input: CaptainInput, commandId: string): Promise<CaptainResult> {
  const result = await ensureCaptain(input, commandId)
  setFirstCaptain(result)
  return result
}

export async function sendFirstMessage(captain: CaptainResult, key: SendKey): Promise<void> {
  await cmd("message.send", { conv: captain.coordinatorId, text: key.text, clientTs: key.at }, { id: key.id })
}

export async function enablePush(): Promise<void> {
  setPushOutcome({ kind: "working" })
  const change = await enableBrowserPush()
  switch (change.kind) {
    case "subscribed":
      setPushOutcome({ kind: "on", endpoint: change.endpoint })
      return
    case "failed":
      setPushOutcome({ kind: "off", message: change.message })
      return
    case "unsubscribed":
      setPushOutcome({ kind: "off", message: "Push is off for this browser." })
      return
  }
}

export function messageOf(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message !== "" ? failure.message : fallback
}
