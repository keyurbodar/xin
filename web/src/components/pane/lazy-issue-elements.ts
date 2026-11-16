import { once } from "../../lib/lazy-elements.ts"

export const loadIssueElements = once(() => import("./issue-elements.ts"))
