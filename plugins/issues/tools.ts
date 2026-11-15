import type { JsonValue } from "@earendil-works/chord"
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable"
import {
  arr,
  bool,
  compile,
  int,
  nullable,
  obj,
  oneOf,
  opt,
  type Static,
  str,
  unknown,
} from "@earendil-works/pi-schema"
import type { CommandId } from "../../src/ids.ts"
import { type Actor, type Command, type Context, OpRejected, type Outcome, textResult } from "../../src/kernel/index.ts"
import {
  type Assignee,
  assigneeToken,
  type IssueDetail,
  type IssueFields,
  type IssueSummary,
  type Issue,
  type IssuesService,
  LINK_KINDS,
  PRIORITIES,
} from "./issues.ts"

export const name = "tool-issues"
export const inject = ["pi", "issues", "ops"]

const COMMENTS_SHOWN = 20
const COMMENT_CLIP = 500
const ACTIONS = ["create", "read", "update"] as const

const Inner = obj({
  action: oneOf(ACTIONS),
  id: opt(int()),
  title: opt(str()),
  description: opt(str()),
  state: opt(str()),
  priority: opt(oneOf(PRIORITIES)),
  due: opt(nullable(str())),
  parent: opt(nullable(int())),
  labels: opt(arr(str())),
  assignees: opt(arr(str())),
  threads: opt(arr(int())),
  prs: opt(arr(str())),
  link: opt(obj({ kind: oneOf(LINK_KINDS), other: int(), remove: opt(bool()) })),
  q: opt(str()),
  closed: opt(bool()),
  cursor: opt(str()),
})

type ToolArgs = Static<typeof Inner>

const checkInner = compile(Inner)

const Args = obj({ action: oneOf(ACTIONS), id: opt(int()), with: opt(unknown()) })

const DESCRIPTION =
  "Shared work record. with: create/update {title,description,state,priority,due,parent,labels,assignees,threads,prs,link:{kind:blocks|blocked_by|related,other,remove}}; read without id {q,state,closed,parent,assignees:[one],cursor}. Lists replace, null clears due/parent. assignees: person:<id>|thread:<conv>|captain:<conv>. threads[0] owns it."

export const fail = (message: string): never => {
  throw new OpRejected("bad_args", message)
}

export async function refusing(work: () => Promise<string>) {
  try {
    return textResult(await work())
  } catch (error) {
    if (error instanceof OpRejected) return textResult(`Not done: ${error.message}.`, { isError: true })
    throw error
  }
}

export type IssueToolPort = {
  readonly issues: IssuesService
  run(command: Command, actor: Actor): Promise<Outcome>
}

export function apply(ctx: Context): void {
  const port: IssueToolPort = { issues: ctx.issues, run: (command, actor) => ctx.ops.run(command, actor) }
  ctx.pi.install(defineExtension({ name: "tool-issues", tools: [issueTool(port)] }))
}

/** Runs an issue write op keyed by the tool call's task, so a replayed call returns the first call's receipt. */
export async function write(
  port: IssueToolPort,
  api: ToolExecutionApi,
  op: string,
  args: JsonValue,
  step = "",
): Promise<JsonValue> {
  const outcome = await port.run(
    { id: `${op}:${api.taskId}${step}` as CommandId, op, args },
    { kind: "agent", conversationId: api.conversationId },
  )
  if (outcome.kind !== "ok") return fail(outcome.message)
  return outcome.result
}

const issueOf = (result: JsonValue): Issue => result as unknown as Issue

function assignee(token: string): Assignee {
  const at = token.indexOf(":")
  const kind = token.slice(0, at)
  const id = token.slice(at + 1)
  if (kind === "person" && id !== "") return { kind, id }
  if ((kind === "thread" || kind === "captain") && /^\d+$/.test(id)) return { kind, id: Number(id) }
  return fail(`assignee ${token} is not person:<id>, thread:<conv> or captain:<conv>`)
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

async function run(port: IssueToolPort, args: ToolArgs, api: ToolExecutionApi): Promise<string> {
  const { issues } = port
  const actor = { kind: "thread", id: api.conversationId } as const
  const needId = (): number => args.id ?? fail(`${args.action} needs an id`)
  switch (args.action) {
    case "create": {
      if (args.title === undefined) return fail("create needs a title")
      const issue = issueOf(await write(port, api, "issue.create", { ...fieldsOf(args), title: args.title }))
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
      let issue = issueOf(await write(port, api, "issue.update", { id, ...fieldsOf(args) }))
      if (args.link !== undefined)
        issue = issueOf(
          await write(
            port,
            api,
            args.link.remove === true ? "issue.unlink" : "issue.link",
            { id, kind: args.link.kind, other: args.link.other },
            ":link",
          ),
        )
      return `Updated ${line(issue)}`
    }
    default: {
      const _exhaustive: never = args.action
      return _exhaustive
    }
  }
}

export function issueTool(port: IssueToolPort) {
  return defineTool({
    name: "issue",
    description: DESCRIPTION,
    parameters: Args,
    replay: "safe",
    execute: async ({ action, id, with: extra }, api) =>
      refusing(async () => {
        if (extra !== undefined && (typeof extra !== "object" || extra === null || Array.isArray(extra)))
          return fail("with must be an object")
        const inner: unknown = {
          ...extra,
          action,
          ...(id === undefined ? {} : { id }),
        }
        if (!checkInner.check(inner))
          return fail(
            checkInner
              .errors(inner)
              .map((error) => `${error.path} ${error.message}`)
              .join("; "),
          )
        return run(port, inner, api)
      }),
  })
}
