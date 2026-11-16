import { expect, test } from "bun:test"
import type { Snapshot } from "../../../state/conversation.ts"
import {
  buildTimeline,
  dayLabel,
  duration,
  groupSummary,
  liveTimelineOf,
  turnPhrase,
  waitPhrase,
  waitTarget,
  type LiveTimeline,
  type TimedMessage,
  type TimelineEntry,
  type ToolCall,
} from "./model.ts"

const NOW = new Date(2026, 10, 16, 12, 0).getTime()
const IDLE: LiveTimeline = { busy: false, parts: [], slots: new Map() }
const OPTIONS = { hasBlock: () => false, titles: new Map([[7, "Docs pass"]]), now: NOW }

const tool = (name: string, status: ToolCall["status"] = "done"): ToolCall => ({ callId: name, name, args: {}, output: undefined, status })
const entry = (id: number, kind: string, model: readonly TimedMessage[], data?: unknown): TimelineEntry => ({ id, kind, model, data })
const ask = (id: number, text: string, at: number): TimelineEntry =>
  entry(id, "xin.batch", [], [{ body: { kind: "user", text }, clientTs: at }])
const answer = (id: number, at: number, ...content: unknown[]): TimelineEntry =>
  entry(id, "pi.assistant", [{ role: "assistant", content, timestamp: at }])
const output = (id: number, at: number, toolCallId: string, text: string, isError = false): TimelineEntry =>
  entry(id, "pi.tool-result", [{ role: "toolResult", toolCallId, content: [{ type: "text", text }], timestamp: at, isError }])
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args })

test("a group's summary counts each kind in working order and names failures", () => {
  expect(groupSummary([tool("bash"), tool("read"), tool("read"), tool("web_search"), tool("edit", "error")])).toBe(
    "Searched 1 time, read 2 files, ran 1 command, made 1 edit, 1 failed",
  )
  expect(groupSummary([tool("mystery")])).toBe("Used 1 tool")
})

test("durations and days read the way the divider writes them", () => {
  expect(duration(87_000)).toBe("1m 27s")
  expect(duration(120_000)).toBe("2m")
  expect(duration(400)).toBe("1s")
  expect(duration(3_900_000)).toBe("1h 5m")
  expect(dayLabel(NOW - 3_600_000, NOW)).toBe("Today")
  expect(dayLabel(NOW - 86_400_000, NOW)).toBe("Yesterday")
})

test("a turn's phrase names two threads and counts more", () => {
  const link = (threadId: number) => ({ threadId, label: `T${threadId}` })
  expect(turnPhrase({ finished: [link(1), link(2), link(3)], started: [], messaged: [link(4)], workedMs: 87_000 })).toEqual([
    "3 threads",
    " finished",
    ", ",
    "messaged ",
    link(4),
    ", ",
    "worked for 1m 27s",
  ])
  expect(turnPhrase({ finished: [link(1), link(2)], started: [], messaged: [], workedMs: undefined })).toEqual([link(1), " and ", link(2), " finished"])
  expect(turnPhrase({ finished: [], started: [], messaged: [], workedMs: 2_000 })).toEqual(["Worked for 2s"])
  expect(waitPhrase({ kind: "threads", threads: [link(1), link(2), link(3), link(4)] })).toEqual([
    "Waiting on ",
    link(1),
    ", ",
    link(2),
    ", and 2 other threads",
  ])
})

test("consecutive calls across answers form one group, text splits groups, and results set status", () => {
  const items = buildTimeline(
    [
      ask(1, "Fix it", NOW - 90_000),
      answer(2, NOW - 80_000, { type: "text", text: "Looking." }, call("a", "read", { path: "a.ts" })),
      output(3, NOW - 79_000, "a", "file a"),
      answer(4, NOW - 70_000, call("b", "bash", { command: "bun test" })),
      output(5, NOW - 60_000, "b", "1 fail", true),
      answer(6, NOW - 50_000, { type: "text", text: "Fixed." }, call("c", "thread_send", { threadId: 7, text: "hi" })),
      output(7, NOW - 40_000, "c", "sent"),
      answer(8, NOW - 3_000, { type: "text", text: "Done." }),
    ],
    IDLE,
    OPTIONS,
  )
  expect(items.map((item) => item.kind)).toEqual(["date", "owner", "text", "tools", "text", "tools", "text", "summary"])
  const first = items[3]
  expect(first?.kind === "tools" ? first.calls.map((entry) => [entry.callId, entry.status, entry.output]) : []).toEqual([
    ["a", "done", "file a"],
    ["b", "error", "1 fail"],
  ])
  const summary = items.at(-1)
  expect(summary?.kind === "summary" ? summary.phrase : []).toEqual(["Messaged ", { threadId: 7, label: "Docs pass" }, ", ", "worked for 1m 27s"])
})

test("the live generation streams into the same keys it commits under", () => {
  const before = [ask(1, "Go", NOW - 10_000), answer(2, NOW - 9_000, call("a", "read"))]
  const live: LiveTimeline = {
    busy: true,
    parts: [{ kind: "text", text: "Reading" }, { kind: "call", callId: "b", name: "bash", args: { command: "bun" } }],
    slots: new Map([["a", { name: "read", status: "running", output: "partial" }]]),
  }
  const streaming = buildTimeline(before, live, OPTIONS)
  expect(streaming.map((item) => [item.kind, item.key])).toEqual([
    ["date", "t1:day"],
    ["owner", "e1:0"],
    ["tools", "t1:0"],
    ["text", "t1:1"],
    ["tools", "t1:2"],
  ])
  const group = streaming[2]
  expect(group?.kind === "tools" ? [group.live, group.calls[0]?.status, group.calls[0]?.output] : []).toEqual([true, "running", "partial"])
  const tail = streaming[4]
  expect(tail?.kind === "tools" ? tail.calls[0]?.status : undefined).toBe("streaming")
  const committed = buildTimeline(
    [...before, output(3, NOW - 8_000, "a", "file"), answer(4, NOW - 7_000, { type: "text", text: "Reading" }, call("b", "bash", { command: "bun" }))],
    { busy: true, parts: [], slots: new Map() },
    OPTIONS,
  )
  expect(committed.map((item) => item.key)).toEqual(["t1:day", "e1:0", "t1:0", "t1:1", "t1:2"])
})

test("a tool with a block leaves its group and stands alone in place", () => {
  const items = buildTimeline(
    [ask(1, "Chart it", NOW), answer(2, NOW + 1_000, call("a", "read"), call("b", "visualize"), call("c", "read"))],
    IDLE,
    { ...OPTIONS, hasBlock: (name) => name === "visualize" },
  )
  expect(items.filter((item) => item.kind !== "date" && item.kind !== "owner").map((item) => item.kind)).toEqual(["tools", "block", "tools", "summary"])
})

test("the live doc is read into parts and slots", () => {
  const snapshot: Snapshot = {
    id: 1,
    entries: [],
    before: undefined,
    docs: {
      "pi.live": {
        run: { taskId: "t" },
        generation: { message: { content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }, call("x", "read", { path: "a" })] } },
        tools: [{ callId: "y", name: "bash", status: "pending" }],
      },
    },
  }
  const live = liveTimelineOf(snapshot)
  expect(live.busy).toBe(true)
  expect(live.parts).toEqual([{ kind: "text", text: "Hi there" }, { kind: "call", callId: "x", name: "read", args: { path: "a" } }])
  expect(live.slots.get("y")).toEqual({ name: "bash", status: "pending", output: undefined })
})

test("the agent waits on the person first, then a running tool, then working threads", () => {
  const threads = [{ threadId: 7, label: "Docs pass" }]
  const running: LiveTimeline = { busy: true, parts: [], slots: new Map([["a", { name: "bash", status: "running", output: undefined }]]) }
  expect(waitTarget({ live: running, asking: true, threads })).toEqual({ kind: "person" })
  expect(waitTarget({ live: running, asking: false, threads })).toEqual({ kind: "tool", name: "bash" })
  expect(waitTarget({ live: { ...running, parts: [{ kind: "text", text: "x" }] }, asking: false, threads })).toBeUndefined()
  expect(waitTarget({ live: IDLE, asking: false, threads })).toEqual({ kind: "threads", threads })
  expect(waitTarget({ live: IDLE, asking: false, threads: [] })).toBeUndefined()
})
