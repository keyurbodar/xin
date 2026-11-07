import { createSignal } from "solid-js"
import type { Streams } from "../lib/api.ts"

export type ThreadSummary = {
  readonly id: number
  readonly title: string
  readonly role?: string
  readonly status: string
  readonly statusLine?: string
  readonly result?: string
  readonly beatAt?: number
  readonly deadlineAt?: number
}

export type ThreadGroups = {
  readonly working: readonly ThreadSummary[]
  readonly waiting: readonly ThreadSummary[]
  readonly completed: readonly ThreadSummary[]
  readonly failed: readonly ThreadSummary[]
  readonly cancelled: readonly ThreadSummary[]
}

export type ProjectSummary = {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly goal?: string
  readonly archived: boolean
  readonly coordinatorId: number
  readonly threads: ThreadGroups
  readonly openRequests: number
}

export type HomeSnapshot = { readonly projects: readonly ProjectSummary[] }

const [projects, setProjects] = createSignal<readonly ProjectSummary[]>([])
const [loaded, setLoaded] = createSignal(false)

export const homeProjects = projects
export const homeLoaded = loaded

function parse(value: unknown): readonly ProjectSummary[] {
  if (typeof value !== "object" || value === null) return []
  const list = Reflect.get(value, "projects")
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is ProjectSummary => {
    if (typeof entry !== "object" || entry === null) return false
    return typeof Reflect.get(entry, "id") === "string" && typeof Reflect.get(entry, "name") === "string"
  })
}

export function subscribeHome(streams: Streams): () => void {
  return streams.subscribe("home", {
    value: (value) => {
      setProjects(parse(value))
      setLoaded(true)
    },
    delta: () => undefined,
  })
}

export function activeProjects(): readonly ProjectSummary[] {
  return projects().filter((project) => !project.archived)
}

export function counts(): { waiting: number; working: number; finished: number; failed: number } {
  let waiting = 0
  let working = 0
  let finished = 0
  let failed = 0
  for (const project of activeProjects()) {
    waiting += project.threads.waiting.length + project.openRequests
    working += project.threads.working.length
    finished += project.threads.completed.length
    failed += project.threads.failed.length
  }
  return { waiting, working, finished, failed }
}
