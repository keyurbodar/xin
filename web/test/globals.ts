import { afterAll, beforeAll } from "bun:test"

export function snapshotGlobals(names: readonly string[]): () => void {
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

export function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

const restores: Array<() => void> = []

export function stubGlobals(values: Readonly<Record<string, unknown>>): void {
  beforeAll(() => {
    restores.push(snapshotGlobals(Object.keys(values)))
    for (const [name, value] of Object.entries(values)) installGlobal(name, value)
  })
  afterAll(() => restores.pop()?.())
}
