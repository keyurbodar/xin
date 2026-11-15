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

const [settledRev, setSettledRev] = createSignal(0)

/** The home's issues.rev after a burst settles: the open list or issue re-reads once per burst, not once per change. */
export const issuesRev = settledRev

/** The home snapshot's rev is global, with no per-project part, so every project's list follows it. */
export const noteIssuesRev = createTrailing(REV_SETTLE_MS, setSettledRev)

const statesFor = createStatesCache(async () => parseStates(await cmd<unknown>("issue.states")))
const lists = createRevCache<IssueList>()
const details = createRevCache<IssueScreen>()

export type IssueList = { readonly states: readonly IssueState[]; readonly issues: readonly IssueSummary[] }
export type IssueScreen = { readonly states: readonly IssueState[]; readonly detail: IssueDetail }

/** The project's open or closed issues, up to the contract's page limit, and the states they name: one read per revision, shared across remounts. */
export function projectIssueList(project: string, closed: boolean, rev: number): Promise<IssueList> {
  return lists(rev, `${closed ? "closed" : "open"}:${project}`, async () => {
    const issues = parseIssuePage(await cmd<unknown>("issue.list", { project, closed, limit: 200 }))
    return { states: await statesFor(issues.map((issue) => issue.state)), issues }
  })
}

/** Prefix search over titles and descriptions, for the link picker. */
export async function searchIssues(project: string, q: string): Promise<readonly IssueSummary[]> {
  return parseIssuePage(await cmd<unknown>("issue.list", { project, q, limit: 8 }))
}

export function issueScreen(id: number, rev: number): Promise<IssueScreen> {
  return details(rev, String(id), async () => {
    const detail = await issueDetail(id)
    const named = [detail.issue, ...detail.children, ...detail.links.blocks, ...detail.links.blockedBy, ...detail.links.related]
    return { states: await statesFor(named.map((entry) => entry.state)), detail }
  })
}

/** The issue with its newest timeline page, or the page before `before`; older pages are never cached. */
export async function issueDetail(id: number, before?: number): Promise<IssueDetail> {
  const detail = parseIssueDetail(await cmd<unknown>("issue.get", before === undefined ? { id } : { id, before }))
  if (detail === undefined) throw new Error(`Issue #${id} came back malformed`)
  return detail
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

export function linkIssue(args: Record<string, unknown>, on: boolean): Promise<Issue> {
  return issueOf(cmd<unknown>(on ? "issue.link" : "issue.unlink", args))
}

