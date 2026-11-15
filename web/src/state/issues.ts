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
 * second. The rev is global, with no per-project part and no states revision, so every project's list follows it.
 */
export const noteIssuesRev = createTrailing(REV_SETTLE_MS, REV_MAX_WAIT_MS, setSettledRev)

const statesFor = createStatesCache(async () => parseStates(await cmd<unknown>("issue.states")))
const lists = createRevCache<IssueList>()
const details = createRevCache<IssueScreen>()

export type IssueList = { readonly states: readonly IssueState[]; readonly issues: readonly IssueSummary[] }
export type IssueScreen = { readonly states: readonly IssueState[]; readonly detail: IssueDetail }

/**
 * The project's open issues, up to the contract's page limit, and the states, read side by side: one pair of reads per
 * revision, shared across remounts. The client has no batched command, so the states are a second read.
 */
export function projectIssueList(project: string, rev: number): Promise<IssueList> {
  return lists(rev, project, async () => {
    const issues = cmd<unknown>("issue.list", { project, closed: false, limit: 200 }).then(parseIssuePage)
    const states = statesFor(rev, issues.then((list) => list.map((issue) => issue.state)))
    return { states: await states, issues: await issues }
  })
}

export function issueScreen(id: number, rev: number): Promise<IssueScreen> {
  return details(rev, String(id), async () => {
    const detail = cmd<unknown>("issue.get", { id }).then((value) => {
      const parsed = parseIssueDetail(value)
      if (parsed === undefined) throw new Error(`Issue #${id} came back malformed`)
      return parsed
    })
    const states = statesFor(
      rev,
      detail.then((found) =>
        [found.issue, ...found.children, ...found.links.blocks, ...found.links.blockedBy, ...found.links.related].map((entry) => entry.state),
      ),
    )
    return { states: await states, detail: await detail }
  })
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
