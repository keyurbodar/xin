import type { Context } from "./kernel/index.ts"

export type Contribution<T> = {
  readonly source: string
  readonly key: string
  readonly value: T
}

/** A keyed contribution set. Keys are unique across sources, and views are sorted by key. */
export type ContributionSet<T> = {
  /** Add a value from a source. Throws when another contribution already holds its key. */
  add(source: string, value: T): () => void
  get(key: string): Contribution<T> | undefined
  entries(): readonly Contribution<T>[]
  values(): readonly T[]
}

export type ContributionKeys<T> = {
  key(value: T): string
  label?(key: string): string
}

const byKey = <T>(left: Contribution<T>, right: Contribution<T>): number =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0

export function createContributions<T>({ key, label = (name) => name }: ContributionKeys<T>): ContributionSet<T> {
  const held = new Map<string, Contribution<T>>()
  const sorted = (): readonly Contribution<T>[] => [...held.values()].toSorted(byKey)
  return {
    add(source, value) {
      const name = key(value)
      const existing = held.get(name)
      if (existing !== undefined) throw new Error(`${label(name)} is already contributed by ${existing.source}`)
      const contribution: Contribution<T> = { source, key: name, value }
      held.set(name, contribution)
      return () => {
        if (held.get(name) !== contribution) return
        held.delete(name)
      }
    },
    get: (name) => held.get(name),
    entries: sorted,
    values: () => sorted().map((contribution) => contribution.value),
  }
}

type LoaderLookup = { locate(fiber: Context["fiber"]): string | undefined }

export function loaderRow(ctx: Context): string | undefined {
  const loader: LoaderLookup | undefined = ctx.get("loader")
  const id = loader?.locate(ctx.fiber)
  return id === "" ? undefined : id
}

/** The loader id of the row this code runs in. Throws when it cannot be located. */
export function rowId(ctx: Context): string {
  const id = loaderRow(ctx)
  if (id === undefined) throw new Error("this code is not running in a loader row, so it has no row id")
  return id
}
