import { type Context, Service } from "@deepseek-ai/cordis"
import { type Actor, type Command, Commands, type Op, type Outcome } from "../ops.ts"

export class Ops extends Service {
  static readonly inject = ["db"]

  readonly defined = new Map<string, Op>()
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
    return this.ctx.effect(() => {
      if (this.defined.has(op.name)) throw new Error(`op ${op.name} is already defined`)
      this.defined.set(op.name, op)
      return () => {
        if (this.defined.get(op.name) === op) this.defined.delete(op.name)
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
