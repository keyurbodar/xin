export type Align = "left" | "center" | "right"

export type MarkdownBlock =
  | { kind: "fence"; lang: string; source: string; streaming: boolean }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][]; streaming: boolean }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string }

export function splitRow(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let cell = ""
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? ""
    if (char === "\\" && trimmed[index + 1] === "|") {
      cell += "|"
      index += 1
      continue
    }
    if (char === "|") {
      cells.push(cell)
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell)
  if (trimmed.startsWith("|")) cells.shift()
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|") && cells.length > 0) cells.pop()
  return cells.map((value) => value.trim())
}

function delimiterAlign(line: string, columns: number): Align[] | undefined {
  if (!line.includes("-")) return undefined
  const cells = splitRow(line)
  if (cells.length !== columns || !cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center"
    return cell.endsWith(":") ? "right" : "left"
  })
}

function isPartialDelimiter(line: string): boolean {
  return line.includes("-") && /^[\s|:-]+$/.test(line)
}

function fenceOpen(line: string): { marks: number; lang: string } | undefined {
  const match = /^(`{3,})\s*([^`\s]*)/.exec(line.trimStart())
  if (match === null) return undefined
  return { marks: match[1]?.length ?? 3, lang: match[2] ?? "" }
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith("```") ||
    /^#{1,3}\s+/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    trimmed.startsWith(">")
  )
}

export function parseBlocks(text: string, streaming = false): MarkdownBlock[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const output: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim() === "") {
      index += 1
      continue
    }
    const trimmed = line.trimStart()
    const fence = fenceOpen(line)
    if (fence !== undefined) {
      index += 1
      const code: string[] = []
      const closes = new RegExp(`^\`{${fence.marks},}\\s*$`)
      while (index < lines.length && !closes.test((lines[index] ?? "").trim())) {
        code.push(lines[index] ?? "")
        index += 1
      }
      const closed = index < lines.length
      index += 1
      output.push({ kind: "fence", lang: fence.lang, source: code.join("\n"), streaming: streaming && !closed })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      output.push({ kind: "heading", text: heading[2] ?? "" })
      index += 1
      continue
    }
    if (line.includes("|")) {
      const header = splitRow(line)
      const next = lines[index + 1] ?? ""
      const align = delimiterAlign(next, header.length)
      const pending = align === undefined && streaming && index + 2 === lines.length && isPartialDelimiter(next)
      if (align !== undefined || pending) {
        index += 2
        const rows: string[][] = []
        while (index < lines.length && (lines[index] ?? "").includes("|") && !isBlockStart(lines[index] ?? "")) {
          const cells = splitRow(lines[index] ?? "")
          rows.push(Array.from({ length: header.length }, (_, column) => cells[column] ?? ""))
          index += 1
        }
        output.push({
          kind: "table",
          header,
          align: align ?? header.map(() => "left"),
          rows,
          streaming: streaming && index >= lines.length,
        })
        continue
      }
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/, ""))
        index += 1
      }
      output.push({ kind: "list", ordered: false, items })
      continue
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""))
        index += 1
      }
      output.push({ kind: "list", ordered: true, items })
      continue
    }
    if (trimmed.startsWith(">")) {
      const quoted: string[] = []
      while (index < lines.length && (lines[index] ?? "").trimStart().startsWith(">")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""))
        index += 1
      }
      output.push({ kind: "quote", text: quoted.join("\n") })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ""
      if (current.trim() === "" || (paragraph.length > 0 && isBlockStart(current))) break
      paragraph.push(current)
      index += 1
    }
    output.push({ kind: "paragraph", text: paragraph.join("\n") })
  }
  return output
}
