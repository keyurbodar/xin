import type { ConversationId, Tx } from "@earendil-works/pi-durable"

export interface WatchdogService {
  ensure(tx: Tx, conversationId: ConversationId): Promise<void>
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    watchdog: WatchdogService
  }
}
