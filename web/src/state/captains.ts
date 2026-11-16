import { createSignal } from "solid-js"
import { cmd, type Streams } from "../lib/api.ts"
import { numOf, recordOf } from "../lib/parse.ts"
import { parseCaptainDetail, parseCaptainProfile, parseCaptainRows, type CaptainDetail, type CaptainFields, type CaptainProfile, type CaptainRow } from "../lib/captains.ts"
import { route } from "../lib/router.ts"
import { homeProjects, type ProjectSummary, type ThreadGroups } from "./home.ts"

const [captains, setCaptains] = createSignal<readonly CaptainRow[]>([])

export const homeCaptains = captains

/** The home stream's `captains` part, live Captains only, republished after every captain op and thread change. */
export function subscribeCaptains(streams: Streams): () => void {
  return streams.subscribe("home", {
    value: (value) => setCaptains(parseCaptainRows(value)),
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
    requestsRev: space?.requestsRev ?? 0,
    spaces: [],
    ...(captain.description === "" ? {} : { goal: captain.description }),
  }
}

export async function captainDetail(id: string): Promise<CaptainDetail> {
  return parseCaptainDetail(await cmd<unknown>("captain.get", { id }))
}

export async function createCaptain(projectId: string, fields: CaptainFields & Required<Pick<CaptainFields, "model">>, commandId: string): Promise<CaptainProfile> {
  const profile = parseCaptainProfile(await cmd<unknown>("captain.create", { projectId, ...fields }, { id: commandId }))
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
export async function sideThread(conv: number, title: string, task: string, commandId: string): Promise<number> {
  const threadId = numOf(recordOf(await cmd<unknown>("thread.side", { conv, title, task }, { id: commandId }))?.threadId)
  if (threadId === undefined) throw new Error("thread.side answered without a thread id")
  return threadId
}
