import { cmd } from "../lib/api.ts"
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

let states: Promise<readonly IssueState[]> | undefined

/** States are organization-wide and change only through Settings, so one read serves the whole session. */
export function issueStates(): Promise<readonly IssueState[]> {
  states ??= cmd<unknown>("issue.states").then(parseStates)
  states.catch(() => {
    states = undefined
  })
  return states
}

/** The project's open or closed issues, up to the contract's page limit: one read per screen and per home revision. */
export async function projectIssues(project: string, closed: boolean): Promise<readonly IssueSummary[]> {
  return parseIssuePage(await cmd<unknown>("issue.list", { project, closed, limit: 200 }))
}

/** Prefix search over titles and descriptions, for the link picker. */
export async function searchIssues(project: string, q: string): Promise<readonly IssueSummary[]> {
  return parseIssuePage(await cmd<unknown>("issue.list", { project, q, limit: 8 }))
}

/** The issue with its newest timeline page, or the page before `before`. */
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

