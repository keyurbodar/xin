import type { ConversationId } from "@earendil-works/pi-durable"

type Brand<T, B extends string> = T & { readonly __brand: B }

export type CommandId = Brand<string, "CommandId">
export type PluginId = Brand<string, "PluginId">
export type ProjectId = Brand<string, "ProjectId">
export type SpaceId = Brand<string, "SpaceId">
export type BatchId = Brand<string, "BatchId">
export type ThreadId = ConversationId
export type { ConversationId }
