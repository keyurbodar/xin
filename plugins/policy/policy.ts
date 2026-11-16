import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord"
import {
  AgentDoc,
  configure,
  type ConversationId,
  defineDoc,
  defineExtension,
  type Extension,
  type Harness,
  hook,
  type RegistrySnapshot,
  ROOT_CONVERSATION_ID,
  type ToolRegistration,
  ToolTask,
  type Tx,
} from "@earendil-works/pi-durable"
import { compile, int, map, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema"
import { type QuestionsService, RequestsDoc } from "../../src/contracts/questions.ts"
import { WorkspaceDoc, type WorkspaceState } from "../../src/contracts/workspace.ts"
import { type Actor, type Command, defineOp, type Op, OpRejected, type Outcome } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT

/** The request kind every approval card shares, so one card renders the policy's approvals and the model's own. */
export const APPROVAL_KIND = "approval"
export const APPROVE = "Approve"
export const ALWAYS_ALLOW = "Always allow"
export const DENY = "Deny"
export const APPROVAL_OPTIONS = [APPROVE, ALWAYS_ALLOW, DENY] as const
export const APPROVAL_PREFIX = "approval:"
const PREVIEW_LIMIT = 500
const DEFAULT_MODE: Mode = "allow"

const MODES = ["allow", "ask", "off"] as const
const ModeSchema = oneOf(MODES)
type Mode = Static<typeof ModeSchema>

const PolicySchema = obj({ home: map(ModeSchema), projects: map(map(ModeSchema)) })
type PolicyState = Static<typeof PolicySchema>

/** The owner's tool modes, Home's and each project's overrides, in one session document held in memory. */
export const PolicyDoc = defineDoc<PolicyState>({
  kind: "xin.policy",
  version: 1,
  scope: "session",
  initial: () => ({ home: {}, projects: {} }),
  checkpointWhen: () => false,
})

type GrantState = {
  readonly tool: string
  readonly arguments: string
  readonly state: "asked" | "granted" | "used"
  readonly usedBy?: string
}

type CallsState = {
  grants: Record<string, GrantState>
  off: string[]
}

/** One conversation's approvals by request id, and the tool names the policy added to its `tools.remove`. */
export const CallsDoc = defineDoc<CallsState>({
  kind: "xin.policy.calls",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ grants: {}, off: [] }),
  checkpointWhen: () => false,
})

const parsePolicy = compile(PolicySchema)
const parseRespond = compile(obj({ threadId: int({ minimum: 0 }), requestId: str(), answer: str() }))

export type PolicyPort = {
  readonly harness: Harness
  readonly questions: Pick<QuestionsService, "ask" | "settle">
  redact(text: string): string
  registry(): RegistrySnapshot
  pluginOf(extension: string): string | undefined
}

type ToolRow = { name: string; plugin: string; title: string; home: Mode; project?: Mode }

export type Policy = {
  readonly ops: readonly Op[]
  readonly extension: Extension
  start(): Promise<void>
  realign(): void
  respond(command: Command, actor: Actor, next: () => Promise<Outcome>): Promise<Outcome>
}

/** Keys sorted at every depth, so two calls with the same arguments compare equal. */
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (typeof item !== "object" || item === null) return item
    return Object.fromEntries(
      Object.keys(item)
        .toSorted()
        .map((key) => [key, sort(Reflect.get(item, key))]),
    )
  }
  return JSON.stringify(sort(value)) ?? "null"
}

const preview = (text: string): string => (text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT - 1)}…`)

const titleOf = (name: string): string => {
  const words = name.replaceAll(/[_-]+/g, " ").trim()
  return words.length === 0 ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

const handle = (name: string): ToolRegistration => ({
  name,
  description: "",
  parameters: {},
  execute: async () => {
    throw new Error("a tool handle names a tool for configure and cannot run")
  },
})

const removedOf = (tools: unknown): string[] => {
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) return []
  const remove: unknown = Reflect.get(tools, "remove")
  return Array.isArray(remove) ? remove.filter((name): name is string => typeof name === "string") : []
}

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name) => right.includes(name))

const plan = (tools: unknown, mine: readonly string[], desired: readonly string[]) => {
  const base = removedOf(tools).filter((name) => !mine.includes(name))
  const added = desired.filter((name) => !base.includes(name))
  return { base, added }
}

const briefOf = (answer: string, tool: string): string => {
  if (answer === APPROVE)
    return `The owner approved one ${tool} call. Call ${tool} again with the same arguments to run it.`
  if (answer === ALWAYS_ALLOW)
    return `The owner approved ${tool} and allowed it from now on. Call ${tool} again with the same arguments to run it.`
  return `The owner denied the ${tool} call. Do not retry it; carry on without it or ask what to do instead.`
}

export function createPolicy(port: PolicyPort): Policy {
  let policy: PolicyState = { home: {}, projects: {} }
  const projectOf = new Map<number, string>()
  let queue: Promise<void> = Promise.resolve()

  const modeOf = (tool: string, projectId: string | undefined): Mode =>
    (projectId === undefined ? undefined : policy.projects[projectId]?.[tool]) ?? policy.home[tool] ?? DEFAULT_MODE

  const offFor = (projectId: string | undefined): string[] => {
    const scoped = projectId === undefined ? {} : (policy.projects[projectId] ?? {})
    const names = new Set([...Object.keys(policy.home), ...Object.keys(scoped)])
    return [...names].filter((name) => modeOf(name, projectId) === "off").toSorted()
  }

  const index = (workspace: WorkspaceState | undefined): void => {
    projectOf.clear()
    for (const space of Object.values(workspace?.spaces ?? {})) {
      projectOf.set(space.coordinatorId, space.projectId)
      for (const threadId of space.threadIds) projectOf.set(threadId, space.projectId)
    }
  }

  const align = async (conversationId: ConversationId): Promise<void> => {
    const desired = offFor(projectOf.get(conversationId))
    const [agent, calls] = await Promise.all([
      port.harness.snapshot(AgentDoc, conversationId, context),
      port.harness.snapshot(CallsDoc, conversationId, context),
    ])
    if (Array.isArray(agent?.tools)) return
    const mine = calls?.off ?? []
    const removed = removedOf(agent?.tools)
    const { added } = plan(agent?.tools, mine, desired)
    if (sameNames(mine, added) && added.every((name) => removed.includes(name))) return
    if (agent === undefined && (await port.harness.conversation(conversationId, context)) === undefined) {
      if (conversationId !== ROOT_CONVERSATION_ID) return
      await port.harness.root(context)
    }
    await port.harness.commit(async (tx) => {
      const current = await tx.doc(AgentDoc, conversationId)
      if (Array.isArray(current.tools)) return
      const doc = await tx.doc(CallsDoc, conversationId)
      const next = plan(current.tools, doc.off, desired)
      const names = [...next.base, ...next.added]
      await configure(tx, conversationId, { tools: names.length === 0 ? null : { remove: names.map(handle) } })
      doc.off = next.added
    }, context)
  }

  const alignAll = (): Promise<void> => {
    const run = queue.then(async () => {
      index(await port.harness.snapshot(WorkspaceDoc, context))
      await align(ROOT_CONVERSATION_ID)
      for (const id of projectOf.keys()) await align(id as ConversationId)
    })
    queue = run.catch((error: unknown) => console.warn("policy: align failed", error))
    return run
  }

  const load = async (): Promise<void> => {
    const stored = await port.harness.snapshot(PolicyDoc, context)
    policy = stored !== undefined && parsePolicy.check(stored) ? structuredClone(stored) : { home: {}, projects: {} }
  }

  const projectIdOf = async (projectId: string | undefined): Promise<string | undefined> => {
    if (projectId === undefined) return undefined
    const workspace = await port.harness.snapshot(WorkspaceDoc, context)
    const found = Object.entries(workspace?.projects ?? {}).find(
      ([id, project]) => !project.archived && (id === projectId || project.slug === projectId),
    )
    if (found === undefined) throw new OpRejected("bad_args", `no project ${projectId}`)
    return found[0]
  }

  const toolRows = (projectId: string | undefined): ToolRow[] => {
    const rows = new Map<string, ToolRow>()
    for (const { extension, tool } of port.registry().tools()) {
      if (rows.has(tool.name)) continue
      const project = projectId === undefined ? undefined : policy.projects[projectId]?.[tool.name]
      rows.set(tool.name, {
        name: tool.name,
        plugin: port.pluginOf(extension.name) ?? extension.name,
        title: titleOf(tool.name),
        home: policy.home[tool.name] ?? DEFAULT_MODE,
        ...(project === undefined ? {} : { project }),
      })
    }
    return [...rows.values()].toSorted((left, right) => left.name.localeCompare(right.name))
  }

  const readOp = defineOp({
    name: "tool.policy.read",
    read: true,
    args: obj({ projectId: opt(str({ minLength: 1 })) }),
    actors: ["owner"],
    run: async (_api, args) => ({ tools: toolRows(await projectIdOf(args.projectId)) }),
  })

  const setOp = defineOp({
    name: "tool.policy.set",
    args: obj({
      tool: str({ minLength: 1, maxLength: 200 }),
      mode: oneOf([...MODES, "inherit"] as const),
      projectId: opt(str({ minLength: 1 })),
    }),
    actors: ["owner"],
    run: async (_api, args) => {
      const projectId = await projectIdOf(args.projectId)
      if (args.mode === "inherit" && projectId === undefined)
        throw new OpRejected("bad_args", "inherit clears a project's override, so it needs a projectId")
      if (
        !port
          .registry()
          .tools()
          .some(({ tool }) => tool.name === args.tool)
      )
        throw new OpRejected("bad_args", `no tool ${args.tool}`)
      await port.harness.commit(async (tx) => {
        const doc = await tx.doc(PolicyDoc)
        if (projectId === undefined) {
          if (args.mode !== "inherit") doc.home[args.tool] = args.mode
          return
        }
        const rest = Object.entries(doc.projects[projectId] ?? {}).filter(([tool]) => tool !== args.tool)
        const project = Object.fromEntries(args.mode === "inherit" ? rest : [...rest, [args.tool, args.mode]])
        if (Object.keys(project).length === 0) delete doc.projects[projectId]
        else doc.projects[projectId] = project
      }, context)
      await load()
      await alignAll()
      return { tool: args.tool, mode: args.mode, ...(projectId === undefined ? {} : { projectId }) }
    },
  })

  const ask = async (conversationId: ConversationId, callId: string, tool: string, args: string): Promise<void> => {
    const requestId = `${APPROVAL_PREFIX}${callId}`
    await port.harness.commit(async (tx) => {
      const doc = await tx.doc(CallsDoc, conversationId)
      doc.grants[requestId] ??= { tool, arguments: args, state: "asked" }
    }, context)
    await port.questions.ask(
      {
        kind: APPROVAL_KIND,
        threadId: conversationId,
        requestId,
        question: `Allow ${tool} to run?`,
        options: APPROVAL_OPTIONS,
        subject: { tool, arguments: preview(port.redact(args)) },
        now: Date.now(),
      },
      context,
    )
  }

  const take = async (conversationId: ConversationId, callId: string, tool: string, args: string): Promise<boolean> => {
    const match = (grant: GrantState): boolean =>
      grant.tool === tool &&
      grant.arguments === args &&
      (grant.state === "granted" || (grant.state === "used" && grant.usedBy === callId))
    const calls = await port.harness.snapshot(CallsDoc, conversationId, context)
    if (!Object.values(calls?.grants ?? {}).some(match)) return false
    return port.harness.commit(async (tx) => {
      const doc = await tx.doc(CallsDoc, conversationId)
      const entries = Object.entries(doc.grants)
      if (entries.some(([, grant]) => grant.state === "used" && match(grant))) return true
      const found = entries.find(([, grant]) => match(grant))
      if (found === undefined) return false
      for (const [key, grant] of entries) if (grant.state === "used") delete doc.grants[key]
      doc.grants[found[0]] = { tool, arguments: args, state: "used", usedBy: callId }
      return true
    }, context)
  }

  const extension = defineExtension({
    name: "xin.policy",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          const mode = modeOf(call.name, projectOf.get(api.conversationId))
          switch (mode) {
            case "allow":
              return undefined
            case "off":
              return { block: `The owner turned ${call.name} off.` }
            case "ask": {
              const args = canonical(call.arguments)
              if (await take(api.conversationId, call.id, call.name, args)) return undefined
              await ask(api.conversationId, call.id, call.name, args)
              return {
                block: `${call.name} waits for the owner's approval (request ${APPROVAL_PREFIX}${call.id}). Your turn ends here; the owner's answer starts your next run.`,
              }
            }
            default: {
              const _exhaustive: never = mode
              return _exhaustive
            }
          }
        },
        afterTool: async (call, result, api, callContext) => {
          if (!(result.diagnostics ?? []).some((diagnostic) => diagnostic.code === "blocked")) return undefined
          const requests = await api.snapshot(RequestsDoc, api.conversationId, callContext)
          if (requests?.open[`${APPROVAL_PREFIX}${call.id}`] === undefined) return undefined
          return { ...result, control: { ...result.control, terminate: true } }
        },
      }),
    ],
  })

  const respond = async (command: Command, actor: Actor, next: () => Promise<Outcome>): Promise<Outcome> => {
    if (command.op !== "request.respond" || !parseRespond.check(command.args)) return next()
    const args = command.args
    if (!args.requestId.startsWith(APPROVAL_PREFIX)) return next()
    const conversationId = args.threadId as ConversationId
    const [requests, calls] = await Promise.all([
      port.harness.snapshot(RequestsDoc, conversationId, context),
      port.harness.snapshot(CallsDoc, conversationId, context),
    ])
    const request = requests?.open[args.requestId] ?? requests?.answered[args.requestId]
    if (request?.kind !== APPROVAL_KIND) return next()
    if (actor.kind !== "owner")
      return { kind: "rejected", code: "forbidden", message: "only the owner answers an approval request" }
    if (!APPROVAL_OPTIONS.some((option) => option === args.answer))
      return { kind: "rejected", code: "bad_args", message: `an approval takes one of: ${APPROVAL_OPTIONS.join(", ")}` }
    const tool =
      typeof request.subject === "object" ? request.subject.tool : (calls?.grants[args.requestId]?.tool ?? "")
    const projectId = projectOf.get(conversationId)
    const admitted = async (_open: unknown, tx: Tx): Promise<void> => {
      const doc = await tx.doc(CallsDoc, conversationId)
      const grant = doc.grants[args.requestId]
      if (grant === undefined) return
      if (args.answer === DENY) {
        delete doc.grants[args.requestId]
        return
      }
      doc.grants[args.requestId] = { tool: grant.tool, arguments: grant.arguments, state: "granted" }
      if (args.answer !== ALWAYS_ALLOW) return
      const stored = await tx.doc(PolicyDoc)
      if (projectId === undefined) stored.home[grant.tool] = "allow"
      else stored.projects[projectId] = { ...stored.projects[projectId], [grant.tool]: "allow" }
    }
    try {
      const outcome = await port.questions.settle(
        conversationId,
        args.requestId,
        args.answer,
        admitted,
        briefOf(args.answer, tool),
      )
      if (outcome.kind === "answered" && args.answer === ALWAYS_ALLOW) await load()
      const result: JsonValue = { threadId: args.threadId, requestId: args.requestId, ...outcome }
      return { kind: "ok", result }
    } catch (error) {
      if (error instanceof OpRejected) return { kind: "rejected", code: error.code, message: error.message }
      throw error
    }
  }

  return {
    ops: [readOp, setOp],
    extension,
    start: async () => {
      await load()
      await alignAll()
    },
    realign: () => void alignAll().catch(() => undefined),
    respond,
  }
}
