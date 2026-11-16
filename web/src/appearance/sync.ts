import { OpError } from "../lib/api.ts"
import { DEFAULT_APPEARANCE, parseAppearance, type Appearance } from "./model.ts"

export type Change = (current: Appearance) => Appearance

export type HomeCopy = { readonly doc: string | null; readonly rev: number }

/** What one tab needs from the world: the home's row, the shown document, and the other tabs. */
export type SyncPort = {
  readonly read: () => Promise<HomeCopy>
  readonly write: (doc: string, rev: number) => Promise<{ readonly rev: number }>
  readonly current: () => Appearance
  readonly show: (next: Appearance) => void
  readonly broadcast: (message: unknown) => void
  readonly status: (state: "saving" | "saved" | "failed") => void
}

export type Sync = {
  readonly edit: (change: Change) => void
  readonly save: () => Promise<void>
  readonly pull: () => Promise<void>
  readonly receive: (message: unknown) => void
}

const replay = (onto: Appearance, changes: readonly Change[]): Appearance =>
  changes.reduce((doc, change) => parseAppearance(change(doc)), onto)

const MAX_ATTEMPTS = 3

/**
 * One tab's view of the home's appearance row. Edits not yet saved are kept and replayed onto the home's
 * latest copy on every save, refused save and read, so an edit never overwrites newer settings from another
 * tab or device and never vanishes under them.
 */
export function createSync(port: SyncPort): Sync {
  let home: { readonly rev: number; readonly doc: Appearance | undefined } | undefined
  let pending: readonly Change[] = []

  const readHome = async (): Promise<NonNullable<typeof home>> => {
    const reply = await port.read()
    home = { rev: reply.rev, doc: reply.doc === null ? undefined : parseAppearance(JSON.parse(reply.doc)) }
    return home
  }

  const save = async (): Promise<void> => {
    if (port.current().sync !== "synced") {
      pending = []
      return
    }
    port.status("saving")
    try {
      for (let attempt = 1; ; attempt += 1) {
        const known = home ?? (await readHome())
        const included = pending
        const next = known.doc === undefined ? port.current() : replay(known.doc, included)
        try {
          const reply = await port.write(JSON.stringify(next), known.rev)
          home = { rev: reply.rev, doc: next }
          pending = pending.slice(included.length)
          port.show(replay(next, pending))
          port.broadcast({ kind: "saved", rev: reply.rev, doc: next })
          port.status("saved")
          return
        } catch (problem) {
          if (!(problem instanceof OpError && problem.code === "busy") || attempt >= MAX_ATTEMPTS) throw problem
          home = undefined
        }
      }
    } catch {
      port.status("failed")
    }
  }

  const edit = (change: Change): void => {
    pending = [...pending, change]
    const next = parseAppearance(change(port.current()))
    port.show(next)
    port.broadcast({ kind: "doc", doc: next })
  }

  const pull = async (): Promise<void> => {
    const known = await readHome().catch(() => undefined)
    if (known === undefined) return
    const local = port.current()
    if (local.sync === "device") return
    if (known.doc === undefined) {
      if (local.sync === "synced" && JSON.stringify(local) !== JSON.stringify(DEFAULT_APPEARANCE)) await save()
      return
    }
    const next = replay(known.doc, pending)
    if (JSON.stringify(next) !== JSON.stringify(local)) port.show(next)
  }

  const receive = (data: unknown): void => {
    if (typeof data !== "object" || data === null || !("kind" in data) || !("doc" in data)) return
    const doc = parseAppearance(data.doc)
    if (data.kind === "saved" && "rev" in data && typeof data.rev === "number" && data.rev > (home?.rev ?? -1)) {
      home = { rev: data.rev, doc }
      port.show(replay(doc, pending))
    }
    if (data.kind === "doc" && pending.length === 0) port.show(doc)
  }

  return { edit, save, pull, receive }
}
