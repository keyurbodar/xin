export type SignalState = "idle" | "queued" | "working" | "needs" | "done" | "failed"

export const STATE_WORD: Readonly<Record<SignalState, string>> = {
  idle: "Stopped",
  queued: "Queued",
  working: "Working",
  needs: "Needs you",
  done: "Done",
  failed: "Failed",
}

/** Thread status words from the backend, mapped onto Signal's states. */
export function visualState(status: string): SignalState {
  switch (status) {
    case "working":
      return "working"
    case "waiting":
      return "needs"
    case "completed":
      return "done"
    case "failed":
      return "failed"
    case "cancelled":
      return "idle"
    default:
      return "queued"
  }
}
