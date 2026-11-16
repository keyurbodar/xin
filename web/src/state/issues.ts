import { createSignal } from "solid-js"
import { cmd } from "../lib/api.ts"
import { createRevCache, createStatesCache, createTrailing } from "../lib/issue-cache.ts"
import {
  parseIssue,
  parseIssueDetail,
  parseIssuePage,
  parseStates,
  type Issue,
  type IssueDetail,
  type IssueState,
  type IssueSummary,
} from "../lib/issues.ts"

const REV_SETTLE_MS = 275
const REV_MAX_WAIT_MS = 1_000

const [settledRev, setSettledRev] = createSignal(0)

/** The home's issues.rev after a burst settles: the open list or issue re-reads once per burst, not once per change. */
export const issuesRev = settledRev

/**
 * Every home frame passes its rev here; only a moved rev re-arms the settle, and a steady stream still settles once a
 * second. The rev is global, with no per-project part, so every project's list follows it.
 */
export const noteIssuesRev = createTrailing(REV_SETTLE_MS, REV_MAX_WAIT_MS, setSettledRev)

const [statesRevSignal, setStatesRev] = createSignal<number | undefined>(undefined)

/** The home's `issues.statesRev`: the open list or issue reads the states again when it moves. */
export const statesRev = statesRevSignal

export function noteStatesRev(rev: number | undefined): void {
  setStatesRev(rev)
}

const statesFor = createStatesCache(async () => parseStates(await cmd<unknown>("issue.states")))
const lists = createRevCache<readonly IssueSummary[]>()
const details = createRevCache<IssueDetail>()

export type IssueList = { readonly states: readonly IssueState[]; readonly issues: readonly IssueSummary[] }
export type IssueScreen = { readonly states: readonly IssueState[]; readonly detail: IssueDetail }

/**
 * The project's open issues, up to the contract's page limit, read once per issues revision and shared across
 * remounts, with the states read once per states revision.
 */
export async function projectIssueList(project: string, rev: number, states: number | undefined): Promise<IssueList> {
  const issues = lists(rev, project, async () =>
    parseIssuePage(await cmd<unknown>("issue.list", { project, closed: false, limit: 200 })),
  )
  return { states: await statesFor(states, issues.then((list) => list.map((issue) => issue.state))), issues: await issues }
}

export async function issueScreen(id: number, rev: number, states: number | undefined): Promise<IssueScreen> {
  const detail = details(rev, String(id), async () => {
    const parsed = parseIssueDetail(await cmd<unknown>("issue.get", { id }))
    if (parsed === undefined) throw new Error(`Issue #${id} came back malformed`)
    return parsed
  })
  const named = detail.then((found) =>
    [found.issue, ...found.children, ...found.links.blocks, ...found.links.blockedBy, ...found.links.related].map((entry) => entry.state),
  )
  return { states: await statesFor(states, named), detail: await detail }
}

async function issueOf(result: Promise<unknown>): Promise<Issue> {
  const issue = parseIssue(await result)
  if (issue === undefined) throw new Error("The issue came back malformed")
  return issue
}

export function createIssue(args: Record<string, unknown>): Promise<Issue> {
  return issueOf(cmd<unknown>("issue.create", args))
}

export function updateIssue(id: number, fields: Record<string, unknown>): Promise<Issue> {
  return issueOf(cmd<unknown>("issue.update", { id, ...fields }))
}

export async function commentOnIssue(id: number, body: string): Promise<void> {
  await cmd<unknown>("issue.comment", { id, body })
}
