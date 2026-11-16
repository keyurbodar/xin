import { createEffect, createMemo, createResource, createSignal, on, type Accessor, type Resource } from "solid-js"
import { cmd } from "../lib/api.ts"
import {
  keepUnchanged,
  mergeRuns,
  parseAutomationDetail,
  parseAutomationList,
  parseRuns,
  type Automation,
  type AutomationDetail,
  type AutomationRun,
} from "../lib/automations.ts"
import { automationTouched, homeAutomationsRevision, homeLoaded } from "./home.ts"

/**
 * `automation.list` once for the view, then again only when the home snapshot's `automations.revision` moves.
 * Actions never reload by hand: every create, update, delete, run start and run finish bumps the revision.
 */
export type AutomationList = {
  readonly list: Resource<readonly Automation[]>
  readonly value: Accessor<readonly Automation[] | undefined>
  readonly retry: () => void
}

/** A resource that failed before it ever loaded throws when read, so views read `value`, which is undefined then. */
const settled = <T,>(resource: Resource<T>): T | undefined => (resource.error === undefined ? resource.latest : undefined)

export function createAutomationList(): AutomationList {
  const [list, { refetch }] = createResource<readonly Automation[], number | false>(
    () => (homeLoaded() ? (homeAutomationsRevision() ?? 0) : false),
    async (_, { value }) => keepUnchanged(value, parseAutomationList(await cmd("automation.list", {}))),
  )
  return { list, value: () => settled(list), retry: () => void refetch() }
}

export function setAutomationEnabled(id: string, enabled: boolean): Promise<unknown> {
  return cmd("automation.update", { id, enabled })
}

export function deleteAutomation(id: string): Promise<unknown> {
  return cmd("automation.delete", { id })
}

export function createAutomation(args: Record<string, unknown>, commandId: string): Promise<unknown> {
  return cmd("automation.create", args, { id: commandId })
}

export function updateAutomation(args: Record<string, unknown>, commandId: string): Promise<unknown> {
  return cmd("automation.update", args, { id: commandId })
}

export function runAutomation(args: Record<string, unknown>, commandId: string): Promise<unknown> {
  return cmd("automation.trigger", args, { id: commandId })
}

const PAGE = 20

export type AutomationHistory = {
  readonly detail: Resource<AutomationDetail | undefined>
  readonly value: Accessor<AutomationDetail | undefined>
  readonly runs: Accessor<readonly AutomationRun[]>
  readonly hasOlder: Accessor<boolean>
  readonly loadingOlder: Accessor<boolean>
  readonly olderFailed: Accessor<string | undefined>
  readonly loadOlder: () => Promise<void>
  readonly retry: () => void
}

/**
 * `automation.get` with the newest runs and open batches, reloaded only when this automation's own revision
 * (`automations.touched[id]` in the home snapshot) moves, so other automations' changes and runs cost it nothing.
 * Older pages come from `automation.runs` and stay merged under every reload until the id changes.
 */
export function createAutomationHistory(id: Accessor<string>): AutomationHistory {
  const [detail, { refetch }] = createResource(
    () => (homeLoaded() ? `${automationTouched(id()) ?? 0}:${id()}` : false),
    async () => parseAutomationDetail(await cmd("automation.get", { id: id(), runs: PAGE })),
  )
  const [older, setOlder] = createSignal<readonly AutomationRun[]>([])
  const [olderEnded, setOlderEnded] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [olderFailed, setOlderFailed] = createSignal<string>()
  createEffect(
    on(id, () => {
      setOlder([])
      setOlderEnded(false)
      setOlderFailed(undefined)
    }),
  )

  const value = (): AutomationDetail | undefined => settled(detail)
  const runs = createMemo(() => mergeRuns(value()?.runs ?? [], older()))
  const hasOlder = (): boolean => (older().length === 0 ? (value()?.runs.length ?? 0) >= PAGE : !olderEnded())

  const loadOlder = async (): Promise<void> => {
    const last = runs()[runs().length - 1]
    if (last === undefined || loadingOlder()) return
    const current = id()
    setLoadingOlder(true)
    setOlderFailed(undefined)
    try {
      const page = parseRuns(await cmd("automation.runs", { id: current, limit: PAGE, before: last.createdAt }))
      if (current !== id()) return
      setOlder((loaded) => mergeRuns(loaded, page))
      setOlderEnded(page.length < PAGE)
    } catch (problem) {
      setOlderFailed(problem instanceof Error ? problem.message : "Could not load older runs")
    } finally {
      setLoadingOlder(false)
    }
  }

  return { detail, value, runs, hasOlder, loadingOlder, olderFailed, loadOlder, retry: () => void refetch() }
}
