import { createSignal } from "solid-js"
import { cmd, OpError } from "../lib/api.ts"
import { parseRequestList, type RequestRow } from "./conversation.ts"
import { activeProjects, type ProjectSummary, type ThreadSummary } from "./home.ts"

export type InboxQuestion = RequestRow

export type InboxSource = "loading" | "requests" | "threads" | "error"

export type InboxItem =
  | {
      readonly kind: "question"
      readonly question: InboxQuestion
      readonly projectName: string | undefined
      readonly threadTitle: string | undefined
      readonly projectSlug: string | undefined
    }
  | {
      readonly kind: "thread"
      readonly thread: ThreadSummary
      readonly project: ProjectSummary
      readonly state: "waiting" | "failed"
    }

export type InboxGroup = {
  readonly id: string
  readonly name: string
  readonly items: readonly InboxItem[]
}

const [questions, setQuestions] = createSignal<readonly InboxQuestion[]>([])
const [source, setSource] = createSignal<InboxSource>("loading")
const [failure, setFailure] = createSignal<string | undefined>(undefined)

export const inboxSource = source
export const inboxFailure = failure
export const openRequests = questions

let pending: Promise<void> | undefined

async function fetchQuestions(): Promise<void> {
  try {
    const result = await cmd<unknown>("request.list", {})
    setQuestions(parseRequestList(result))
    setSource("requests")
    setFailure(undefined)
  } catch (problem) {
    if (problem instanceof OpError && problem.code === "unknown_op") {
      setQuestions([])
      setSource("threads")
      setFailure(undefined)
      return
    }
    setSource("error")
    setFailure(problem instanceof Error ? problem.message : "The inbox could not load")
  }
}

export function refreshRequests(): Promise<void> {
  if (pending !== undefined) return pending
  pending = fetchQuestions().finally(() => {
    pending = undefined
  })
  return pending
}

export function loadRequests(): void {
  void refreshRequests()
}

export async function respondToQuestion(question: InboxQuestion, answer: string): Promise<void> {
  await cmd("request.respond", { threadId: question.conversationId, requestId: question.id, answer })
  setQuestions((current) => current.filter((entry) => entry.id !== question.id))
  void refreshRequests()
}

export async function retryThread(threadId: number): Promise<void> {
  await cmd("thread.send", { threadId, text: "Retry the failed run.", mode: "queue" })
}

function threadIndex(
  projects: readonly ProjectSummary[],
): ReadonlyMap<number, { readonly project: ProjectSummary; readonly thread: ThreadSummary }> {
  const index = new Map<number, { readonly project: ProjectSummary; readonly thread: ThreadSummary }>()
  for (const project of projects) {
    const threads = [
      ...project.threads.working,
      ...project.threads.waiting,
      ...project.threads.completed,
      ...project.threads.failed,
      ...project.threads.cancelled,
    ]
    for (const thread of threads) index.set(thread.id, { project, thread })
  }
  return index
}

function at(item: InboxItem): number {
  return item.kind === "question" ? item.question.askedAt : (item.thread.beatAt ?? 0)
}

function newest(group: InboxGroup): number {
  const first = group.items[0]
  return first === undefined ? 0 : at(first)
}

type Bucket = { readonly id: string; readonly name: string; readonly items: InboxItem[] }

export function inboxGroups(): readonly InboxGroup[] {
  const projects = activeProjects()
  const index = threadIndex(projects)
  const buckets = new Map<string, Bucket>()

  const add = (project: ProjectSummary | undefined, projectName: string | undefined, item: InboxItem): void => {
    const id = project?.id ?? (projectName === undefined ? "elsewhere" : `name:${projectName}`)
    const fresh: Bucket = { id, name: project?.name ?? projectName ?? "Elsewhere", items: [] }
    const bucket = buckets.get(id) ?? fresh
    bucket.items.push(item)
    buckets.set(id, bucket)
  }

  if (source() === "requests") {
    const asked = new Set<number>()
    for (const question of questions()) {
      asked.add(question.conversationId)
      const known = index.get(question.conversationId)
      const project =
        (question.projectId === undefined ? undefined : projects.find((entry) => entry.id === question.projectId)) ??
        known?.project
      add(project, question.projectName, {
        kind: "question",
        question,
        projectName: project?.name ?? question.projectName,
        threadTitle: question.threadTitle ?? known?.thread.title,
        projectSlug: project?.slug,
      })
    }
    for (const project of projects) {
      for (const thread of project.threads.waiting) {
        if (asked.has(thread.id)) continue
        add(project, undefined, { kind: "thread", thread, project, state: "waiting" })
      }
    }
  } else if (source() === "threads") {
    for (const project of projects) {
      for (const thread of project.threads.waiting) add(project, undefined, { kind: "thread", thread, project, state: "waiting" })
    }
  }

  for (const project of projects) {
    for (const thread of project.threads.failed) add(project, undefined, { kind: "thread", thread, project, state: "failed" })
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, items: bucket.items.sort((left, right) => at(right) - at(left)) }))
    .sort((left, right) => newest(right) - newest(left))
}
