import { expect, test } from "bun:test"
import { confirmed, EMPTY_WORD, parseRepairReply, repairOffers } from "./repair.ts"

const offersFor = (journal: number, checkpoint: number) =>
  repairOffers({ failure: "boom", journal, checkpoint }).map((offer) => ({
    drop: offer.drop,
    title: offer.title,
    typed: offer.word !== undefined,
  }))

test("a journal over a checkpoint offers the rewind, then Start from empty behind the typed word", () => {
  expect(offersFor(214, 7)).toEqual([
    { drop: "journal", title: "Drop the journal", typed: false },
    { drop: "all", title: "Start from empty", typed: true },
  ])
})

test("with no checkpoint, dropping the journal is offered only as Start from empty, never as a rewind", () => {
  expect(offersFor(1, 0)).toEqual([{ drop: "journal", title: "Start from empty", typed: true }])
  const [only] = repairOffers({ failure: "boom", journal: 1, checkpoint: 0 })
  expect(only?.detail).toContain("no checkpoint")
  expect(only?.detail).toContain("Projects")
  expect(only?.detail).not.toContain("reopens from")
})

test("a checkpoint with an empty journal offers only Start from empty, and nothing stored offers nothing", () => {
  expect(offersFor(0, 3)).toEqual([{ drop: "all", title: "Start from empty", typed: true }])
  expect(offersFor(0, 0)).toEqual([])
})

test("the typed gate opens only on the word shown, ignoring case and surrounding space", () => {
  const [rewind, empty] = repairOffers({ failure: "boom", journal: 2, checkpoint: 1 })
  if (rewind === undefined || empty === undefined) throw new Error("expected two offers")
  expect(confirmed(rewind, "")).toBe(true)
  expect(confirmed(empty, "")).toBe(false)
  expect(confirmed(empty, "empt")).toBe(false)
  expect(confirmed(empty, "drop")).toBe(false)
  expect(confirmed(empty, ` ${EMPTY_WORD.toUpperCase()} `)).toBe(true)
})

test("parseRepairReply reads the report, an open home and a signed-out token", async () => {
  const reply = (status: number, body?: unknown) =>
    parseRepairReply(new Response(body === undefined ? null : JSON.stringify(body), { status }))
  expect(await reply(200, { failure: "bad row", journal: 3, checkpoint: 0 })).toEqual({
    kind: "report",
    report: { failure: "bad row", journal: 3, checkpoint: 0 },
  })
  expect(await reply(200, { failure: null, journal: 0, checkpoint: 0 })).toEqual({
    kind: "report",
    report: { failure: null, journal: 0, checkpoint: 0 },
  })
  expect(await reply(409, { error: "busy" })).toEqual({ kind: "open" })
  expect(await reply(401)).toEqual({ kind: "unauthorized" })
  await expect(reply(500)).rejects.toThrow("HTTP 500")
  await expect(reply(200)).rejects.toThrow("unreadable")
})
