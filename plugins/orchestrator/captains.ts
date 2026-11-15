import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import {
  configure,
  defineDoc,
  type ConversationId,
  type DocumentReader,
  type Harness,
  type JsonObject,
  type ModelRef,
  type Registry,
  type Tx,
} from "@earendil-works/pi-durable"
import { bool, compile, int, map, obj, opt, str, type Static } from "@earendil-works/pi-schema"
import { ModelRefSchema } from "../../src/contracts/models.ts"
import { ThreadDoc, type ThreadDocState } from "../../src/contracts/threaddoc.ts"
import type { WatchdogService } from "../../src/contracts/watchdog.ts"
import { SLUG, WorkspaceDoc, type SpaceState, type WorkspaceState } from "../../src/contracts/workspace.ts"
import type { CommandId } from "../../src/ids.ts"
import { defineOp, OpRejected, type Op } from "../../src/ops.ts"

const context = BACKGROUND_CONTEXT

export const NOTES_TOOL = "captain_notes"
export const MAX_FILE_CHARS = 16_000
const REPORT_CHARS = 400

const FileText = str({ maxLength: MAX_FILE_CHARS })

/**
 * A Captain is a named, persistent coordinator. Its conversation coordinates a space of its own, so delegate_task,
 * thread scoping, intake batching and the watchdog all work unchanged; that space's threads are its crew.
 */
const CaptainSchema = obj({
  name: str({ minLength: 1, maxLength: 80 }),
  alias: str({ pattern: SLUG, minLength: 1, maxLength: 40 }),
  avatarSeed: str({ minLength: 1, maxLength: 120 }),
  description: str({ maxLength: 200 }),
  spaceId: str({ minLength: 1 }),
  coordinatorId: int({ minimum: 0 }),
  notes: FileText,
  rules: FileText,
  crewRules: FileText,
  archived: bool(),
  createdAt: int({ minimum: 0 }),
})

const CaptainsSchema = obj({ captains: map(CaptainSchema) })

export type CaptainState = Static<typeof CaptainSchema>
type CaptainsState = Static<typeof CaptainsSchema>

const parseCaptains = compile(CaptainsSchema)

export const CaptainsDoc = defineDoc<CaptainsState>({
  kind: "xin.captains",
  version: 1,
  scope: "session",
  initial: () => ({ captains: {} }),
  migrate: (value) => {
    if (!parseCaptains.check(value)) throw new Error("xin.captains v1 does not match its shape")
    return value
  },
  checkpointWhen: () => false,
})

/** The standing files a Captain may rewrite itself; its own rules are the owner's. */
export type WritableFile = "notes" | "crewRules"

export type CaptainDeps = {
  readonly harness: Harness
  readonly registry: Registry
  readonly watchdog: WatchdogService
  currentModels(): Models
  disabled(ref: ModelRef): Promise<boolean>
  publishHome(): Promise<void>
}

export type CrewMember = {
  readonly threadId: number
  readonly title: string
  readonly status: ThreadDocState["status"]
  readonly run: number
  readonly idleMs: number
  readonly statusLine?: string
  readonly report?: string
}

type Found = { readonly id: string; readonly captain: CaptainState }

const captainIdOf = (commandId: CommandId): string => `cpt_${commandId}`

const aliasOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "captain"

/** The live Captain whose conversation this is. */
export async function captainOf(read: DocumentReader, conversationId: ConversationId): Promise<Found | undefined> {
  const doc = await read.snapshot(CaptainsDoc, context)
  for (const [id, captain] of Object.entries(doc?.captains ?? {})) {
    if (!captain.archived && captain.coordinatorId === conversationId) return { id, captain }
  }
  return undefined
}

async function crewCaptainOf(read: DocumentReader, conversationId: ConversationId): Promise<Found | undefined> {
  const thread = await read.snapshot(ThreadDoc, conversationId, context)
  if (thread?.spaceId === undefined) return undefined
  const doc = await read.snapshot(CaptainsDoc, context)
  for (const [id, captain] of Object.entries(doc?.captains ?? {})) {
    if (!captain.archived && captain.spaceId === thread.spaceId) return { id, captain }
  }
  return undefined
}

/** The Captain whose Drive scope a conversation sees: its own, or its crew's. */
export async function captainScopeOf(
  read: DocumentReader,
  conversationId: ConversationId,
): Promise<string | undefined> {
  return ((await captainOf(read, conversationId)) ?? (await crewCaptainOf(read, conversationId)))?.id
}

const tagged = (tag: string, text: string): string[] =>
  text.trim() === "" ? [] : [`<${tag}>\n${text.trim()}\n</${tag}>`]

/** A Captain reads its profile, rules and notes; a crew thread reads its Captain's crew rules. */
export async function captainPrompt(read: DocumentReader, conversationId: ConversationId): Promise<string | undefined> {
  const own = await captainOf(read, conversationId)
  if (own !== undefined) {
    const { captain } = own
    return [
      `You are Captain ${captain.name} (@${captain.alias}). ${captain.description}`.trim(),
      "You run a crew of threads: threads you start with delegate_task join your crew, and their reports reach you in batches. Keep your standing notes current with captain_notes.",
      ...tagged("captain-rules", captain.rules),
      ...tagged("captain-notes", captain.notes),
    ].join("\n")
  }
  const crew = await crewCaptainOf(read, conversationId)
  if (crew === undefined) return undefined
  const rules = tagged("crew-rules", crew.captain.crewRules)
  return rules.length === 0 ? undefined : [`You are in Captain ${crew.captain.name}'s crew.`, ...rules].join("\n")
}

function crewOf(workspace: WorkspaceState | undefined, captain: CaptainState): readonly number[] {
  return workspace?.spaces[captain.spaceId]?.threadIds ?? []
}

async function crewView(harness: Harness, captain: CaptainState, now: number): Promise<CrewMember[]> {
  const workspace = await harness.snapshot(WorkspaceDoc, context)
  const members: CrewMember[] = []
  for (const threadId of crewOf(workspace, captain)) {
    const doc = await harness.snapshot(ThreadDoc, threadId as ConversationId, context)
    if (doc === undefined || doc.archived === true) continue
    members.push({
      threadId,
      title: doc.title,
      status: doc.status,
      run: doc.run ?? 1,
      idleMs: Math.max(0, now - (doc.beatAt ?? now)),
      ...(doc.statusLine === undefined ? {} : { statusLine: doc.statusLine }),
      ...(doc.result === undefined ? {} : { report: doc.result.slice(0, REPORT_CHARS) }),
    })
  }
  return members.toSorted((left, right) => left.idleMs - right.idleMs)
}

/**
 * The Captain's space is the source of truth for where it runs and whether it is live: `space.update` can move it to
 * another project, and `space.archive` or `project.archive` can retire it without going through `captain.archive`.
 */
function isLive(workspace: WorkspaceState | undefined, captain: CaptainState): boolean {
  const space = workspace?.spaces[captain.spaceId]
  const project = space === undefined ? undefined : workspace?.projects[space.projectId]
  return !captain.archived && space !== undefined && !space.archived && project !== undefined && !project.archived
}

const profileOf = (id: string, captain: CaptainState, workspace: WorkspaceState | undefined) => ({
  id,
  name: captain.name,
  alias: captain.alias,
  avatarSeed: captain.avatarSeed,
  description: captain.description,
  projectId: workspace?.spaces[captain.spaceId]?.projectId ?? "",
  spaceId: captain.spaceId,
  coordinatorId: captain.coordinatorId,
  archived: !isLive(workspace, captain),
  createdAt: captain.createdAt,
})

type Counts = { total: number; working: number; waiting: number; failed: number }

async function countsOf(
  harness: Harness,
  workspace: WorkspaceState | undefined,
  captain: CaptainState,
): Promise<Counts> {
  const counts: Counts = { total: 0, working: 0, waiting: 0, failed: 0 }
  for (const threadId of crewOf(workspace, captain)) {
    const doc = await harness.snapshot(ThreadDoc, threadId as ConversationId, context)
    if (doc === undefined || doc.archived === true) continue
    counts.total += 1
    if (doc.status === "working" || doc.status === "waiting" || doc.status === "failed") counts[doc.status] += 1
  }
  return counts
}

/** The home stream's `captains` part: every live Captain with crew counts. Memory reads only. */
export async function captainsHome(harness: Harness): Promise<JsonObject> {
  const [doc, workspace] = await Promise.all([
    harness.snapshot(CaptainsDoc, context),
    harness.snapshot(WorkspaceDoc, context),
  ])
  const captains = []
  for (const [id, captain] of Object.entries(doc?.captains ?? {})) {
    if (!isLive(workspace, captain)) continue
    captains.push({ ...profileOf(id, captain, workspace), crew: await countsOf(harness, workspace, captain) })
  }
  return { captains: captains.toSorted((left, right) => left.createdAt - right.createdAt) }
}

function liveAliasTaken(doc: CaptainsState, alias: string, except: string | undefined): boolean {
  return Object.entries(doc.captains).some(
    ([id, captain]) => id !== except && !captain.archived && captain.alias === alias,
  )
}

function mustFind(doc: CaptainsState, id: string): CaptainState {
  const captain = doc.captains[id]
  if (captain === undefined) throw new OpRejected("bad_args", `no captain ${id}`)
  return captain
}

function liveSpace(workspace: WorkspaceState, captain: CaptainState): SpaceState {
  const space = workspace.spaces[captain.spaceId]
  if (space === undefined || !isLive(workspace, captain))
    throw new OpRejected("bad_args", `captain ${captain.alias} is archived`)
  return space
}

/** A thread's home space when it leaves a crew: its project's first space that no Captain runs. */
function homeSpaceOf(workspace: WorkspaceState, doc: CaptainsState, projectId: string): string | undefined {
  const captainSpaces = new Set(Object.values(doc.captains).map((captain) => captain.spaceId))
  const found = Object.entries(workspace.spaces).find(
    ([id, space]) => space.projectId === projectId && !space.archived && !captainSpaces.has(id),
  )
  return found?.[0]
}

async function moveThread(tx: Tx, workspace: WorkspaceState, threadId: number, toSpaceId: string): Promise<void> {
  const target = workspace.spaces[toSpaceId]
  if (target === undefined) throw new OpRejected("bad_args", `no space ${toSpaceId}`)
  for (const space of Object.values(workspace.spaces)) {
    if (space !== target && space.threadIds.includes(threadId))
      space.threadIds = space.threadIds.filter((id) => id !== threadId)
  }
  if (!target.threadIds.includes(threadId)) target.threadIds.push(threadId)
  const thread = await tx.doc(ThreadDoc, threadId as ConversationId)
  thread.spaceId = toSpaceId
  thread.parentId = target.coordinatorId
}

async function checkModel(deps: CaptainDeps, model: ModelRef): Promise<void> {
  if (deps.currentModels().getModel(model.provider, model.modelId) === undefined)
    throw new OpRejected("bad_args", `unknown model ${model.provider}/${model.modelId}`)
  if (await deps.disabled(model))
    throw new OpRejected("bad_args", `model ${model.provider}/${model.modelId} is disabled`)
}

const ProfileFields = {
  name: opt(str({ minLength: 1, maxLength: 80 })),
  alias: opt(str({ pattern: SLUG, minLength: 1, maxLength: 40 })),
  avatarSeed: opt(str({ minLength: 1, maxLength: 120 })),
  description: opt(str({ maxLength: 200 })),
  model: opt(ModelRefSchema),
  notes: opt(FileText),
  rules: opt(FileText),
  crewRules: opt(FileText),
}

export function captainOps(deps: CaptainDeps): readonly Op[] {
  const { harness } = deps
  const published = async <T>(value: T): Promise<T> => {
    await deps.publishHome()
    return value
  }
  const notesTool = () =>
    deps.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool)
      .filter((tool) => tool.name === NOTES_TOOL)

  const list = defineOp({
    name: "captain.list",
    args: obj({ archived: opt(bool()) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const [doc, workspace] = await Promise.all([
        harness.snapshot(CaptainsDoc, context),
        harness.snapshot(WorkspaceDoc, context),
      ])
      const found = []
      for (const [id, captain] of Object.entries(doc?.captains ?? {})) {
        if (!isLive(workspace, captain) && args.archived !== true) continue
        found.push({ ...profileOf(id, captain, workspace), crew: await countsOf(harness, workspace, captain) })
      }
      return found.toSorted((left, right) => left.createdAt - right.createdAt)
    },
  })

  const get = defineOp({
    name: "captain.get",
    args: obj({ id: str({ minLength: 1 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const [doc, workspace] = await Promise.all([
        harness.snapshot(CaptainsDoc, context),
        harness.snapshot(WorkspaceDoc, context),
      ])
      const captain = doc?.captains[args.id]
      if (captain === undefined) throw new OpRejected("bad_args", `no captain ${args.id}`)
      const conversation = await harness.conversation(captain.coordinatorId as ConversationId, context)
      const model = conversation === undefined ? undefined : (await conversation.agent(context)).model
      return {
        ...profileOf(args.id, captain, workspace),
        model: model ?? null,
        notes: captain.notes,
        rules: captain.rules,
        crewRules: captain.crewRules,
        crew: await crewView(harness, captain, Date.now()),
      }
    },
  })

  const create = defineOp({
    name: "captain.create",
    args: obj({ projectId: str({ minLength: 1 }), ...ProfileFields, name: str({ minLength: 1, maxLength: 80 }) }),
    actors: ["owner"],
    run: async (api, args) => {
      if (args.model !== undefined) await checkModel(deps, args.model)
      const id = captainIdOf(api.commandId)
      const created = await harness.commit(async (tx) => {
        const doc = await tx.doc(CaptainsDoc)
        const workspace = await tx.doc(WorkspaceDoc)
        const existing = doc.captains[id]
        if (existing !== undefined) return profileOf(id, existing, workspace)
        const project = workspace.projects[args.projectId]
        if (project === undefined || project.archived)
          throw new OpRejected("bad_args", `no live project ${args.projectId}`)
        const alias = args.alias ?? aliasOf(args.name)
        if (liveAliasTaken(doc, alias, undefined)) throw new OpRejected("bad_args", `alias @${alias} is taken`)
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } })
        await configure(tx, conversation.id, {
          ...(args.model === undefined ? {} : { model: args.model }),
          modelTools: { add: notesTool() },
        })
        const spaceId = `spc_${id}`
        workspace.spaces[spaceId] = {
          name: args.name,
          projectId: args.projectId,
          coordinatorId: conversation.id,
          threadIds: [],
          archived: false,
        }
        const captain: CaptainState = {
          name: args.name,
          alias,
          avatarSeed: args.avatarSeed ?? alias,
          description: args.description ?? "",
          spaceId,
          coordinatorId: conversation.id,
          notes: args.notes ?? "",
          rules: args.rules ?? "",
          crewRules: args.crewRules ?? "",
          archived: false,
          createdAt: Date.now(),
        }
        doc.captains[id] = captain
        return profileOf(id, captain, workspace)
      }, context)
      return published(created)
    },
  })

  const update = defineOp({
    name: "captain.update",
    args: obj({ id: str({ minLength: 1 }), ...ProfileFields }),
    actors: ["owner"],
    run: async (_api, args) => {
      if (args.model !== undefined) await checkModel(deps, args.model)
      const updated = await harness.commit(async (tx) => {
        const doc = await tx.doc(CaptainsDoc)
        const captain = mustFind(doc, args.id)
        if (args.alias !== undefined && liveAliasTaken(doc, args.alias, args.id))
          throw new OpRejected("bad_args", `alias @${args.alias} is taken`)
        const workspace = await tx.doc(WorkspaceDoc)
        if (args.name !== undefined) {
          captain.name = args.name
          const space = workspace.spaces[captain.spaceId]
          if (space !== undefined) space.name = args.name
        }
        if (args.alias !== undefined) captain.alias = args.alias
        if (args.avatarSeed !== undefined) captain.avatarSeed = args.avatarSeed
        if (args.description !== undefined) captain.description = args.description
        if (args.notes !== undefined) captain.notes = args.notes
        if (args.rules !== undefined) captain.rules = args.rules
        if (args.crewRules !== undefined) captain.crewRules = args.crewRules
        if (args.model !== undefined)
          await configure(tx, captain.coordinatorId as ConversationId, { model: args.model })
        return profileOf(args.id, captain, workspace)
      }, context)
      return published(updated)
    },
  })

  const archive = defineOp({
    name: "captain.archive",
    args: obj({ id: str({ minLength: 1 }), archived: opt(bool()) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const archived = args.archived ?? true
      const changed = await harness.commit(async (tx) => {
        const doc = await tx.doc(CaptainsDoc)
        const captain = mustFind(doc, args.id)
        if (!archived && liveAliasTaken(doc, captain.alias, args.id))
          throw new OpRejected("bad_args", `alias @${captain.alias} is taken`)
        captain.archived = archived
        const workspace = await tx.doc(WorkspaceDoc)
        const space = workspace.spaces[captain.spaceId]
        if (space !== undefined) space.archived = archived
        return profileOf(args.id, captain, workspace)
      }, context)
      return published(changed)
    },
  })

  const addCrew = defineOp({
    name: "captain.crew.add",
    args: obj({ id: str({ minLength: 1 }), threadId: int({ minimum: 0 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const moved = await harness.commit(async (tx) => {
        const doc = await tx.doc(CaptainsDoc)
        const captain = mustFind(doc, args.id)
        const workspace = await tx.doc(WorkspaceDoc)
        liveSpace(workspace, captain)
        const listed = Object.values(workspace.spaces).some((space) => space.threadIds.includes(args.threadId))
        const thread = await tx.doc(ThreadDoc, args.threadId as ConversationId)
        if (!listed || thread.projectId === "") throw new OpRejected("bad_args", `no thread ${args.threadId}`)
        await moveThread(tx, workspace, args.threadId, captain.spaceId)
        if (thread.status === "working") await deps.watchdog.ensure(tx, captain.coordinatorId as ConversationId)
        return { id: args.id, threadId: args.threadId, spaceId: captain.spaceId, parentId: captain.coordinatorId }
      }, context)
      return published(moved)
    },
  })

  const removeCrew = defineOp({
    name: "captain.crew.remove",
    args: obj({ id: str({ minLength: 1 }), threadId: int({ minimum: 0 }) }),
    actors: ["owner"],
    run: async (_api, args) => {
      const moved = await harness.commit(async (tx) => {
        const doc = await tx.doc(CaptainsDoc)
        const captain = mustFind(doc, args.id)
        const workspace = await tx.doc(WorkspaceDoc)
        if (!crewOf(workspace, captain).includes(args.threadId))
          throw new OpRejected("bad_args", `thread ${args.threadId} is not in @${captain.alias}'s crew`)
        const thread = await tx.doc(ThreadDoc, args.threadId as ConversationId)
        const home = homeSpaceOf(workspace, doc, thread.projectId)
        if (home === undefined || home === captain.spaceId)
          throw new OpRejected("bad_args", `project ${thread.projectId} has no other space to return the thread to`)
        await moveThread(tx, workspace, args.threadId, home)
        const parentId = workspace.spaces[home]?.coordinatorId
        if (thread.status === "working" && parentId !== undefined)
          await deps.watchdog.ensure(tx, parentId as ConversationId)
        return { id: args.id, threadId: args.threadId, spaceId: home, parentId: parentId ?? null }
      }, context)
      return published(moved)
    },
  })

  return [list, get, create, update, archive, addCrew, removeCrew]
}

/** A Captain rewrites one of its own standing files; any other conversation is refused. */
export async function writeOwnFile(
  tx: Tx,
  conversationId: ConversationId,
  file: WritableFile,
  text: string,
): Promise<{ readonly kind: "written"; readonly alias: string } | { readonly kind: "not_captain" }> {
  const doc = await tx.doc(CaptainsDoc)
  const found = Object.values(doc.captains).find(
    (captain) => !captain.archived && captain.coordinatorId === conversationId,
  )
  if (found === undefined) return { kind: "not_captain" }
  found[file] = text
  return { kind: "written", alias: found.alias }
}
