import type { Home } from "./host.ts"

export type Env = {
  readonly HOME: DurableObjectNamespace<Home>
  readonly FILES: R2Bucket
  readonly OWNER_TOKEN: string
  readonly KEK: string
}
