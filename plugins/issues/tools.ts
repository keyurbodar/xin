import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, bool, int, nullable, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema"
import { type Context, OpRejected, textResult } from "../../src/kernel/index.ts"
import {
  type Assignee,
  assigneeToken,
  type IssueDetail,
  type IssueFields,
  type IssueSummary,
  type IssuesService,
  LINK_KINDS,
  PRIORITIES,
} from "./issues.ts"

export const name = "tool-issues"
export const inject = ["pi", "issues"]

const COMMENTS_SHOWN = 20
const COMMENT_CLIP = 500
const ASSIGNEE = str({ pattern: "^(person:.+|thread:\\d+|captain:\\d+)$" })

const Args = obj({
  action: oneOf(["create", "read", "update", "comment"] as const),
  id: opt(int({ minimum: 1 })),
  title: opt(str({ minLength: 1, maxLength: 300 })),
  description: opt(str()),
  state: opt(str()),
  priority: opt(oneOf(PRIORITIES)),
  due: opt(nullable(str())),
  parent: opt(nullable(int())),
  labels: opt(arr(str())),
  assignees: opt(arr(ASSIGNEE)),
  threads: opt(arr(int())),
  prs: opt(arr(str())),
  link: opt(obj({ kind: oneOf(LINK_KINDS), other: int(), remove: opt(bool()) })),
  body: opt(str({ maxLength: 20_000 })),
  replyTo: opt(int()),
  mentions: opt(arr(int())),
  q: opt(str()),
  closed: opt(bool()),
  cursor: opt(str()),
})

type ToolArgs = Static<typeof Args>

const DESCRIPTION =
  "Issues, the shared work record. create: title plus fields. read: by id, or a list by q/assignees[0]/state/closed/parent; pass the returned cursor for more. update: id plus fields to change (lists replace; null clears due/parent) and/or link {kind, other, remove}. comment: id, body, replyTo, mentions (conversation ids to wake). Assignees are person:<id>, thread:<conv> or captain:<conv>. threads[0] owns the issue and is woken by its changes."

export function apply(ctx: Context): void {
  const issues = ctx.issues
  ctx.pi.install(defineExtension({ name: "tool-issues", tools: [issueTool(issues)] }))
}

function assignee(token: string): Assignee {
  const at = token.indexOf(":")
  const kind = token.slice(0, at)
  const id = token.slice(at + 1)
  return kind === "person" ? { kind, id } : { kind: kind === "captain" ? "captain" : "thread", id: Number(id) }
}

const line = (issue: IssueSummary): string =>
  [
    `#${issue.id} [${issue.state}] ${issue.title}`,
    issue.priority === "normal" ? "" : ` (${issue.priority})`,
    issue.due === null ? "" : ` due ${issue.due}`,
    issue.parent === null ? "" : ` sub-issue of #${issue.parent}`,
    issue.assignees.length === 0 ? "" : ` → ${issue.assignees.map(assigneeToken).join(", ")}`,
  ].join("")

function full(detail: IssueDetail): string {
  const { issue } = detail
  const out = [line(issue)]
  if (issue.labels.length > 0) out.push(`labels: ${issue.labels.join(", ")}`)
  if (issue.threads.length > 0) out.push(`threads: ${issue.threads.join(", ")} (owner ${issue.threads[0]})`)
  if (issue.prs.length > 0) out.push(`PRs: ${issue.prs.join(" ")}`)
  if (issue.description !== "") out.push("", issue.description)
  for (const [label, linked] of [
    ["blocks", detail.links.blocks],
    ["blocked by", detail.links.blockedBy],
    ["related", detail.links.related],
  ] as const)
    if (linked.length > 0) out.push(`${label}: ${linked.map((other) => `#${other.id} ${other.title}`).join("; ")}`)
  if (detail.children.length > 0) out.push("sub-issues:", ...detail.children.map((child) => `- ${line(child)}`))
  const comments = detail.timeline.filter((event) => event.kind === "comment")
  const shown = comments.slice(-COMMENTS_SHOWN)
  if (shown.length > 0)
    out.push(
      comments.length > shown.length || detail.earlier !== null
        ? "latest comments (earlier ones omitted):"
        : "comments:",
      ...shown.map((event) => {
        const body = String(event.data["body"] ?? "")
        const text = body.length > COMMENT_CLIP ? `${body.slice(0, COMMENT_CLIP)}…` : body
        return `${event.replyTo === null ? "-" : "  ↳"} [${event.id}] ${event.actor}: ${text}`
      }),
    )
  return out.join("\n")
}

function fieldsOf(args: ToolArgs): IssueFields {
  const { description, state, priority, due, parent, labels, assignees, threads, prs, title } = args
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(state === undefined ? {} : { state }),
    ...(priority === undefined ? {} : { priority }),
    ...(due === undefined ? {} : { due }),
    ...(parent === undefined ? {} : { parent }),
    ...(labels === undefined ? {} : { labels }),
    ...(assignees === undefined ? {} : { assignees: assignees.map(assignee) }),
    ...(threads === undefined ? {} : { threads }),
    ...(prs === undefined ? {} : { prs }),
  }
}

async function run(issues: IssuesService, args: ToolArgs, conversationId: number): Promise<string> {
  const actor = { kind: "thread", id: conversationId } as const
  const needId = (): number => args.id ?? fail(`${args.action} needs an id`)
  switch (args.action) {
    case "create": {
      if (args.title === undefined) return fail("create needs a title")
      const { issue } = await issues.create(actor, { ...fieldsOf(args), title: args.title })
      return `Created ${line(issue)}`
    }
    case "read": {
      if (args.id !== undefined) {
        const detail = await issues.get(actor, args.id)
        return detail === undefined ? `No issue #${args.id}.` : full(detail)
      }
      const first = args.assignees?.[0]
      const page = await issues.list(actor, {
        ...(args.q === undefined ? {} : { q: args.q }),
        ...(first === undefined ? {} : { assignee: assignee(first) }),
        ...(args.state === undefined ? {} : { states: [args.state] }),
        ...(args.closed === undefined ? {} : { closed: args.closed }),
        ...(args.parent === undefined ? {} : { parent: args.parent }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        limit: 30,
      })
      const states = await issues.states()
      const legend = `states: ${states.map((state) => `${state.id}${state.closed ? " (closed)" : ""}`).join(", ")}`
      const more = page.cursor === null ? [] : [`more: cursor=${page.cursor}`]
      return [...(page.issues.length === 0 ? ["No matching issues."] : page.issues.map(line)), ...more, legend].join(
        "\n",
      )
    }
    case "update": {
      const id = needId()
      let { issue } = await issues.update(actor, id, fieldsOf(args))
      if (args.link !== undefined)
        ({ issue } = await issues.link(actor, id, args.link.kind, args.link.other, args.link.remove !== true))
      return `Updated ${line(issue)}`
    }
    case "comment": {
      const id = needId()
      if (args.body === undefined) return fail("comment needs a body")
      const { events } = await issues.comment(actor, id, {
        body: args.body,
        ...(args.replyTo === undefined ? {} : { replyTo: args.replyTo }),
        ...(args.mentions === undefined ? {} : { mentions: args.mentions }),
      })
      return `Commented on #${id} (comment ${events[0]?.id ?? "?"}).`
    }
    default: {
      const _exhaustive: never = args.action
      return _exhaustive
    }
  }
}

const fail = (message: string): never => {
  throw new OpRejected("bad_args", message)
}

function issueTool(issues: IssuesService) {
  return defineTool({
    name: "issue",
    description: DESCRIPTION,
    parameters: Args,
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        return textResult(await run(issues, args, api.conversationId))
      } catch (error) {
        if (error instanceof OpRejected) return textResult(`Not done: ${error.message}.`, { isError: true })
        throw error
      }
    },
  })
}
