import type { JsonValue } from "@earendil-works/chord"
import type { SqliteDatabase } from "@earendil-works/chord/sqlite"
import type { ConversationId, Harness } from "@earendil-works/pi-durable"
import { compile, type Schema } from "@earendil-works/pi-schema"
import type { CommandId, PluginId } from "./ids.ts"

export type Actor =
  | { readonly kind: "owner" }
  | { readonly kind: "agent"; readonly conversationId: ConversationId }
  | { readonly kind: "plugin"; readonly pluginId: PluginId }

export type OpApi = { readonly harness: Harness; readonly actor: Actor; readonly commandId: CommandId }

export type Outcome =
  | { readonly kind: "ok"; readonly result: JsonValue }
  | {
      readonly kind: "rejected"
      readonly code: "unknown_op" | "bad_args" | "forbidden" | "failed" | "unavailable" | "busy" | "consent_required"
      readonly message: string
      readonly details?: JsonValue
    }

export type Op = {
  readonly name: string
  readonly actors: readonly Actor["kind"][]
  /**
   * False when the op's own state answers a resend (an intake item with the same command id), so a receipt row would
   * only repeat it. The command still runs through `ops/before`.
   */
  readonly receipts?: boolean
  /** Arg field names that carry a credential, at any depth: `ops/before` listeners see them redacted. */
  readonly credentials?: readonly string[]
  /** The op changes no owner state, so running it never announces a home change. */
  readonly read?: true
  invoke(api: OpApi, args: unknown): Promise<Outcome>
}

export type Command = { readonly id: CommandId; readonly op: string; readonly args: unknown }

const RECEIPT_TTL_MS = 24 * 60 * 60_000
const RECEIPT_SWEEP_MS = 60 * 60_000

export class OpRejected extends Error {
  constructor(
    readonly code: "bad_args" | "forbidden" | "busy" | "consent_required",
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
  }
}

export function defineOp<A>(definition: {
  readonly name: string
  readonly args: Schema<A>
  readonly actors: readonly Actor["kind"][]
  readonly receipts?: boolean
  readonly credentials?: readonly string[]
  readonly read?: true
  run(api: OpApi, args: A): Promise<JsonValue>
}): Op {
  const validator = compile(definition.args)
  return {
    name: definition.name,
    actors: definition.actors,
    ...(definition.receipts === undefined ? {} : { receipts: definition.receipts }),
    ...(definition.credentials === undefined ? {} : { credentials: definition.credentials }),
    ...(definition.read === undefined ? {} : { read: definition.read }),
    invoke: async (api, args) => {
      if (!validator.check(args)) {
        const message = validator
          .errors(args)
          .map((error) => `${error.path} ${error.message}`)
          .join("; ")
        return { kind: "rejected", code: "bad_args", message }
      }
      try {
        return { kind: "ok", result: await definition.run(api, args) }
      } catch (error) {
        if (error instanceof OpRejected)
          return {
            kind: "rejected",
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          }
        throw error
      }
    },
  }
}

const scrub = (value: unknown, fields: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => scrub(item, fields))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, fields.has(key) ? "[redacted]" : scrub(item, fields)]),
  )
}

/** The command as `ops/before` listeners see it: every credential field, however deep, replaced, so no policy row reads one. */
export function redacted(command: Command, op: Op | undefined): Command {
  const fields = op?.credentials
  return fields === undefined ? command : { ...command, args: scrub(command.args, new Set(fields)) }
}

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "object" && value !== null && "kind" in value && (value.kind === "ok" || value.kind === "rejected")

export type CommandDeps = {
  readonly db: SqliteDatabase
  op(name: string): Op | undefined
  harness(): Harness | undefined
  around(command: Command, actor: Actor, invoke: () => Promise<Outcome>): Promise<Outcome>
}

export class Commands {
  readonly #inflight = new Map<CommandId, Promise<Outcome>>()
  #sweptAt = 0

  constructor(private readonly deps: CommandDeps) {}

  run(command: Command, actor: Actor): Promise<Outcome> {
    const running = this.#inflight.get(command.id)
    if (running !== undefined) return running
    const started = this.#run(command, actor).finally(() => this.#inflight.delete(command.id))
    this.#inflight.set(command.id, started)
    return started
  }

  async #run(command: Command, actor: Actor): Promise<Outcome> {
    if (this.deps.op(command.op)?.receipts === false)
      return this.deps.around(command, actor, () => this.#invoke(command, actor))
    const receipt = await this.deps.db.get<{ outcome: string }>(
      "SELECT outcome FROM receipts WHERE command_id = ?",
      command.id,
    )
    if (receipt !== undefined) {
      const stored: unknown = JSON.parse(receipt.outcome)
      if (isOutcome(stored)) return stored
    }
    const outcome = await this.deps.around(command, actor, () => this.#invoke(command, actor))
    if (
      outcome.kind === "rejected" &&
      (outcome.code === "failed" ||
        outcome.code === "unavailable" ||
        outcome.code === "busy" ||
        outcome.code === "consent_required")
    )
      return outcome
    const now = Date.now()
    await this.deps.db.run(
      "INSERT OR IGNORE INTO receipts (command_id, outcome, at) VALUES (?, ?, ?)",
      command.id,
      JSON.stringify(outcome),
      now,
    )
    if (now - this.#sweptAt >= RECEIPT_SWEEP_MS) {
      this.#sweptAt = now
      await this.deps.db.run("DELETE FROM receipts WHERE at < ?", now - RECEIPT_TTL_MS)
    }
    return outcome
  }

  async #invoke(command: Command, actor: Actor): Promise<Outcome> {
    const harness = this.deps.harness()
    if (harness === undefined) return { kind: "rejected", code: "unavailable", message: "Home is not ready" }
    const op = this.deps.op(command.op)
    if (op === undefined) return { kind: "rejected", code: "unknown_op", message: `no op ${command.op}` }
    if (!op.actors.includes(actor.kind))
      return { kind: "rejected", code: "forbidden", message: `${actor.kind} may not run ${command.op}` }
    try {
      return await op.invoke({ harness, actor, commandId: command.id }, command.args)
    } catch (error) {
      return { kind: "rejected", code: "failed", message: error instanceof Error ? error.message : String(error) }
    }
  }
}
