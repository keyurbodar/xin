import { describe, expect, it } from "vitest"
import { type Batch, decide, type LiveProbe, probe, stopWordsOnly } from "./dispatch.ts"

const idle: LiveProbe = { busy: false, visibleChars: 0, toolCalls: 0, answered: false }
const running: LiveProbe = { busy: true, visibleChars: 0, toolCalls: 0, answered: false }

const user = (...texts: string[]): Batch => ({ kinds: texts.map(() => "user"), texts })
const report = (text: string): Batch => ({ kinds: ["report"], texts: [text] })

describe("dispatch decision", () => {
  it("starts an idle conversation", () => {
    expect(decide(idle, user("hi"))).toEqual({ kind: "start" })
    expect(decide(idle, user("stop"))).toEqual({ kind: "start" })
  })

  it("stops on a batch of stop words only", () => {
    expect(decide(running, user(" Stop "))).toEqual({ kind: "stop" })
    expect(decide(running, user("stop", "nvm"))).toEqual({ kind: "stop" })
    expect(decide({ ...running, visibleChars: 12 }, user("cancel"))).toEqual({ kind: "stop" })
    expect(decide(running, user("stop please"))).toEqual({ kind: "restart" })
  })

  it("restarts only before anything is visible and only for user batches", () => {
    expect(decide(running, user("more"))).toEqual({ kind: "restart" })
    expect(decide({ ...running, visibleChars: 1 }, user("more"))).toEqual({ kind: "steer" })
    expect(decide({ ...running, toolCalls: 1 }, user("more"))).toEqual({ kind: "steer" })
    expect(decide({ ...running, answered: true }, user("more"))).toEqual({ kind: "steer" })
    expect(decide(running, report("finished"))).toEqual({ kind: "steer" })
  })

  it("probes an idle harness and recognises stop words", () => {
    expect(probe(undefined)).toEqual(idle)
    expect(stopWordsOnly(user("stop"))).toBe(true)
    expect(stopWordsOnly(report("stop"))).toBe(false)
    expect(stopWordsOnly(user("stopping"))).toBe(false)
  })
})
