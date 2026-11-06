import { type Context, Service } from "@deepseek-ai/cordis"
import { obj, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { Sealer } from "../seal.ts"
import { redactionExtension } from "./redaction.ts"
import { PluginSecrets } from "./sealed.ts"

const RowId = str({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" })

type LoaderLookup = { locate(fiber: Context["fiber"]): string | undefined }

export class Secrets extends Service {
  static readonly inject = ["host", "db", "pi", "ops"]

  private store: PluginSecrets | undefined

  constructor(ctx: Context) {
    super(ctx, "secrets")
  }

  async [Service.init](): Promise<void> {
    const store = new PluginSecrets(this.ctx.db, new Sealer(this.ctx.host.env.KEK))
    await store.load()
    this.store = store
    this.ctx.pi.install(redactionExtension(() => store.values()))
    this.ctx.ops.define(
      defineOp({
        name: "plugin.secret.set",
        args: obj({ id: RowId, key: str(), value: str() }),
        actors: ["owner"],
        run: async (_api, { id, key, value }) => {
          await store.set(id, key, value)
          return { application: "applied", id, key }
        },
      }),
    )
  }

  get(key: string): string | undefined {
    return this.sealed().forRow(this.requireRow()).get(key)
  }

  async set(key: string, value: string): Promise<void> {
    await this.sealed().set(this.requireRow(), key, value)
  }

  values(): readonly string[] {
    if (this.row() !== undefined) throw new Error("secret values are only readable by the kernel")
    return this.sealed().values()
  }

  private row(): string | undefined {
    const loader: LoaderLookup | undefined = this.ctx.get("loader")
    return loader?.locate(this.ctx.fiber)
  }

  private requireRow(): string {
    const id = this.row()
    if (id === undefined) throw new Error("secrets are available only inside a plugin row")
    return id
  }

  private sealed(): PluginSecrets {
    if (this.store === undefined) throw new Error("secrets are not loaded yet")
    return this.store
  }
}
