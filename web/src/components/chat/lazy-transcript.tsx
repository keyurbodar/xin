import { lazyView } from "../ui/lazy-view.tsx"
import { ThreadSkeleton } from "../ui/skeleton.tsx"
import type { Transcript as View } from "./transcript.tsx"

export const Transcript = lazyView<Parameters<typeof View>[0]>(
  () => import("./transcript.tsx").then((module) => module.Transcript),
  ThreadSkeleton,
)
