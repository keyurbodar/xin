import { createSignal } from "solid-js"
import { cmd } from "../lib/api.ts"
import { recordOf, strOf } from "../lib/parse.ts"
import { enablePush as enableBrowserPush } from "../lib/push.ts"
import { slugify } from "../lib/slug.ts"
import { models, saveCredential, type ModelInfo } from "./settings.ts"

export type OnboardingStepId = "provider" | "project" | "message" | "notifications"

export const ONBOARDING_STEPS: readonly { readonly id: OnboardingStepId; readonly label: string }[] = [
  { id: "provider", label: "Model key" },
  { id: "project", label: "First project" },
  { id: "message", label: "First message" },
  { id: "notifications", label: "Notifications" },
]

export type ProviderResult = {
  readonly provider: string
  readonly models: readonly ModelInfo[]
}

export type ProjectResult = {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly goal?: string
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

const [stepIndex, setStepIndex] = createSignal(0)
const [connectedProvider, setConnectedProvider] = createSignal<ProviderResult | undefined>(undefined)
const [connectedProject, setConnectedProject] = createSignal<ProjectResult | undefined>(undefined)
const [pushOutcome, setPushOutcome] = createSignal<PushOutcome>({ kind: "idle" })

export const onboardingIndex = stepIndex
export const onboardingProvider = connectedProvider
export const onboardingProject = connectedProject
export const onboardingPush = pushOutcome

export function onboardingStep(): OnboardingStepId {
  return ONBOARDING_STEPS[stepIndex()]?.id ?? "provider"
}

export function goToStep(index: number): void {
  const clamped = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, index))
  setStepIndex(clamped)
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

export function resetPush(): void {
  setPushOutcome({ kind: "idle" })
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
  const result: ProviderResult = { provider: input.provider, models: await modelsFor(input.provider) }
  setConnectedProvider(result)
  return result
}

async function modelsFor(provider: string): Promise<readonly ModelInfo[]> {
  if (models.state().kind !== "ready") await models.reload()
  const state = models.state()
  return state.kind === "ready" ? state.value.models.filter((model) => model.provider === provider) : []
}

export async function createFirstProject(name: string, goal: string): Promise<ProjectResult> {
  const trimmedName = name.trim()
  const trimmedGoal = goal.trim()
  const slug = slugify(trimmedName)
  if (slug === "") throw new Error("Use at least one letter or number in the name.")
  const args: Record<string, unknown> = {
    slug,
    name: trimmedName,
    ...(trimmedGoal === "" ? {} : { goal: trimmedGoal }),
  }
  const root = recordOf(await cmd<unknown>("project.create", args))
  const id = strOf(root?.["id"])
  const resolvedSlug = strOf(root?.["slug"])
  const resolvedName = strOf(root?.["name"])
  const resolvedGoal = strOf(root?.["goal"])
  if (id === undefined || resolvedSlug === undefined || resolvedName === undefined)
    throw new Error("The project was created, but the reply could not be read.")
  const result: ProjectResult = {
    id,
    slug: resolvedSlug,
    name: resolvedName,
    ...(resolvedGoal === undefined ? {} : { goal: resolvedGoal }),
  }
  setConnectedProject(result)
  return result
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

export function projectPath(project: ProjectResult | undefined): string {
  return project === undefined ? "/" : `/p/${project.slug}`
}
