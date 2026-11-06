import { type Context, Service } from "@deepseek-ai/cordis"

export type Route = (request: Request) => Promise<Response>

export class Http extends Service {
  readonly routes = new Map<string, Route>()

  constructor(ctx: Context) {
    super(ctx, "http")
  }

  route(key: string, handler: Route): () => void {
    return this.ctx.effect(() => {
      if (this.routes.has(key)) throw new Error(`route ${key} is already taken`)
      this.routes.set(key, handler)
      return () => {
        if (this.routes.get(key) === handler) this.routes.delete(key)
      }
    }, `http.route(${key})`)
  }

  find(request: Request): Route | undefined {
    const key = `${request.method} ${new URL(request.url).pathname}`
    const exact = this.routes.get(key)
    if (exact !== undefined) return exact
    for (const [pattern, handler] of this.routes)
      if (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1))) return handler
    return undefined
  }
}
