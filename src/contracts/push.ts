export type Notification = {
  readonly threadTitle: string
  readonly title: string
  readonly body?: string
  readonly tag: string
}

export type NotifyKind = "waiting" | "finished" | "failed"

export type NotifyPrefs = Readonly<Record<NotifyKind, boolean>>

export const DEFAULT_PREFS: NotifyPrefs = { waiting: true, finished: true, failed: true }

export interface PushService {
  notify(notification: Notification): Promise<void>
  prefs(): Promise<NotifyPrefs>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    push: PushService
  }
}
