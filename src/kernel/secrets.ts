import { type Context, Service } from "@deepseek-ai/cordis"
import { obj, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { FragmentId } from "../rowid.ts"
import { Sealer } from "../seal.ts"
import { redactionExtension } from "./redaction.ts"
import { CredentialStore } from "./sealed.ts"

export class Secrets extends Service {
  static readonly inject = ["host", "db", "pi", "ops"]

  private store: CredentialStore | undefined

  constructor(ctx: Context) {
    super(ctx, "secrets")
  }

  async [Service.init](): Promise<void> {
    const store = new CredentialStore(this.ctx.db, new Sealer(this.ctx.host.env.KEK))
    await store.load()
    this.store = store
    this.ctx.pi.install(redactionExtension(() => store.values()))
    this.ctx.ops.define(
      defineOp({
        name: "secret.set",
        args: obj({ ref: FragmentId, value: str() }),
        actors: ["owner"],
        run: async (_api, { ref, value }) => {
          await this.set(ref, value)
          return { application: "applied", ref }
        },
      }),
    )
  }

  get(ref: string): string | undefined {
    return this.sealed().get(ref)
  }

  async set(ref: string, value: string): Promise<void> {
    await this.sealed().set(ref, value)
    this.ctx.emit("credentials/updated", ref)
  }

  values(): readonly string[] {
    if (this.row() !== undefined) throw new Error("credential values are only readable by the kernel")
    return this.sealed().values()
  }

  private row(): string | undefined {
    return this.ctx.get("kernel")?.locate(this.ctx.fiber)
  }

  private sealed(): CredentialStore {
    if (this.store === undefined) throw new Error("credentials are not loaded yet")
    return this.store
  }
}
