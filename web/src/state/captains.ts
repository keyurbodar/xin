import { createSignal } from "solid-js"
import { cmd, type Streams } from "../lib/api.ts"
import { isRecord, listOf, numOf, recordOf, strOf } from "../lib/parse.ts"
import { route } from "../lib/router.ts"
import type { ModelRef } from "./settings.ts"
import { homeProjects, type ProjectSummary, type ThreadGroups } from "./home.ts"

export type CrewCounts = { readonly total: number; readonly working: number; readonly waiting: number; readonly failed: number }

export type CaptainProfile = {
  readonly id: string
  readonly name: string
  readonly alias: string
  readonly avatarSeed: string
  readonly description: string
  readonly projectId: string
  readonly spaceId: string
  readonly coordinatorId: number
  readonly archived: boolean
  readonly createdAt: number
}

export type CaptainRow = CaptainProfile & { readonly crew: CrewCounts }

export type CrewStatus = "working" | "waiting" | "completed" | "failed" | "cancelled"

export type CrewMember = {
  readonly threadId: number
  readonly title: string
  readonly status: CrewStatus
  readonly run: number
  readonly idleMs: number
  readonly statusLine?: string
  readonly report?: string
}

export type CaptainDetail = CaptainProfile & {
  readonly model: ModelRef | null
  readonly notes: string
  readonly rules: string
  readonly crewRules: string
  readonly crew: readonly CrewMember[]
}

export type CaptainFields = {
  readonly name: string
  readonly alias?: string
  readonly description?: string
  readonly model?: ModelRef
  readonly rules?: string
  readonly crewRules?: string
}

const CREW_STATUSES: readonly CrewStatus[] = ["working", "waiting", "completed", "failed", "cancelled"]

function profileOf(value: unknown): CaptainProfile | undefined {
  const record = recordOf(value)
  const id = strOf(record?.id)
  const name = strOf(record?.name)
  const alias = strOf(record?.alias)
  const projectId = strOf(record?.projectId)
  const spaceId = strOf(record?.spaceId)
  const coordinatorId = numOf(record?.coordinatorId)
  if (
    record === undefined ||
    id === undefined ||
    name === undefined ||
    alias === undefined ||
    projectId === undefined ||
    spaceId === undefined ||
    coordinatorId === undefined
  )
    return undefined
  return {
    id,
    name,
    alias,
    projectId,
    spaceId,
    coordinatorId,
    avatarSeed: strOf(record.avatarSeed) ?? alias,
    description: strOf(record.description) ?? "",
    archived: record.archived === true,
    createdAt: numOf(record.createdAt) ?? 0,
  }
}

function countsOf(value: unknown): CrewCounts {
  const record = recordOf(value)
  return {
    total: numOf(record?.total) ?? 0,
    working: numOf(record?.working) ?? 0,
    waiting: numOf(record?.waiting) ?? 0,
    failed: numOf(record?.failed) ?? 0,
  }
}

function memberOf(value: unknown): CrewMember | undefined {
  const record = recordOf(value)
  const threadId = numOf(record?.threadId)
  const title = strOf(record?.title)
  const status = CREW_STATUSES.find((entry) => entry === record?.status)
  if (record === undefined || threadId === undefined || title === undefined || status === undefined) return undefined
  const statusLine = strOf(record.statusLine)
  const report = strOf(record.report)
  return {
    threadId,
    title,
    status,
    run: numOf(record.run) ?? 1,
    idleMs: numOf(record.idleMs) ?? 0,
    ...(statusLine === undefined ? {} : { statusLine }),
    ...(report === undefined ? {} : { report }),
  }
}

function modelOf(value: unknown): ModelRef | null {
  const record = recordOf(value)
  const provider = strOf(record?.provider)
  const modelId = strOf(record?.modelId)
  return provider === undefined || modelId === undefined ? null : { provider, modelId }
}

function detailOf(value: unknown): CaptainDetail {
  const profile = profileOf(value)
  const record = recordOf(value)
  if (profile === undefined || record === undefined) throw new Error("captain.get answered without a Captain")
  return {
    ...profile,
    model: modelOf(record.model),
    notes: strOf(record.notes) ?? "",
    rules: strOf(record.rules) ?? "",
    crewRules: strOf(record.crewRules) ?? "",
    crew: listOf(record.crew).flatMap((entry) => {
      const member = memberOf(entry)
      return member === undefined ? [] : [member]
    }),
  }
}

function rowsOf(value: unknown): readonly CaptainRow[] {
  return listOf(isRecord(value) ? value.captains : undefined).flatMap((entry) => {
    const profile = profileOf(entry)
    return profile === undefined ? [] : [{ ...profile, crew: countsOf(recordOf(entry)?.crew) }]
  })
}

const [captains, setCaptains] = createSignal<readonly CaptainRow[]>([])

export const homeCaptains = captains

/** The home stream's `captains` part, live Captains only, republished after every captain op and thread change. */
export function subscribeCaptains(streams: Streams): () => void {
  return streams.subscribe("home", {
    value: (value) => setCaptains(rowsOf(value)),
    delta: () => undefined,
  })
}

/** The Captain the address names: #/c/<alias>. */
export function routeCaptain(): CaptainRow | undefined {
  const parts = route().parts
  if (parts[0] !== "c") return undefined
  return captains().find((captain) => captain.alias === parts[1])
}

/** The crew thread the address names: #/c/<alias>/t/<id>. */
export function routeCrewThreadId(): number | undefined {
  const parts = route().parts
  if (parts[0] !== "c" || parts[2] !== "t") return undefined
  const id = Number(parts[3])
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined
}

const NO_THREADS: ThreadGroups = { working: [], waiting: [], completed: [], failed: [], cancelled: [] }

/**
 * The Captain's space in the shape the chat, tabs and pane already read. Its id is the space id, so tab state
 * and thread lists stay apart from the project's own; the slug stays the project's, so files resolve there.
 */
export function captainSpace(captain: CaptainProfile): ProjectSummary | undefined {
  const project = homeProjects().find((entry) => entry.id === captain.projectId)
  if (project === undefined) return undefined
  const space = project.spaces.find((entry) => entry.id === captain.spaceId)
  return {
    id: captain.spaceId,
    slug: project.slug,
    name: captain.name,
    archived: captain.archived,
    coordinatorId: captain.coordinatorId,
    threads: space?.threads ?? NO_THREADS,
    openRequests: space?.openRequests ?? 0,
    spaces: [],
    ...(captain.description === "" ? {} : { goal: captain.description }),
  }
}

export async function captainDetail(id: string): Promise<CaptainDetail> {
  return detailOf(await cmd<unknown>("captain.get", { id }))
}

export async function createCaptain(projectId: string, fields: CaptainFields, commandId: string): Promise<CaptainProfile> {
  const profile = profileOf(await cmd<unknown>("captain.create", { projectId, ...fields }, { id: commandId }))
  if (profile === undefined) throw new Error("captain.create answered without a Captain")
  return profile
}

export async function updateCaptain(id: string, fields: Partial<CaptainFields>): Promise<void> {
  await cmd("captain.update", { id, ...fields })
}

export async function archiveCaptain(id: string): Promise<void> {
  await cmd("captain.archive", { id })
}

export async function addToCrew(id: string, threadId: number): Promise<void> {
  await cmd("captain.crew.add", { id, threadId })
}

export async function removeFromCrew(id: string, threadId: number): Promise<void> {
  await cmd("captain.crew.remove", { id, threadId })
}

/** thread.side forks a coordinator or a Captain at its newest entry into a thread in the same space. */
export async function sideThread(conv: number, title: string, task: string): Promise<number> {
  const threadId = numOf(recordOf(await cmd<unknown>("thread.side", { conv, title, task }))?.threadId)
  if (threadId === undefined) throw new Error("thread.side answered without a thread id")
  return threadId
}
