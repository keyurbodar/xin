import { cmd } from "./api.ts"
import { listOf, numOf, recordOf, strOf } from "./parse.ts"
import { slugify } from "./slug.ts"

export type ModelRef = { readonly provider: string; readonly modelId: string }

export type Suggestion = { readonly title: string; readonly detail: string }

export type Template = {
  readonly label: string
  readonly name: string
  readonly goal: string
  readonly suggestions: readonly Suggestion[]
}

export type CaptainResult = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly coordinatorId: number
  readonly model: ModelRef | undefined
  readonly suggestions: readonly Suggestion[]
}

export type CaptainInput = {
  readonly name: string
  readonly goal: string
  readonly repository: string
  readonly model: ModelRef | undefined
  readonly suggestions: readonly Suggestion[]
}

export type Progress = {
  readonly provider: string | undefined
  readonly captain: CaptainResult | undefined
  readonly reported: boolean
}

export type SendKey = { readonly text: string; readonly id: string; readonly at: number }

export const TEMPLATES: readonly Template[] = [
  {
    label: "A codebase",
    name: "Bosun",
    goal: "Keep the repo moving: land small PRs, keep the build green, and post a report every evening.",
    suggestions: [
      { title: "Fix the flakiest test", detail: "Starts a thread and opens a PR" },
      { title: "Audit the open pull requests", detail: "Sums up what is stuck and why" },
      { title: "Post a report every evening", detail: "Sets up a schedule" },
      { title: "Give me a tour of the repo", detail: "Reads the code and writes a map" },
    ],
  },
  {
    label: "Docs and blog",
    name: "Quill",
    goal: "Keep the docs true to the code and publish one post a week.",
    suggestions: [
      { title: "Find docs pages that went stale", detail: "Checks each page against the code" },
      { title: "Draft this week’s post", detail: "Starts a thread for the draft" },
      { title: "Send me an outline every Monday", detail: "Sets up a schedule" },
      { title: "Tidy the docs index", detail: "Proposes a new order" },
    ],
  },
  {
    label: "Personal ops",
    name: "Steward",
    goal: "Keep my week in order: chase what is late and send a summary every Friday.",
    suggestions: [
      { title: "Plan my week", detail: "Turns the goal into a short list" },
      { title: "List what is overdue", detail: "Reads your notes and threads" },
      { title: "Send a summary every Friday", detail: "Sets up a schedule" },
      { title: "Draft the replies I owe", detail: "Starts a thread per reply" },
    ],
  },
]

export const OWN_SUGGESTIONS: readonly Suggestion[] = [
  { title: "Plan the first week", detail: "Turns the goal into a short list" },
  { title: "Research what I need to know", detail: "Starts a few threads in parallel" },
  { title: "Post a report every evening", detail: "Sets up a schedule" },
  { title: "Tell me what you can do", detail: "A quick tour of your tools" },
]

export function suggestionsFor(description: string): readonly Suggestion[] {
  return TEMPLATES.find((template) => template.goal === description)?.suggestions ?? OWN_SUGGESTIONS
}

export function aliasOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "captain"
  )
}

function modelOf(value: unknown): ModelRef | undefined {
  const record = recordOf(value)
  const provider = strOf(record?.["provider"])
  const modelId = strOf(record?.["modelId"])
  return provider === undefined || modelId === undefined ? undefined : { provider, modelId }
}

function captainOf(value: unknown, fallback: { model: ModelRef | undefined; suggestions?: readonly Suggestion[] }): CaptainResult | undefined {
  const record = recordOf(value)
  const id = strOf(record?.["id"])
  const name = strOf(record?.["name"])
  const coordinatorId = numOf(record?.["coordinatorId"])
  if (id === undefined || name === undefined || coordinatorId === undefined || record?.["archived"] === true) return undefined
  const description = strOf(record?.["description"]) ?? ""
  return {
    id,
    name,
    description,
    coordinatorId,
    model: modelOf(record?.["model"]) ?? fallback.model,
    suggestions: fallback.suggestions ?? suggestionsFor(description),
  }
}

async function liveCaptains(): Promise<readonly unknown[]> {
  return listOf(await cmd<unknown>("captain.list"))
}

export async function readProgress(): Promise<Progress> {
  const [catalog, captains] = await Promise.all([cmd<unknown>("models.list"), liveCaptains()])
  const provider = strOf(recordOf(listOf(recordOf(catalog)?.["models"])[0])?.["provider"])
  const first = captains.map((entry) => captainOf(entry, { model: undefined })).find((entry) => entry !== undefined)
  if (first === undefined) return { provider, captain: undefined, reported: false }
  const detail = recordOf(await cmd<unknown>("captain.get", { id: first.id }))
  const reported = listOf(detail?.["crew"]).some((member) => recordOf(member)?.["status"] === "completed")
  return { provider, captain: captainOf(detail, { model: undefined }) ?? first, reported }
}

export function showsOnboarding(state: { readonly onboarded: boolean; readonly hasCaptain: boolean }): boolean {
  return !state.onboarded && !state.hasCaptain
}

export async function needsOnboarding(): Promise<boolean> {
  const [owner, captains] = await Promise.all([cmd<unknown>("owner.read"), liveCaptains()])
  return showsOnboarding({
    onboarded: strOf(recordOf(owner)?.["onboardedAt"]) !== undefined,
    hasCaptain: captains.some((entry) => captainOf(entry, { model: undefined }) !== undefined),
  })
}

export async function markOnboarded(): Promise<void> {
  await cmd("owner.set", { onboarded: true })
}

export function firstOpenStep(progress: Progress): 1 | 2 | 3 {
  if (progress.captain !== undefined) return 3
  return progress.provider === undefined ? 1 : 2
}

export type ProjectRow = { readonly id: string; readonly slug: string; readonly archived: boolean }

export type ProjectPlan =
  | { readonly kind: "reuse"; readonly id: string }
  | { readonly kind: "create"; readonly slug: string; readonly commandId: string }

export function projectPlan(projects: readonly ProjectRow[], name: string): ProjectPlan {
  const live = projects.find((project) => !project.archived)
  if (live !== undefined) return { kind: "reuse", id: live.id }
  const base = slugify(name)
  const taken = new Set(projects.map((project) => project.slug))
  let slug = base
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base.slice(0, 60)}-${suffix}`
  return { kind: "create", slug, commandId: `onboarding-${slug}` }
}

function projectRowOf(value: unknown): ProjectRow | undefined {
  const record = recordOf(value)
  const id = strOf(record?.["id"])
  const slug = strOf(record?.["slug"])
  return id === undefined || slug === undefined ? undefined : { id, slug, archived: record?.["archived"] === true }
}

async function captainProject(name: string): Promise<string> {
  const workspace = recordOf(await cmd<unknown>("workspace.read"))
  const projects = listOf(workspace?.["projects"]).flatMap((entry) => {
    const row = projectRowOf(entry)
    return row === undefined ? [] : [row]
  })
  for (;;) {
    const plan = projectPlan(projects, name)
    if (plan.kind === "reuse") return plan.id
    const created = projectRowOf(await cmd<unknown>("project.create", { slug: plan.slug, name }, { id: plan.commandId }))
    if (created === undefined) throw new Error("The project for this Captain was created, but the reply could not be read.")
    if (!created.archived) return created.id
    projects.push(created)
  }
}

export async function ensureCaptain(input: CaptainInput, commandId: string): Promise<CaptainResult> {
  const name = input.name.trim()
  if (slugify(name) === "") throw new Error("Use at least one letter or number in the name.")
  const fallback = { model: input.model, suggestions: input.suggestions }
  const alias = aliasOf(name)
  const reused = (await liveCaptains())
    .filter((entry) => recordOf(entry)?.["alias"] === alias)
    .map((entry) => captainOf(entry, fallback))
    .find((entry) => entry !== undefined)
  if (reused !== undefined) return reused
  const goal = input.goal.trim()
  const repository = input.repository.trim()
  const created = await cmd<unknown>(
    "captain.create",
    {
      projectId: await captainProject(name),
      name,
      ...(goal === "" ? {} : { description: goal }),
      ...(repository === "" ? {} : { rules: `Repository: ${repository}` }),
      ...(input.model === undefined ? {} : { model: input.model }),
    },
    { id: commandId },
  )
  const result = captainOf(created, fallback)
  if (result === undefined) throw new Error("The Captain was created, but the reply could not be read.")
  return result
}

export function sendKeyFor(current: SendKey | undefined, text: string, mint: () => SendKey): SendKey {
  return current !== undefined && current.text === text ? current : mint()
}


export function captainModel<T extends ModelRef>(keyed: readonly T[], picked: string): T | undefined {
  return keyed.find((model) => `${model.provider}/${model.modelId}` === picked) ?? keyed[0]
}

export type SkipTarget = { readonly kind: "next" } | { readonly kind: "shell" }

export function skipTarget(step: 1 | 2 | 3, hasCaptain: boolean): SkipTarget | undefined {
  switch (step) {
    case 1:
      return { kind: "next" }
    case 2:
    case 3:
      return hasCaptain ? undefined : { kind: "shell" }
  }
}
