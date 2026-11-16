import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import { arr, bool, int, lit, nullable, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema"
import { type Actor, type Context, defineOp, OpRejected } from "../../src/kernel/index.ts"
import { projectByRef } from "../../src/contracts/scope.ts"
import { projectInScope } from "../../src/contracts/threaddoc.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import {
  adoptProjectIds,
  type Change,
  createIssues,
  type IssueActor,
  type IssuesService,
  LINK_KINDS,
  PRIORITIES,
  type Wake,
} from "./issues.ts"
import { MIGRATIONS } from "./schema.ts"

export const name = "issues"
export const inject = ["db", "harness", "ops", "wire", "intake", "clock"]

const OWNER_ACTOR: IssueActor = { kind: "person", id: "owner" }
const WRITERS = ["owner", "agent"] as const

const actorOf = ({ actor }: { readonly actor: Actor }): IssueActor =>
  actor.kind === "agent" ? { kind: "thread", id: actor.conversationId } : OWNER_ACTOR

const ID = int({ minimum: 1 })
const CONVERSATION = int({ minimum: 0 })

export const AssigneeArg = union([
  obj({ kind: lit("person"), id: str({ minLength: 1, maxLength: 120 }) }),
  obj({ kind: oneOf(["thread", "captain"] as const), id: CONVERSATION }),
])

export const FieldArgs = {
  title: opt(str({ minLength: 1, maxLength: 300 })),
  description: opt(str({ maxLength: 20_000 })),
  state: opt(str({ minLength: 1, maxLength: 60 })),
  priority: opt(oneOf(PRIORITIES)),
  due: opt(nullable(str({ maxLength: 10 }))),
  parent: opt(nullable(ID)),
  labels: opt(arr(str({ maxLength: 40 }), { maxItems: 20 })),
  assignees: opt(arr(AssigneeArg, { maxItems: 20 })),
  threads: opt(arr(CONVERSATION, { maxItems: 20 })),
  prs: opt(arr(str({ maxLength: 500 }), { maxItems: 20 })),
}

export const ListArgs = obj({
  q: opt(str({ maxLength: 200 })),
  assignee: opt(AssigneeArg),
  states: opt(arr(str({ minLength: 1, maxLength: 60 }), { maxItems: 20 })),
  closed: opt(bool()),
  parent: opt(nullable(ID)),
  project: opt(str({ minLength: 1 })),
  limit: opt(int({ minimum: 1, maximum: 200 })),
  cursor: opt(str({ maxLength: 40 })),
})

export const CommentArgs = obj({
  id: ID,
  body: str({ minLength: 1, maxLength: 20_000 }),
  replyTo: opt(ID),
  mentions: opt(arr(CONVERSATION, { maxItems: 20 })),
})

export const LinkArgs = obj({ id: ID, kind: oneOf(LINK_KINDS), other: ID })

export async function apply(ctx: Context): Promise<void> {
  await ctx.db.applySqliteMigrations("issues", MIGRATIONS)
  await adoptProjectIds(ctx.db, async () =>
    Object.entries((await ctx.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))?.projects ?? {}).map(
      ([id, project]) => [id, project.slug] as const,
    ),
  )
  const issues = createIssues({
    db: ctx.db,
    conversationExists: async (id) =>
      (await ctx.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT)) !== undefined,
    projectOf: async (id) => (await projectInScope(ctx.harness, id as ConversationId))?.projectId,
    projectId: async (ref) => (await projectByRef(ctx.harness, ref))?.projectId,
    now: () => Date.now(),
  })

  const deliver = async (wakes: readonly Wake[]): Promise<void> => {
    let woke = false
    for (const wake of wakes) {
      const accepted = await ctx.intake.enqueue({
        target: wake.target as ConversationId,
        commandId: wake.commandId,
        kind: "job",
        threadId: `issue-${wake.issue}`,
        title: wake.title,
        status: wake.status,
        text: wake.text,
      })
      woke ||= accepted
      await issues.delivered(wake.commandId)
    }
    if (woke) await ctx.clock.arm()
  }

  const settle = async (change: Change): Promise<Change> => {
    if (change.events.length === 0) return change
    await deliver(change.wakes)
    await ctx.wire.publishHome()
    return change
  }

  const service: IssuesService = {
    ...issues,
    deleteState: async (actor, input) => {
      const result = await issues.deleteState(actor, input)
      await deliver(result.wakes)
      await ctx.wire.publishHome()
      return result
    },
    create: async (actor, fields) => settle(await issues.create(actor, fields)),
    update: async (actor, id, fields) => settle(await issues.update(actor, id, fields)),
    link: async (actor, id, kind, other, on) => settle(await issues.link(actor, id, kind, other, on)),
    comment: async (actor, id, input) => settle(await issues.comment(actor, id, input)),
  }
  ctx.provide("issues", service)
  ctx.wire.home("issues", async () => ({ issues: await issues.revs() }))
  await deliver(await issues.pending())
  await issues.revs()

  const ops = [
    defineOp({
      name: "issue.states",
      read: true,
      args: obj({}),
      actors: ["owner"],
      run: async () => ({ states: await issues.states() }),
    }),
    defineOp({
      name: "issue.state.create",
      args: obj({ name: str({ minLength: 1, maxLength: 60 }), closed: opt(bool()) }),
      actors: ["owner"],
      run: async (_api, args) => {
        const state = await issues.createState({ name: args.name, closed: args.closed ?? false })
        await ctx.wire.publishHome()
        return state
      },
    }),
    defineOp({
      name: "issue.state.update",
      args: obj({
        id: str({ minLength: 1, maxLength: 60 }),
        name: opt(str({ minLength: 1, maxLength: 60 })),
        position: opt(int({ minimum: 0 })),
        isDefault: opt(lit(true)),
      }),
      actors: ["owner"],
      run: async (_api, args) => {
        const state = await issues.updateState(args)
        await ctx.wire.publishHome()
        return state
      },
    }),
    defineOp({
      name: "issue.state.delete",
      args: obj({ id: str({ minLength: 1, maxLength: 60 }), moveTo: str({ minLength: 1, maxLength: 60 }) }),
      actors: ["owner"],
      run: async (_api, args) => {
        const { moved } = await service.deleteState(OWNER_ACTOR, args)
        return { moved }
      },
    }),
    defineOp({
      name: "issue.create",
      args: obj({ ...FieldArgs, title: str({ minLength: 1, maxLength: 300 }), project: opt(str({ minLength: 1 })) }),
      actors: WRITERS,
      run: async (api, args) => (await service.create(actorOf(api), args)).issue,
    }),
    defineOp({
      name: "issue.get",
      read: true,
      args: obj({ id: ID, before: opt(ID) }),
      actors: ["owner"],
      run: async (_api, args) => {
        const detail = await issues.get(OWNER_ACTOR, args.id, args.before)
        if (detail === undefined) throw new OpRejected("bad_args", `no issue #${args.id}`)
        return detail
      },
    }),
    defineOp({
      name: "issue.list",
      read: true,
      args: ListArgs,
      actors: ["owner"],
      run: async (_api, args) => issues.list(OWNER_ACTOR, args),
    }),
    defineOp({
      name: "issue.update",
      args: obj({ id: ID, ...FieldArgs }),
      actors: WRITERS,
      run: async (api, { id, ...fields }) => (await service.update(actorOf(api), id, fields)).issue,
    }),
    defineOp({
      name: "issue.link",
      args: LinkArgs,
      actors: WRITERS,
      run: async (api, args) => (await service.link(actorOf(api), args.id, args.kind, args.other, true)).issue,
    }),
    defineOp({
      name: "issue.unlink",
      args: LinkArgs,
      actors: WRITERS,
      run: async (api, args) => (await service.link(actorOf(api), args.id, args.kind, args.other, false)).issue,
    }),
    defineOp({
      name: "issue.comment",
      args: CommentArgs,
      actors: WRITERS,
      run: async (api, { id, ...input }) => {
        const change = await service.comment(actorOf(api), id, input)
        return { issue: change.issue, event: change.events[0] ?? null }
      },
    }),
  ]
  for (const op of ops) ctx.ops.define(op)
}
