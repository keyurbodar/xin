import type { Context } from "@deepseek-ai/cordis"
import { obj } from "@earendil-works/pi-schema"
import type { CommandId } from "../../src/ids.ts"
import { DEFAULT_MANIFEST } from "../../src/kernel/manifest.ts"
import type { Catalog } from "../../src/kernel/loader.ts"
import type { Row } from "../../src/kernel/layers.ts"
import { defineOp } from "../../src/ops.ts"

const attempt = async (probe: () => unknown): Promise<string> => {
  try {
    await probe()
    return "reached"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const field = (value: unknown, ...path: readonly string[]): unknown => {
  let at = value
  for (const name of path) {
    at = at === null || at === undefined ? undefined : Reflect.get(Object(at), name)
    if (at === undefined) throw new Error(`no ${name}`)
  }
  return at
}

const call = (value: unknown, name: string, ...args: readonly unknown[]): unknown => {
  const method = field(value, name)
  if (typeof method !== "function") throw new Error(`${name} is not callable`)
  return Reflect.apply(method, value, args)
}

const OWNER = { kind: "owner" } as const
const command = (id: string, op: string, args: object = {}) => ({ id: id as CommandId, op, args })

const viaInject = (ctx: Context): Promise<unknown> =>
  new Promise((resolve, reject) => {
    ctx.inject(["db"], (inner) => {
      try {
        resolve(inner.db)
      } catch (error) {
        reject(error)
      }
    })
  })

const fakeSocket = {
  deserializeAttachment: () => ({ id: "probe", subs: [], since: 0 }),
  send: () => undefined,
} as unknown as WebSocket

const reach = {
  name: "k-reach",
  inject: ["ops", "wire", "pi", "clock"],
  apply(ctx: Context) {
    ctx.ops.define(
      defineOp({
        name: "k.reach",
        args: obj({}),
        actors: ["owner"],
        run: async () => {
          const get = ctx.get
          return {
            secret: await attempt(() => ctx.get("secrets")?.get("probe")),
            alias: await attempt(() => get("secrets")?.get("probe")),
            reflect: await attempt(() => field(ctx.reflect.get("host"), "env", "KEK")),
            store: await attempt(() => call(field(ctx.reflect.get("secrets"), "store"), "get", "probe")),
            set: await attempt(() => ctx.reflect.get("secrets")?.set("probe", "attacker")),
            inject: await attempt(() => viaInject(ctx)),
            owner: await attempt(() => ctx.ops.run(command("k-reach-owner", "plugin.list"), OWNER)),
            commands: await attempt(() =>
              call(field(ctx.ops, "commands"), "run", command("k-reach-commands", "plugin.list"), OWNER),
            ),
            defined: await attempt(() =>
              call(call(field(ctx.ops, "defined"), "get", "plugin.list"), "invoke", { actor: OWNER }, {}),
            ),
            sockets: await attempt(() => field(ctx.wire, "sockets", "deps", "ctx", "storage", "sql")),
            rootSecret: await attempt(() => ctx.root.secrets.get("probe")),
            rootHost: await attempt(() => field(ctx.root.host, "env", "KEK")),
            rootOwner: await attempt(() => ctx.root.ops.run(command("k-reach-root", "plugin.list"), OWNER)),
            frame: await attempt(() => ctx.wire.message(fakeSocket, JSON.stringify({ t: "cmd" }))),
          }
        },
      }),
    )
  },
}

export const catalog: Catalog = {
  "k-secret-mount": {
    plugin: { name: "k-secret-mount", inject: ["secrets"], apply() {} },
    title: "k-secret-mount",
    description: "test plugin a market bundle mounts, which declares the secrets permission",
    manifest: { ...DEFAULT_MANIFEST, permissions: ["secrets"], contributes: { tools: [], ops: [] } },
    source: "test",
  },
  "k-reach": {
    plugin: reach,
    title: "k-reach",
    description: "test plugin that reaches past its empty permissions",
    manifest: { ...DEFAULT_MANIFEST, contributes: { tools: [], ops: ["k.reach"] } },
    source: "test",
  },
}

export const rows: readonly Row[] = [{ id: "k-reach", name: "cordis:k-reach" }]
