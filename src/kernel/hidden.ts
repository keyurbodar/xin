import { symbols } from "@deepseek-ai/cordis"

/**
 * State a kernel service keeps out of reach of the code it serves. Cordis calls service methods through proxies, so
 * neither `#private` fields nor TypeScript `private` hide anything; this map is module-private and keyed by the
 * service itself, whichever proxy the method was called through.
 */
export function hidden<S extends object, V>(): { get(service: S): V; set(service: S, value: V): void } {
  const values = new WeakMap<object, V>()
  const key = (service: S): object => Reflect.get(service, symbols.original) ?? service
  return {
    get(service) {
      const value = values.get(key(service))
      if (value === undefined) throw new Error("this service is not set up yet")
      return value
    },
    set(service, value) {
      values.set(key(service), value)
    },
  }
}
