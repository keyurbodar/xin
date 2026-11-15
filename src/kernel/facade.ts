import { type Context, symbols } from "@deepseek-ai/cordis"
import { grants, type Permission } from "./manifest.ts"

export type Caller = { readonly id: string; readonly permissions: readonly Permission[] }

/** One member a plugin row may use: the permission it takes, a guard on each call, and a view of what comes back. */
type Member = {
  readonly needs?: Permission
  readonly guard?: (caller: Caller, args: readonly unknown[]) => void
  readonly view?: (value: unknown) => unknown
}

const method = (value: unknown, name: string): ((...args: unknown[]) => unknown) => {
  const member: unknown = typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined
  if (typeof member !== "function") throw new Error(`${name} is not available`)
  return (...args) => Reflect.apply(member, value, args)
}

/** A model catalog without its credentials: lookups only, no `getAuth`, `login` or `logout`. */
const modelsView = (models: unknown): unknown =>
  Object.freeze({ getModel: method(models, "getModel"), getAvailable: method(models, "getAvailable") })

/** The pi registry for reading what is registered, never for registering. */
const registryView = (registry: unknown): unknown => Object.freeze({ snapshot: method(registry, "snapshot") })

/**
 * What a plugin row may touch on each kernel service, by the service's name. Anything not listed is absent from the
 * facade: data members and methods are denied by default.
 */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, Member>>>> = {
  ops: {
    define: {},
    list: {},
    run: {
      guard: (caller, [, actor]) => {
        const kind: unknown = typeof actor === "object" && actor !== null ? Reflect.get(actor, "kind") : undefined
        if (kind === "agent" || (kind === "owner" && grants(caller.permissions, "owner"))) return
        throw new Error(`${caller.id} may run ops only as an agent, not as ${String(kind)}`)
      },
    },
  },
  wire: { home: {}, publishHome: {}, announce: {} },
  pi: {
    install: {},
    env: {},
    extensions: {},
    conversations: { needs: "conversations" },
    models: { needs: "models" },
    currentModels: { needs: "models", view: modelsView },
    registry: { view: registryView },
  },
  clock: { arm: {}, timer: {} },
  http: { route: {} },
  secrets: { get: {}, set: {} },
  loader: {
    locate: {},
    composition: { needs: "plugins" },
    pluginOfRow: { needs: "plugins" },
    rows: { needs: "plugins" },
    state: { needs: "plugins" },
  },
}

const faces = new WeakMap<object, WeakMap<Context, object>>()

/**
 * What a plugin row holds for a Cordis service it reads through `ctx`: a frozen object with only the members `ALLOWED`
 * names for that service, forwarding to it as that row. It has no `ctx`, no `cordis.original` and no prototype, so
 * nothing on it leads to the kernel context behind the service. Any other value passes through unchanged.
 */
export function facade(value: unknown, ctx: Context, caller: Caller): unknown {
  if (typeof value !== "object" || value === null) return value
  const raw: unknown = Reflect.get(value, symbols.original)
  if (typeof raw !== "object" || raw === null) return value
  const known = faces.get(raw)?.get(ctx)
  if (known !== undefined) return known
  const face: Record<string, unknown> = Object.create(null)
  for (const [name, member] of Object.entries(ALLOWED[String(Reflect.get(raw, "name"))] ?? {}))
    Object.defineProperty(face, name, {
      enumerable: true,
      get: () => {
        if (member.needs !== undefined && !grants(caller.permissions, member.needs))
          throw new Error(`${caller.id} uses ${name} without declaring the ${member.needs} permission`)
        const inner: unknown = Reflect.get(value, name)
        if (typeof inner !== "function") return member.view === undefined ? inner : member.view(inner)
        return (...args: unknown[]): unknown => {
          member.guard?.(caller, args)
          const result: unknown = Reflect.apply(inner, value, args)
          return member.view === undefined ? result : member.view(result)
        }
      },
    })
  Object.freeze(face)
  const byContext = faces.get(raw) ?? new WeakMap<Context, object>()
  byContext.set(ctx, face)
  faces.set(raw, byContext)
  return face
}
