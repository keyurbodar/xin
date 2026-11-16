import { createResource, type Resource } from "solid-js"
import { cmd } from "../lib/api.ts"
import { keepUnchanged, parseAutomationList, type Automation } from "../lib/automations.ts"
import { homeAutomationsRevision, homeLoaded } from "./home.ts"

/**
 * `automation.list` once for the view, then again only when the home snapshot's `automations.revision` moves.
 * Actions never reload by hand: every create, update, delete, run start and run finish bumps the revision.
 */
export function createAutomationList(): readonly [Resource<readonly Automation[]>, () => void] {
  const [list, { refetch }] = createResource<readonly Automation[], number | false>(
    () => (homeLoaded() ? (homeAutomationsRevision() ?? 0) : false),
    async (_, { value }) => keepUnchanged(value, parseAutomationList(await cmd("automation.list", {}))),
  )
  return [list, () => void refetch()]
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
