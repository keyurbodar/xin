import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = "docs/log/decisions"
const HEADER = ["time", "milestone", "decision", "why", "evidence", "result"]
const NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.tsv$/

type Row = { readonly file: string; readonly fields: readonly string[] }

function read(): { readonly rows: readonly Row[]; readonly problems: readonly string[] } {
  const rows: Row[] = []
  const problems: string[] = []
  for (const file of readdirSync(DIR).toSorted()) {
    const name = NAME.exec(file)
    if (name === null) {
      problems.push(`${file}: name must be <yyyy-mm-dd>-<slug>.tsv with a lowercase slug`)
      continue
    }
    const text = readFileSync(join(DIR, file), "utf8")
    if (!text.endsWith("\n") || /[\r\n]/.test(text.slice(0, -1))) {
      problems.push(`${file}: must hold exactly one row ending in a newline`)
      continue
    }
    const fields = text.slice(0, -1).split("\t")
    if (fields.length !== HEADER.length) {
      problems.push(`${file}: has ${fields.length} tab-separated fields, needs ${HEADER.length} (${HEADER.join(", ")})`)
      continue
    }
    if (fields.some((field) => field.trim() === "")) problems.push(`${file}: has an empty field`)
    if (!new RegExp(`^${name[1] ?? ""}T\\d\\d:\\d\\d`).test(fields[0] ?? ""))
      problems.push(`${file}: time ${fields[0]} is not on ${name[1]}`)
    rows.push({ file, fields })
  }
  return { rows, problems }
}

const { rows, problems } = read()
if (process.argv.includes("--check")) {
  for (const problem of problems) console.error(`decisions: ${problem}`)
  if (problems.length > 0) process.exit(1)
} else {
  const sorted = rows.toSorted(
    (left, right) => (left.fields[0] ?? "").localeCompare(right.fields[0] ?? "") || left.file.localeCompare(right.file),
  )
  process.stdout.write(
    [HEADER, ...sorted.map((row) => row.fields)].map((fields) => fields.join("\t")).join("\n") + "\n",
  )
}
