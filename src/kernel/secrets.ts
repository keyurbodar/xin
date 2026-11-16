import { type Context, Service } from "@deepseek-ai/cordis"
import { obj, str } from "@earendil-works/pi-schema"
import { defineOp } from "../ops.ts"
import { FragmentId } from "../rowid.ts"
import { Sealer } from "../seal.ts"
import { hidden } from "./hidden.ts"
import type { IngleLoader } from "./loader.ts"
import { redact, redactionExtension } from "./redaction.ts"
import { CredentialStore } from "./sealed.ts"

type State = { readonly own: Context; store: CredentialStore | undefined }

const state = hidden<Secrets, State>()

const kernelOf = (secrets: Secrets): IngleLoader | undefined => state.get(secrets).own.get("kernel")

function sealed(secrets: Secrets): CredentialStore {
  const { store } = state.get(secrets)
  if (store === undefined) throw new Error("credentials are not loaded yet")
  return store
}

export class Secrets extends Service {
  static readonly inject = ["host", "db", "pi", "ops"]

  constructor(ctx: Context) {
    super(ctx, "secrets")
    state.set(this, { own: ctx, store: undefined })
  }

  async [Service.init](): Promise<void> {
    const store = new CredentialStore(this.ctx.db, new Sealer(this.ctx.host.env.KEK))
    await store.load()
    state.get(this).store = store
    this.ctx.pi.install(redactionExtension(() => store.values()))
    this.ctx.ops.define(
      defineOp({
        name: "secret.set",
        args: obj({ ref: FragmentId, value: str() }),
        actors: ["owner"],
        credentials: ["value"],
        run: async (_api, { ref, value }) => {
          await this.set(ref, value)
          return { application: "applied", ref }
        },
      }),
    )
  }

  get(ref: string): string | undefined {
    return sealed(this).get(ref)
  }

  async set(ref: string, value: string): Promise<void> {
    await sealed(this).set(ref, value)
    this.ctx.emit("credentials/updated", ref)
  }

  /** `text` with every stored credential value replaced by `[redacted]`, so a row can redact without reading a value. */
  redact(text: string): string {
    return redact(text, sealed(this).values())
  }

  /** Every plaintext value, for redaction. A plugin row's facade refuses this; a kernel row is refused here. */
  values(): readonly string[] {
    if (kernelOf(this)?.locate(this.ctx.fiber) !== undefined)
      throw new Error("credential values are only readable by the kernel")
    return sealed(this).values()
  }
}
