import { defineDoc } from "@earendil-works/pi-durable"
import { compile, int, map, obj, str, type Static } from "@earendil-works/pi-schema"

export const ARTIFACT_MARKDOWN_MAX = 200_000
export const ARTIFACT_TOTAL_MAX = 1_000_000
export const ARTIFACT_LIMIT = 10

/** One document a thread's agent writes and reads. Each save bumps `revision`. */
export const ArtifactSchema = obj({
  title: str({ minLength: 1, maxLength: 200 }),
  markdown: str({ maxLength: ARTIFACT_MARKDOWN_MAX }),
  revision: int({ minimum: 1 }),
  createdAt: int({ minimum: 0 }),
  updatedAt: int({ minimum: 0 }),
})

export const ArtifactsSchema = obj({ items: map(ArtifactSchema) })

export type ArtifactState = Static<typeof ArtifactSchema>
export type ArtifactsState = Static<typeof ArtifactsSchema>

export const parseArtifacts = compile(ArtifactsSchema)

export const ArtifactsDoc = defineDoc<ArtifactsState>({
  kind: "xin.artifacts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: () => false,
})
