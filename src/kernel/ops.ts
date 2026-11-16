import { type Context, Service } from "@deepseek-ai/cordis"
import { loaderRow } from "../contributions.ts"
import type { Harness } from "@earendil-works/pi-durable"
import { type Actor, type Command, Commands, type Op, type Outcome, redacted } from "../ops.ts"
import { hidden } from "./hidden.ts"
import { grants } from "./manifest.ts"
import type { IngleLoader } from "./loader.ts"

type State = {
  readonly own: Context
  readonly commands: Commands
  readonly defined: Map<string, Op>
  readonly rows: Map<string, string | undefined>
}

const state = hidden<Ops, State>()

const kernelOf = (ops: Ops): IngleLoader | undefined => state.get(ops).own.get("kernel")

/** An op from a row that does not declare `conversations`: its handler gets a harness that refuses every use. */
function withoutHarness(op: Op, row: string | undefined): Op {
  const refused = (): never => {
    throw new Error(`${row} uses the harness without declaring the conversations permission`)
  }
  const harness = new Proxy<Harness>(Object.create(null), { get: refused, has: refused, ownKeys: refused })
  return { ...op, invoke: (api, args) => op.invoke({ ...api, harness }, args) }
}

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
        around: (command, actor, invoke) =>
          ctx.waterfall("ops/before", { command: redacted(command, defined.get(command.op)), actor }, invoke),
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
      const permissions = row === undefined ? undefined : kernel?.permissionsOf(row)
      const held = permissions === undefined || grants(permissions, "conversations") ? op : withoutHarness(op, row)
      defined.set(op.name, held)
      rows.set(op.name, row)
      return () => {
        if (defined.get(op.name) !== held) return
        defined.delete(op.name)
        rows.delete(op.name)
      }
    }, `ops.define(${op.name})`)
  }

  run(command: Command, actor: Actor): Promise<Outcome> {
    return state.get(this).commands.run(command, actor)
  }

  list(): readonly string[] {
    return [...state.get(this).defined.keys()].toSorted()
  }

  /** The op is defined and declares that it changes no owner state. */
  reads(name: string): boolean {
    return state.get(this).defined.get(name)?.read === true
  }
}
