import type { MutableModels } from "@earendil-works/pi-ai"

export type Provider = Parameters<MutableModels["setProvider"]>[0]

export type Route = (request: Request) => Promise<Response>
