import { listOf, numOf, recordOf, strOf } from "./parse.ts"
import type { ThreadSummary } from "../state/home.ts"

export function threadsOf(value: unknown): readonly ThreadSummary[] {
  return listOf(value).flatMap((entry) => {
    const record = recordOf(entry)
    const id = numOf(record?.id)
    const title = strOf(record?.title)
    const status = strOf(record?.status)
    if (record === undefined || id === undefined || title === undefined || status === undefined) return []
    const role = strOf(record.role)
    const statusLine = strOf(record.statusLine)
    const result = strOf(record.result)
    const beatAt = numOf(record.beatAt)
    const deadlineAt = numOf(record.deadlineAt)
    return [
      {
        id,
        title,
        status,
        run: numOf(record.run) ?? 1,
        ...(role === undefined ? {} : { role }),
        ...(statusLine === undefined ? {} : { statusLine }),
        ...(result === undefined ? {} : { result }),
        ...(beatAt === undefined ? {} : { beatAt }),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      },
    ]
  })
}
