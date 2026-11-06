import type { Context } from "@deepseek-ai/cordis"
import type { HostModule, ModuleDeps } from "../module.ts"

export const MODULE_INJECT = ["host", "db", "pi", "harness", "ops", "http", "wire", "clock"]

export function hostModule(name: string, create: (deps: ModuleDeps) => HostModule) {
  return {
    name,
    inject: MODULE_INJECT,
    async apply(ctx: Context): Promise<void> {
      const deps: ModuleDeps = {
        ctx: ctx.host.state,
        env: ctx.host.env,
        db: ctx.db,
        providers: ctx.host.providers,
        harness: () => ctx.harness,
        arm: (wake) => ctx.clock.arm(wake),
        run: (command, actor) => ctx.ops.run(command, actor),
        publishHome: () => ctx.wire.publishHome(),
        install: (extension) => ctx.pi.install(extension),
      }
      const module = create(deps)
      for (const [key, value] of Object.entries(module.provides ?? {})) ctx.provide(key, value)
      for (const extension of module.extensions ?? []) ctx.pi.install(extension)
      for (const op of module.ops ?? []) ctx.ops.define(op)
      for (const [key, route] of Object.entries(module.routes ?? {})) ctx.http.route(key, route)
      if (module.models !== undefined) ctx.pi.models(module.models)
      if (module.env !== undefined) ctx.pi.env(module.env)
      if (module.home !== undefined) ctx.wire.home(name, module.home)
      if (module.typing !== undefined)
        ctx.on("wire/typing", async (conversation, on) => module.typing?.(conversation, on))
      if (module.due !== undefined || module.fire !== undefined)
        ctx.clock.timer({ due: async () => module.due?.(), fire: async (now) => module.fire?.(now) })
      const stop = await module.start?.()
      if (stop !== undefined) ctx.effect(() => stop, `${name}.start`)
    },
  }
}
