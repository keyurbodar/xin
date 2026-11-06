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
      readonly code: "unknown_op" | "bad_args" | "forbidden" | "failed"
      readonly message: string
    }

export type Op = {
  readonly name: string
  readonly actors: readonly Actor["kind"][]
  invoke(api: OpApi, args: unknown): Promise<Outcome>
}

export type Command = { readonly id: CommandId; readonly op: string; readonly args: unknown }

const RECEIPT_TTL_MS = 24 * 60 * 60_000

export function defineOp<A>(definition: {
  readonly name: string
  readonly args: Schema<A>
  readonly actors: readonly Actor["kind"][]
  run(api: OpApi, args: A): Promise<JsonValue>
}): Op {
  const validator = compile(definition.args)
  return {
    name: definition.name,
    actors: definition.actors,
    invoke: async (api, args) => {
      if (!validator.check(args)) {
        const message = validator
          .errors(args)
          .map((error) => `${error.path} ${error.message}`)
          .join("; ")
        return { kind: "rejected", code: "bad_args", message }
      }
      return { kind: "ok", result: await definition.run(api, args) }
    },
  }
}

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "object" && value !== null && "kind" in value && (value.kind === "ok" || value.kind === "rejected")

export class Commands {
  readonly #inflight = new Map<CommandId, Promise<Outcome>>()

  constructor(
    private readonly db: SqliteDatabase,
    private readonly ops: ReadonlyMap<string, Op>,
    private readonly harness: Harness,
  ) {}

  run(command: Command, actor: Actor): Promise<Outcome> {
    const running = this.#inflight.get(command.id)
    if (running !== undefined) return running
    const started = this.#run(command, actor).finally(() => this.#inflight.delete(command.id))
    this.#inflight.set(command.id, started)
    return started
  }

  async #run(command: Command, actor: Actor): Promise<Outcome> {
    const receipt = await this.db.get<{ outcome: string }>(
      "SELECT outcome FROM receipts WHERE command_id = ?",
      command.id,
    )
    if (receipt !== undefined) {
      const stored: unknown = JSON.parse(receipt.outcome)
      if (isOutcome(stored)) return stored
    }
    const outcome = await this.#invoke(command, actor)
    if (outcome.kind === "rejected" && outcome.code === "failed") return outcome
    const now = Date.now()
    await this.db.run(
      "INSERT OR IGNORE INTO receipts (command_id, outcome, at) VALUES (?, ?, ?)",
      command.id,
      JSON.stringify(outcome),
      now,
    )
    await this.db.run("DELETE FROM receipts WHERE at < ?", now - RECEIPT_TTL_MS)
    return outcome
  }

  async #invoke(command: Command, actor: Actor): Promise<Outcome> {
    const op = this.ops.get(command.op)
    if (op === undefined) return { kind: "rejected", code: "unknown_op", message: `no op ${command.op}` }
    if (!op.actors.includes(actor.kind))
      return { kind: "rejected", code: "forbidden", message: `${actor.kind} may not run ${command.op}` }
    try {
      return await op.invoke({ harness: this.harness, actor, commandId: command.id }, command.args)
    } catch (error) {
      return { kind: "rejected", code: "failed", message: error instanceof Error ? error.message : String(error) }
    }
  }
}
