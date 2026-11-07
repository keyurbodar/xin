import { createSignal } from "solid-js"
import { cmd } from "../lib/api.ts"

export type OnboardingStepId = "provider" | "project" | "message" | "notifications"

export const ONBOARDING_STEPS: readonly { readonly id: OnboardingStepId; readonly label: string }[] = [
  { id: "provider", label: "Model key" },
  { id: "project", label: "First project" },
  { id: "message", label: "First message" },
  { id: "notifications", label: "Notifications" },
]

export type ListedModel = {
  readonly provider: string
  readonly modelId: string
  readonly name: string
  readonly contextWindow: number
  readonly vision: boolean
  readonly reasoning: boolean
}

export type ProviderResult = {
  readonly provider: string
  readonly models: readonly ListedModel[]
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

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return slug === "" ? "first-project" : slug
}

export async function connectProvider(input: ProviderInput): Promise<ProviderResult> {
  switch (input.kind) {
    case "key":
      await cmd<unknown>("credential.set", { provider: input.provider, key: input.key })
      break
    case "custom":
      await cmd<unknown>("credential.set", {
        provider: input.provider,
        custom: { baseUrl: input.baseUrl, api: input.api, key: input.key },
      })
      break
  }
  const models = await modelsFor(input.provider).catch((): readonly ListedModel[] => [])
  const result: ProviderResult = { provider: input.provider, models }
  setConnectedProvider(result)
  return result
}

export async function createFirstProject(name: string, goal: string): Promise<ProjectResult> {
  const trimmedName = name.trim()
  const trimmedGoal = goal.trim()
  if (trimmedName === "") throw new Error("Give the project a name.")
  const args: Record<string, unknown> = {
    slug: slugify(trimmedName),
    name: trimmedName,
    ...(trimmedGoal === "" ? {} : { goal: trimmedGoal }),
  }
  const value = await cmd<unknown>("project.create", args)
  const id = field(value, "id")
  const slug = field(value, "slug")
  const resolvedName = field(value, "name")
  const resolvedGoal = field(value, "goal")
  if (typeof id !== "string" || typeof slug !== "string" || typeof resolvedName !== "string")
    throw new Error("The project was created, but the reply could not be read.")
  const result: ProjectResult = {
    id,
    slug,
    name: resolvedName,
    ...(typeof resolvedGoal === "string" ? { goal: resolvedGoal } : {}),
  }
  setConnectedProject(result)
  return result
}

export async function enablePush(): Promise<void> {
  setPushOutcome({ kind: "working" })
  if (typeof Notification === "undefined" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    setPushOutcome({ kind: "off", message: "This browser cannot receive push notifications." })
    return
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (registration === undefined) {
      setPushOutcome({
        kind: "off",
        message: "Push needs the installed app. Open this workspace from its home-screen icon, then try again.",
      })
      return
    }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
    if (permission !== "granted") {
      setPushOutcome({ kind: "off", message: "Notifications are blocked in your browser settings." })
      return
    }
    const key = field(await cmd<unknown>("push.key", {}), "applicationServerKey")
    if (typeof key !== "string") throw new Error("The server sent no push key.")
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(key),
      }))
    const json = subscription.toJSON()
    const endpoint = json.endpoint
    const p256dh = json.keys?.["p256dh"]
    const auth = json.keys?.["auth"]
    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string")
      throw new Error("The browser returned an incomplete subscription.")
    await cmd<unknown>("push.subscribe", { endpoint, keys: { p256dh, auth } })
    setPushOutcome({ kind: "on", endpoint })
  } catch (failure) {
    setPushOutcome({ kind: "off", message: messageOf(failure, "Push could not be turned on.") })
  }
}

export function messageOf(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message !== "" ? failure.message : fallback
}

export function projectPath(project: ProjectResult | undefined): string {
  return project === undefined ? "/" : `/p/${project.slug}`
}

async function modelsFor(provider: string): Promise<readonly ListedModel[]> {
  const value = await cmd<unknown>("models.list", {})
  const listed = field(value, "models")
  if (!Array.isArray(listed)) return []
  return listed.flatMap((entry: unknown) => {
    const model = readModel(entry)
    return model === undefined || model.provider !== provider ? [] : [model]
  })
}

function readModel(value: unknown): ListedModel | undefined {
  const provider = field(value, "provider")
  const modelId = field(value, "modelId")
  const name = field(value, "name")
  const contextWindow = field(value, "contextWindow")
  if (typeof provider !== "string" || typeof modelId !== "string") return undefined
  return {
    provider,
    modelId,
    name: typeof name === "string" ? name : modelId,
    contextWindow: typeof contextWindow === "number" ? contextWindow : 0,
    vision: field(value, "vision") === true,
    reasoning: field(value, "reasoning") === true,
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
