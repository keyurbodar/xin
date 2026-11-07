export type NotifyKind = "waiting" | "finished" | "failed" | "spend"

export type Notification = {
  readonly threadTitle: string
  readonly title: string
  readonly body?: string
  readonly tag: string
  readonly kind: NotifyKind
}

export type NotifyPrefs = Readonly<Record<NotifyKind, boolean>>

export const DEFAULT_PREFS: NotifyPrefs = { waiting: true, finished: true, failed: true, spend: true }

export type QuietHours = {
  readonly enabled: boolean
  readonly start: number
  readonly end: number
}

export const DEFAULT_QUIET: QuietHours = { enabled: false, start: 1320, end: 420 }

export interface PushService {
  notify(notification: Notification): Promise<void>
  prefs(): Promise<NotifyPrefs>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    push: PushService
  }
}
