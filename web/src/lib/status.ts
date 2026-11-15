export type VisualState = "queued" | "working" | "waiting" | "done" | "failed" | "paused" | "cancelled"

export const STATE_WORD: Readonly<Record<VisualState, string>> = {
  queued: "Queued",
  working: "Working",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
}

/** Thread status words from the backend, mapped onto the seven visual states. */
export function visualState(status: string): VisualState {
  switch (status) {
    case "working":
      return "working"
    case "waiting":
      return "waiting"
    case "completed":
      return "done"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "paused":
      return "paused"
    default:
      return "queued"
  }
}
