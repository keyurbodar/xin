import type { TestEnv } from "./worker.ts"

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.ts")
    }
  }
}
