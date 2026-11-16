import type { Align } from "./markdown-parse.ts"

export function plainCell(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
}

export function tableMarkdown(header: readonly string[], align: readonly Align[], rows: readonly (readonly string[])[]): string {
  const row = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`
  const rule = header.map((_, column) => {
    const side = align[column] ?? "left"
    if (side === "center") return ":---:"
    return side === "right" ? "---:" : "---"
  })
  return [row(header), `| ${rule.join(" | ")} |`, ...rows.map(row)].join("\n")
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function tableCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((cells) => cells.map((cell) => csvField(plainCell(cell))).join(",")).join("\r\n")
}
