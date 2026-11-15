import { isRecord, listOf, numOf, recordOf, strOf } from "./parse.ts"
import type { ThreadGroups } from "../state/home.ts"
import type { ModelRef } from "../state/settings.ts"

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

export function parseCaptainProfile(value: unknown): CaptainProfile | undefined {
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

export function parseCaptainDetail(value: unknown): CaptainDetail {
  const profile = parseCaptainProfile(value)
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

export function parseCaptainRows(value: unknown): readonly CaptainRow[] {
  return listOf(isRecord(value) ? value.captains : undefined).flatMap((entry) => {
    const profile = parseCaptainProfile(entry)
    return profile === undefined ? [] : [{ ...profile, crew: countsOf(recordOf(entry)?.crew) }]
  })
}

const REPORT_CHARS = 400

/** The crew view from the home stream's space threads, in captain.get's shape: most recently active first. */
export function crewOf(threads: ThreadGroups, now: number): readonly CrewMember[] {
  return CREW_STATUSES.flatMap((status) =>
    threads[status].map((thread): CrewMember => ({
      threadId: thread.id,
      title: thread.title,
      status,
      run: thread.run,
      idleMs: Math.max(0, now - (thread.beatAt ?? now)),
      ...(thread.statusLine === undefined ? {} : { statusLine: thread.statusLine }),
      ...(thread.result === undefined ? {} : { report: thread.result.slice(0, REPORT_CHARS) }),
    })),
  ).toSorted((left, right) => left.idleMs - right.idleMs)
}

export const modelKey = (model: ModelRef): string => `${model.provider}/${model.modelId}`

/** A new Captain starts on the model picked, else on its project coordinator's; undefined means Create waits for a pick. */
export function captainModel(picked: string, coordinator: ModelRef | undefined): ModelRef | undefined {
  const cut = picked.indexOf("/")
  if (cut > 0) return { provider: picked.slice(0, cut), modelId: picked.slice(cut + 1) }
  return coordinator
}

/** A side thread runs on its parent's model, so a conversation without one cannot fork. */
export function offersSideThread(model: ModelRef | null | undefined): boolean {
  return model !== null && model !== undefined
}
