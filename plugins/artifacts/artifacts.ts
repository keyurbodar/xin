import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, Harness } from "@earendil-works/pi-durable"
import { int, obj, opt, str } from "@earendil-works/pi-schema"
import {
  ARTIFACT_LIMIT,
  ARTIFACT_MARKDOWN_MAX,
  ARTIFACT_TOTAL_MAX,
  ArtifactsDoc,
} from "../../src/contracts/artifacts.ts"
import { canUseThread } from "../../src/contracts/scope.ts"
import { WorkspaceDoc } from "../../src/contracts/workspace.ts"
import { type Actor, defineOp, type Op, OpRejected } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT

async function allowed(actor: Actor, harness: Harness, threadId: number): Promise<boolean> {
  if (actor.kind === "owner") {
    const workspace = await harness.snapshot(WorkspaceDoc, context)
    return (
      workspace !== undefined && Object.values(workspace.spaces).some((space) => space.threadIds.includes(threadId))
    )
  }
  if (actor.kind === "agent") return canUseThread(harness, actor.conversationId, threadId)
  return false
}

const ThreadArg = int({ minimum: 0 })

function totalOf(items: Record<string, { markdown: string }>, except?: string): number {
  return Object.entries(items).reduce((total, [id, item]) => (id === except ? total : total + item.markdown.length), 0)
}

export function artifactOps(port: { readonly harness: Harness }): readonly Op[] {
  const list = defineOp({
    name: "artifact.list",
    args: obj({ threadId: ThreadArg }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (!(await allowed(api.actor, port.harness, args.threadId)))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const doc = await port.harness.snapshot(ArtifactsDoc, args.threadId as ConversationId, context)
      return {
        artifacts: Object.entries(doc?.items ?? {})
          .map(([id, artifact]) => ({
            id,
            title: artifact.title,
            revision: artifact.revision,
            updatedAt: artifact.updatedAt,
          }))
          .toSorted((left, right) => right.updatedAt - left.updatedAt),
      }
    },
  })

  const read = defineOp({
    name: "artifact.read",
    args: obj({ threadId: ThreadArg, id: str({ minLength: 1 }) }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (!(await allowed(api.actor, port.harness, args.threadId)))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      const doc = await port.harness.snapshot(ArtifactsDoc, args.threadId as ConversationId, context)
      const artifact = doc?.items[args.id]
      if (artifact === undefined) throw new OpRejected("bad_args", `no artifact ${args.id}`)
      return { id: args.id, ...artifact }
    },
  })

  const write = defineOp({
    name: "artifact.write",
    args: obj({
      threadId: ThreadArg,
      id: opt(str({ minLength: 1 })),
      title: str({ minLength: 1, maxLength: 200 }),
      markdown: str({ maxLength: ARTIFACT_MARKDOWN_MAX }),
      expectedRevision: opt(int({ minimum: 1 })),
    }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (!(await allowed(api.actor, port.harness, args.threadId)))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      return api.harness.commit(async (tx) => {
        const doc = await tx.doc(ArtifactsDoc, args.threadId as ConversationId)
        const now = Date.now()
        if (args.id === undefined) {
          const id = `art_${api.commandId}`
          const existing = doc.items[id]
          if (existing !== undefined)
            return {
              kind: "written",
              id,
              revision: existing.revision,
              title: existing.title,
              updatedAt: existing.updatedAt,
            }
          if (Object.keys(doc.items).length >= ARTIFACT_LIMIT)
            throw new OpRejected("bad_args", `a thread holds at most ${ARTIFACT_LIMIT} artifacts`)
          if (totalOf(doc.items) + args.markdown.length > ARTIFACT_TOTAL_MAX)
            throw new OpRejected("bad_args", "this thread's artifacts would exceed 1 MB")
          doc.items[id] = { title: args.title, markdown: args.markdown, revision: 1, createdAt: now, updatedAt: now }
          return { kind: "written", id, revision: 1, title: args.title, updatedAt: now }
        }
        const artifact = doc.items[args.id]
        if (artifact === undefined) throw new OpRejected("bad_args", `no artifact ${args.id}`)
        if (args.expectedRevision !== undefined && args.expectedRevision !== artifact.revision)
          return {
            kind: "stale",
            id: args.id,
            revision: artifact.revision,
            title: artifact.title,
            markdown: artifact.markdown,
          }
        if (totalOf(doc.items, args.id) + args.markdown.length > ARTIFACT_TOTAL_MAX)
          throw new OpRejected("bad_args", "this thread's artifacts would exceed 1 MB")
        artifact.title = args.title
        artifact.markdown = args.markdown
        artifact.revision += 1
        artifact.updatedAt = now
        return { kind: "written", id: args.id, revision: artifact.revision, title: artifact.title, updatedAt: now }
      }, context)
    },
  })

  const remove = defineOp({
    name: "artifact.delete",
    args: obj({ threadId: ThreadArg, id: str({ minLength: 1 }) }),
    actors: ["owner", "agent"],
    run: async (api, args) => {
      if (!(await allowed(api.actor, port.harness, args.threadId)))
        throw new OpRejected("bad_args", `no thread ${args.threadId}`)
      return api.harness.commit(async (tx) => {
        const doc = await tx.doc(ArtifactsDoc, args.threadId as ConversationId)
        if (doc.items[args.id] === undefined) throw new OpRejected("bad_args", `no artifact ${args.id}`)
        delete doc.items[args.id]
        return { deleted: true, id: args.id }
      }, context)
    },
  })

  return [list, read, write, remove]
}
