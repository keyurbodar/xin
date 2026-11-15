export type Drop = "journal" | "all"

export type RepairReport = { readonly failure: string | null; readonly journal: number; readonly checkpoint: number }

export type RepairAnswer =
  | { readonly kind: "report"; readonly report: RepairReport }
  | { readonly kind: "open" }
  | { readonly kind: "unauthorized" }

export type RepairOffer = {
  readonly drop: Drop
  readonly title: string
  readonly detail: string
  readonly confirm: string
  readonly word?: string | undefined
}

export const EMPTY_WORD = "empty"

const LOST =
  "Projects and their threads, schedules, jobs, captains, goals, questions and artifacts are pi documents, so they are gone."

export const KEPT =
  "Every drop keeps the home’s own tables and storage: provider keys, files, plugin rows and their config, your name and instructions, model defaults, notification settings, memory notes, presets and daily usage totals."

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`
}

/**
 * Without a checkpoint there is nothing to rewind to, so dropping the journal empties pi just as dropping both does:
 * that case is offered only as Start from empty, behind the typed word.
 */
export function repairOffers(report: RepairReport): readonly RepairOffer[] {
  const empty = (drop: Drop): RepairOffer => ({
    drop,
    title: "Start from empty",
    detail: `Discards ${drop === "all" ? "the checkpoint and the journal" : `the journal (${count(report.journal, "row")}), and there is no checkpoint to reopen from`}. ${LOST}`,
    confirm: "Start from empty",
    word: EMPTY_WORD,
  })
  if (report.checkpoint === 0) return report.journal > 0 ? [empty("journal")] : []
  const rewind: RepairOffer = {
    drop: "journal",
    title: "Drop the journal",
    detail: `Rewinds to the last checkpoint: the ${count(report.journal, "change")} written since it are lost, and everything up to it stays.`,
    confirm: "Drop journal",
  }
  return report.journal > 0 ? [rewind, empty("all")] : [empty("all")]
}

export function confirmed(offer: RepairOffer, typed: string): boolean {
  return offer.word === undefined || typed.trim().toLowerCase() === offer.word
}

export async function parseRepairReply(response: Response): Promise<RepairAnswer> {
  if (response.status === 409) return { kind: "open" }
  if (response.status === 401) return { kind: "unauthorized" }
  if (!response.ok) throw new Error(`repair: HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null) throw new Error("repair: unreadable reply")
  const failure = Reflect.get(body, "failure")
  const journal = Reflect.get(body, "journal")
  const checkpoint = Reflect.get(body, "checkpoint")
  return {
    kind: "report",
    report: {
      failure: typeof failure === "string" ? failure : null,
      journal: typeof journal === "number" ? journal : 0,
      checkpoint: typeof checkpoint === "number" ? checkpoint : 0,
    },
  }
}
