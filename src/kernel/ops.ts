import { type Context, Service } from "@deepseek-ai/cordis"
import { loaderRow } from "../contributions.ts"
import { type Actor, type Command, Commands, type Op, type Outcome } from "../ops.ts"
import { hidden } from "./hidden.ts"
import type { IngleLoader } from "./loader.ts"

type State = {
  readonly own: Context
  readonly commands: Commands
  readonly defined: Map<string, Op>
  readonly rows: Map<string, string | undefined>
}

const state = hidden<Ops, State>()

const kernelOf = (ops: Ops): IngleLoader | undefined => state.get(ops).own.get("kernel")

export class Ops extends Service {
  static readonly inject = ["db"]

  constructor(ctx: Context) {
    super(ctx, "ops")
    const defined = new Map<string, Op>()
    state.set(this, {
      own: ctx,
      defined,
      rows: new Map(),
      commands: new Commands({
        db: ctx.db,
        op: (name) => defined.get(name),
        harness: () => ctx.get("harness"),
        around: (command, actor, invoke) => ctx.waterfall("ops/before", { command, actor }, invoke),
      }),
    })
  }

  /** The loader row that defined each op, for the doctor's inventory. */
  get rows(): ReadonlyMap<string, string | undefined> {
    return new Map(state.get(this).rows)
  }

  define(op: Op): () => void {
    const row = loaderRow(this.ctx)
    const { defined, rows } = state.get(this)
    const kernel = kernelOf(this)
    return this.ctx.effect(() => {
      if (defined.has(op.name)) throw new Error(`op ${op.name} is already defined`)
      const undeclared = kernel?.undeclared(row, "ops", op.name)
      if (undeclared !== undefined) throw new Error(undeclared)
      defined.set(op.name, op)
      rows.set(op.name, row)
      return () => {
        if (defined.get(op.name) !== op) return
        defined.delete(op.name)
        rows.delete(op.name)
      }
    }, `ops.define(${op.name})`)
  }

  /** Run one command. A plugin row may act only for an agent: acting as the owner would let it run any op. */
  run(command: Command, actor: Actor): Promise<Outcome> {
    const row = kernelOf(this)?.pluginRow(this.ctx.fiber)
    if (actor.kind !== "agent" && row !== undefined)
      return Promise.reject(new Error(`${row} may run ops only as an agent, not as ${actor.kind}`))
    return state.get(this).commands.run(command, actor)
  }

  list(): readonly string[] {
    return [...state.get(this).defined.keys()].toSorted()
  }
}
