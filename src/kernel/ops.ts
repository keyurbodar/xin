import { type Context, Service } from "@deepseek-ai/cordis"
import { loaderRow } from "../contributions.ts"
import { type Actor, type Command, Commands, type Op, type Outcome } from "../ops.ts"
import type { IngleLoader } from "./loader.ts"

export class Ops extends Service {
  static readonly inject = ["db"]

  readonly defined = new Map<string, Op>()
  /** The loader row that defined each op, for the doctor's inventory. */
  readonly rows = new Map<string, string | undefined>()
  readonly commands: Commands

  constructor(ctx: Context) {
    super(ctx, "ops")
    this.commands = new Commands({
      db: ctx.db,
      op: (name) => this.defined.get(name),
      harness: () => ctx.get("harness"),
      around: (command, actor, invoke) => ctx.waterfall("ops/before", { command, actor }, invoke),
    })
  }

  define(op: Op): () => void {
    const row = loaderRow(this.ctx)
    const kernel: IngleLoader | undefined = this.ctx.get("kernel")
    return this.ctx.effect(() => {
      if (this.defined.has(op.name)) throw new Error(`op ${op.name} is already defined`)
      const undeclared = kernel?.undeclared(row, "ops", op.name)
      if (undeclared !== undefined) throw new Error(undeclared)
      this.defined.set(op.name, op)
      this.rows.set(op.name, row)
      return () => {
        if (this.defined.get(op.name) !== op) return
        this.defined.delete(op.name)
        this.rows.delete(op.name)
      }
    }, `ops.define(${op.name})`)
  }

  run(command: Command, actor: Actor): Promise<Outcome> {
    return this.commands.run(command, actor)
  }

  list(): readonly string[] {
    return [...this.defined.keys()].toSorted()
  }
}
