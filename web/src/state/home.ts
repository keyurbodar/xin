import { createSignal } from "solid-js"
import type { Streams } from "../lib/api.ts"
import { automationsRevisionOf } from "../lib/automations.ts"
import { trailing } from "../lib/trailing.ts"
import { isRecord, listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { route } from "../lib/router.ts"
import { threadsOf } from "../lib/threads.ts"
import { parseRequestList, type RequestRow } from "./conversation.ts"

export type ThreadSummary = {
  readonly id: number
  readonly title: string
  readonly role?: string
  readonly status: string
  readonly run: number
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

export type SpaceSummary = {
  readonly id: string
  readonly coordinatorId: number
  readonly threads: ThreadGroups
  readonly openRequests: number
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
  readonly spaces: readonly SpaceSummary[]
}

const [projects, setProjects] = createSignal<readonly ProjectSummary[]>([])
const [requests, setRequests] = createSignal<readonly RequestRow[]>([])
const [loaded, setLoaded] = createSignal(false)
const [automationsRevision, setAutomationsRevision] = createSignal<number>()

/** Home frames re-send the same revision for unrelated changes; only a new value arms the reload, and a burst of them coalesces. */
let latestRevision: number | undefined
const settleRevision = trailing(() => setAutomationsRevision(latestRevision), { wait: 275, maxWait: 1000 })

function receiveRevision(next: number | undefined): void {
  if (next === latestRevision) return
  const first = latestRevision === undefined
  latestRevision = next
  if (first) setAutomationsRevision(next)
  else settleRevision.poke()
}

export const homeProjects = projects
export const homeLoaded = loaded
export const homeRequests = requests
export const homeAutomationsRevision = automationsRevision

function groupsOf(value: unknown): ThreadGroups {
  const record = recordOf(value) ?? {}
  return {
    working: threadsOf(record.working),
    waiting: threadsOf(record.waiting),
    completed: threadsOf(record.completed),
    failed: threadsOf(record.failed),
    cancelled: threadsOf(record.cancelled),
  }
}

function spacesOf(value: unknown): readonly SpaceSummary[] {
  return listOf(value).flatMap((entry) => {
    const record = recordOf(entry)
    const id = strOf(record?.id)
    const coordinatorId = numOf(record?.coordinatorId)
    if (record === undefined || id === undefined || coordinatorId === undefined || record.archived === true) return []
    return [{ id, coordinatorId, threads: groupsOf(record.threads), openRequests: numOf(record.openRequests) ?? 0 }]
  })
}

function projectOf(value: unknown): ProjectSummary | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const id = strOf(record.id)
  const name = strOf(record.name)
  const coordinatorId = numOf(record.coordinatorId)
  if (id === undefined || name === undefined || coordinatorId === undefined) return undefined
  const slug = strOf(record.slug)
  const goal = strOf(record.goal)
  return {
    id,
    name,
    coordinatorId,
    slug: slug ?? id,
    archived: record.archived === true,
    threads: groupsOf(record.threads),
    openRequests: numOf(record.openRequests) ?? 0,
    spaces: spacesOf(record.spaces),
    ...(goal === undefined ? {} : { goal }),
  }
}

function parse(value: unknown): readonly ProjectSummary[] {
  return listOf(isRecord(value) ? value.projects : undefined).flatMap((entry) => {
    const project = projectOf(entry)
    return project === undefined ? [] : [project]
  })
}

export function subscribeHome(streams: Streams): () => void {
  return streams.subscribe("home", {
    value: (value) => {
      setProjects(parse(value))
      setRequests(parseRequestList(value))
      receiveRevision(automationsRevisionOf(value))
      setLoaded(true)
    },
    delta: () => undefined,
  })
}

export function activeProjects(): readonly ProjectSummary[] {
  return projects().filter((project) => !project.archived)
}

export function projectThreads(project: { readonly threads: ThreadGroups }): readonly ThreadSummary[] {
  const groups = project.threads
  return [...groups.working, ...groups.waiting, ...groups.failed, ...groups.completed, ...groups.cancelled]
}

/** The project the address names, or the first live one on the home route. */
export function routeProject(): ProjectSummary | undefined {
  const parts = route().parts
  if (parts[0] === undefined || parts[0] === "new") return activeProjects()[0]
  if (parts[0] !== "p") return undefined
  return projects().find((project) => project.slug === parts[1])
}

/** The thread tab the address names: #/p/<slug>/t/<id>. */
export function routeThreadId(): number | undefined {
  const parts = route().parts
  if (parts[0] !== "p" || parts[2] !== "t") return undefined
  const id = Number(parts[3])
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined
}
