import { createSignal } from "solid-js"
import type { Streams } from "../lib/api.ts"
import { isRecord, listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { route } from "../lib/router.ts"
import { parseRequestList, type RequestRow } from "./conversation.ts"

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

const [projects, setProjects] = createSignal<readonly ProjectSummary[]>([])
const [requests, setRequests] = createSignal<readonly RequestRow[]>([])
const [loaded, setLoaded] = createSignal(false)
const [plugins, setPlugins] = createSignal<Readonly<Record<string, string>>>({})

export const homeProjects = projects
export const homeLoaded = loaded
export const homePlugins = plugins
export const homeRequests = requests

function threadsOf(value: unknown): readonly ThreadSummary[] {
  return listOf(value).flatMap((entry) => {
    const record = recordOf(entry)
    const id = numOf(record?.id)
    const title = strOf(record?.title)
    const status = strOf(record?.status)
    if (record === undefined || id === undefined || title === undefined || status === undefined) return []
    const role = strOf(record.role)
    const statusLine = strOf(record.statusLine)
    const result = strOf(record.result)
    const beatAt = numOf(record.beatAt)
    const deadlineAt = numOf(record.deadlineAt)
    return [
      {
        id,
        title,
        status,
        ...(role === undefined ? {} : { role }),
        ...(statusLine === undefined ? {} : { statusLine }),
        ...(result === undefined ? {} : { result }),
        ...(beatAt === undefined ? {} : { beatAt }),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      },
    ]
  })
}

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
    ...(goal === undefined ? {} : { goal }),
  }
}

function parse(value: unknown): readonly ProjectSummary[] {
  return listOf(isRecord(value) ? value.projects : undefined).flatMap((entry) => {
    const project = projectOf(entry)
    return project === undefined ? [] : [project]
  })
}

function pluginStates(value: unknown): Readonly<Record<string, string>> {
  const record = recordOf(value) ?? {}
  return Object.fromEntries(Object.entries(record).flatMap(([row, state]) => (typeof state === "string" ? [[row, state]] : [])))
}

export function subscribeHome(streams: Streams): () => void {
  return streams.subscribe("home", {
    value: (value) => {
      setProjects(parse(value))
      setPlugins(isRecord(value) ? pluginStates(value.plugins) : {})
      setRequests(parseRequestList(value))
      setLoaded(true)
    },
    delta: () => undefined,
  })
}

export function activeProjects(): readonly ProjectSummary[] {
  return projects().filter((project) => !project.archived)
}

export function projectThreads(project: ProjectSummary): readonly ThreadSummary[] {
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
