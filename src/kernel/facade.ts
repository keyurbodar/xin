import { type Context, Service, symbols } from "@deepseek-ai/cordis"
import { grants, type Permission } from "./manifest.ts"

export type Caller = { readonly id: string; readonly permissions: readonly Permission[] }

type Guard = (caller: Caller, args: readonly unknown[]) => void

const kernelOnly =
  (what: string): Guard =>
  (caller) => {
    throw new Error(`${caller.id} may not ${what}; only the kernel may`)
  }

/** Calls a plugin row may not make even with the service in hand, keyed by service and method. */
const GUARDS: Readonly<Record<string, Readonly<Record<string, Guard>>>> = {
  ops: {
    run: (caller, [, actor]) => {
      const kind: unknown = typeof actor === "object" && actor !== null ? Reflect.get(actor, "kind") : undefined
      if (kind === "agent" || (kind === "owner" && grants(caller.permissions, "owner"))) return
      throw new Error(`${caller.id} may run ops only as an agent, not as ${String(kind)}`)
    },
  },
  wire: { message: kernelOnly("deliver socket frames"), closed: kernelOnly("close sockets") },
  secrets: { values: kernelOnly("read every credential value") },
}

const faces = new WeakMap<object, WeakMap<Context, object>>()

const memberNames = (raw: object): ReadonlySet<string> => {
  const names = new Set<string>()
  for (
    let proto: object | null = raw;
    proto !== null && proto !== Object.prototype && proto !== Service.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const name of Object.getOwnPropertyNames(proto))
      if (name !== "constructor" && name !== "ctx" && !name.startsWith("_")) names.add(name)
  return names
}

/**
 * What a plugin row holds for a Cordis service it reads through `ctx`: a frozen object whose members forward to the
 * service as that row, with no `ctx`, no `cordis.original` and no prototype, so nothing on it leads to the kernel
 * context behind the service. Any other value passes through unchanged.
 */
export function facade(value: unknown, ctx: Context, caller: Caller): unknown {
  if (typeof value !== "object" || value === null) return value
  const raw: unknown = Reflect.get(value, symbols.original)
  if (typeof raw !== "object" || raw === null) return value
  const known = faces.get(raw)?.get(ctx)
  if (known !== undefined) return known
  const guards = GUARDS[String(Reflect.get(raw, "name"))] ?? {}
  const face: Record<string, unknown> = Object.create(null)
  for (const name of memberNames(raw))
    Object.defineProperty(face, name, {
      enumerable: true,
      get: () => {
        const member: unknown = Reflect.get(value, name)
        if (typeof member !== "function") return facade(member, ctx, caller)
        const guard = guards[name]
        return (...args: unknown[]): unknown => {
          guard?.(caller, args)
          return facade(Reflect.apply(member, value, args), ctx, caller)
        }
      },
    })
  Object.freeze(face)
  const byContext = faces.get(raw) ?? new WeakMap<Context, object>()
  byContext.set(ctx, face)
  faces.set(raw, byContext)
  return face
}
