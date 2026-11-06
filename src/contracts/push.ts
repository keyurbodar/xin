export type Notification = {
  readonly threadTitle: string
  readonly title: string
  readonly body?: string
  readonly tag: string
}

export interface PushService {
  notify(notification: Notification): Promise<void>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    push: PushService
  }
}
