import { createSignal } from "solid-js"
import { cmd } from "../lib/api.ts"
import { numOf, recordOf, strOf } from "../lib/parse.ts"
import { enablePush as enableBrowserPush } from "../lib/push.ts"
import { slugify } from "../lib/slug.ts"
import { activeProjects } from "./home.ts"
import { models, saveCredential, type ModelInfo, type ModelRef } from "./settings.ts"

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

export type CaptainInput = {
  readonly name: string
  readonly goal: string
  readonly repository: string
  readonly model: ModelRef | undefined
  readonly suggestions: readonly Suggestion[]
}

export type Suggestion = { readonly title: string; readonly detail: string }

export type CaptainResult = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly coordinatorId: number
  readonly model: ModelRef | undefined
  readonly suggestions: readonly Suggestion[]
}

export type PushOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "on"; readonly endpoint: string }
  | { readonly kind: "off"; readonly message: string }

const [stepIndex, setStepIndex] = createSignal(1)
const [connectedProvider, setConnectedProvider] = createSignal<ProviderResult | undefined>(undefined)
const [firstCaptain, setFirstCaptain] = createSignal<CaptainResult | undefined>(undefined)
const [firstReport, setFirstReport] = createSignal(false)
const [notifyOpen, setNotifyOpen] = createSignal(false)
const [pushOutcome, setPushOutcome] = createSignal<PushOutcome>({ kind: "idle" })

export const onboardingIndex = stepIndex
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

async function captainProject(name: string): Promise<string> {
  const existing = activeProjects()[0]
  if (existing !== undefined) return existing.id
  const created = recordOf(await cmd<unknown>("project.create", { slug: slugify(name), name }))
  const id = strOf(created?.["id"])
  if (id === undefined) throw new Error("The project for this Captain was created, but the reply could not be read.")
  return id
}

export async function createFirstCaptain(input: CaptainInput, commandId: string): Promise<CaptainResult> {
  const name = input.name.trim()
  if (slugify(name) === "") throw new Error("Use at least one letter or number in the name.")
  const goal = input.goal.trim()
  const repository = input.repository.trim()
  const projectId = await captainProject(name)
  const created = recordOf(
    await cmd<unknown>(
      "captain.create",
      {
        projectId,
        name,
        ...(goal === "" ? {} : { description: goal }),
        ...(repository === "" ? {} : { rules: `Repository: ${repository}` }),
        ...(input.model === undefined ? {} : { model: input.model }),
      },
      { id: commandId },
    ),
  )
  const id = strOf(created?.["id"])
  const coordinatorId = numOf(created?.["coordinatorId"])
  if (id === undefined || coordinatorId === undefined)
    throw new Error("The Captain was created, but the reply could not be read.")
  const result: CaptainResult = {
    id,
    name: strOf(created?.["name"]) ?? name,
    description: strOf(created?.["description"]) ?? goal,
    coordinatorId,
    model: input.model,
    suggestions: input.suggestions,
  }
  setFirstCaptain(result)
  return result
}

export async function sendFirstMessage(captain: CaptainResult, text: string, commandId: string): Promise<void> {
  await cmd("message.send", { conv: captain.coordinatorId, text, clientTs: Date.now() }, { id: commandId })
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
