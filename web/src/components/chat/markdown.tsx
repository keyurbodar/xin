import { createSignal, For, onCleanup, type JSX } from "solid-js"
import { highlight } from "sugar-high"
import { lang } from "sugar-high/lang"
import { Glyph } from "../extensions/glyph.tsx"
import { Morph } from "../ui/morph.tsx"

function fenceLabel(fence: string): string {
  return lang(fence) ?? (fence === "" ? "code" : fence)
}

/** Sugar High escapes the code it marks up. The newline between line spans is dropped so the gutter stacks. */
function markedUp(code: string, fence: string): string {
  const canonical = lang(fence)
  const html = highlight(code, canonical === undefined ? { lang: "plaintext" } : { lang: canonical })
  return html.replaceAll('\n<span class="sh__line', '<span class="sh__line')
}

function CodeBlock(props: { code: string; fence: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  const [wrapped, setWrapped] = createSignal(false)
  let timer: number | undefined
  onCleanup(() => window.clearTimeout(timer))

  /** The label settles back on its own; a browser that refuses the clipboard leaves it alone. */
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.code)
      setCopied(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div class="code-block overflow-hidden rounded-[4px] border border-line-inner bg-surface">
      <div class="flex h-8 items-center gap-3 border-b border-line px-3 font-mono text-[11px] text-fg-3">
        <span>{fenceLabel(props.fence)}</span>
        <span class="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-pressed={wrapped()}
            onClick={() => setWrapped((on) => !on)}
            class="h-6 rounded-[2px] px-1.5 text-[11px] transition-none hover:text-fg"
          >
            {wrapped() ? "Wrapped" : "Wrap"}
          </button>
          <button
            type="button"
            aria-label="Copy code"
            onClick={() => void copy()}
            class="flex h-6 items-center gap-1.5 rounded-[2px] px-1.5 transition-none hover:text-fg"
            classList={{ "text-fg": copied() }}
          >
            <Glyph name={copied() ? "check" : "copy"} size={13} />
            <Morph value={copied() ? "Copied" : "Copy"} />
          </button>
        </span>
      </div>
      <pre classList={{ "is-wrapped": wrapped() }}>
        <code innerHTML={markedUp(props.code, props.fence)} />
      </pre>
    </div>
  )
}

function inline(text: string): JSX.Element[] {
  const parts: JSX.Element[] = []
  let buffer = ""
  let index = 0
  const flush = (): void => {
    if (buffer !== "") parts.push(<>{buffer}</>)
    buffer = ""
  }
  while (index < text.length) {
    const rest = text.slice(index)
    if (rest.startsWith("[")) {
      const labelEnd = text.indexOf("](", index + 1)
      const hrefEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2)
      if (labelEnd !== -1 && hrefEnd !== -1) {
        const href = text.slice(labelEnd + 2, hrefEnd)
        if (/^https?:\/\//u.test(href)) {
          flush()
          parts.push(
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              class="text-fg underline decoration-line-strong underline-offset-[3px] hover:decoration-fg"
            >
              {text.slice(index + 1, labelEnd)}
            </a>,
          )
          index = hrefEnd + 1
          continue
        }
      }
    }
    if (rest.startsWith("**")) {
      const close = text.indexOf("**", index + 2)
      if (close !== -1) {
        flush()
        parts.push(<strong class="font-medium text-fg">{text.slice(index + 2, close)}</strong>)
        index = close + 2
        continue
      }
    }
    if (rest.startsWith("*") && !rest.startsWith("**")) {
      const close = text.indexOf("*", index + 1)
      if (close !== -1 && close > index + 1) {
        flush()
        parts.push(<em class="not-italic">{text.slice(index + 1, close)}</em>)
        index = close + 1
        continue
      }
    }
    if (rest.startsWith("`")) {
      const close = text.indexOf("`", index + 1)
      if (close !== -1) {
        flush()
        const code = text.slice(index + 1, close)
        parts.push(
          <code class="rounded-[2px] border border-line-inner bg-hover px-1 py-0.5 font-mono text-[12.5px] text-fg-2">
            {code}
          </code>,
        )
        index = close + 1
        continue
      }
    }
    buffer += rest[0] ?? ""
    index += 1
  }
  flush()
  return parts
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function isTableDelimiter(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function TableBlock(props: { header: readonly string[]; rows: readonly (readonly string[])[] }): JSX.Element {
  return (
    <div class="overflow-x-auto">
      <table class="w-max min-w-full border-collapse text-[13px] leading-[1.5]">
        <thead>
          <tr>
            <For each={props.header}>
              {(cell) => (
                <th class="border-b border-line px-2 py-1.5 text-left text-[11px] font-normal tracking-wide whitespace-nowrap text-fg-3 uppercase">
                  {inline(cell)}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <For each={row}>
                  {(cell) => <td class="border-b border-line-inner px-2 py-1.5 align-top text-fg-2">{inline(cell)}</td>}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
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

export function Markdown(props: { text: string; small?: boolean; muted?: boolean }): JSX.Element {
  const blocks = (): JSX.Element[] => {
    const lines = props.text.replaceAll("\r\n", "\n").split("\n")
    const output: JSX.Element[] = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index] ?? ""
      if (line.trim() === "") {
        index += 1
        continue
      }
      const trimmed = line.trimStart()
      if (trimmed.startsWith("```")) {
        const fence = trimmed.slice(3).trim().split(/\s+/u)[0] ?? ""
        index += 1
        const code: string[] = []
        while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
          code.push(lines[index] ?? "")
          index += 1
        }
        index += 1
        output.push(<CodeBlock code={code.join("\n")} fence={fence} />)
        continue
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
      if (heading !== null) {
        output.push(
          <div class="mt-1 text-[15px] font-medium leading-[1.4] text-fg">{inline(heading[2] ?? "")}</div>,
        )
        index += 1
        continue
      }
      if ((line ?? "").includes("|") && isTableDelimiter(lines[index + 1] ?? "")) {
        const header = splitRow(line)
        index += 2
        const rows: string[][] = []
        while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
          const cells = splitRow(lines[index] ?? "")
          rows.push(Array.from({ length: header.length }, (_, column) => cells[column] ?? ""))
          index += 1
        }
        output.push(<TableBlock header={header} rows={rows} />)
        continue
      }
      if (/^[-*]\s+/.test(trimmed)) {
        const items: string[] = []
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
          items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/, ""))
          index += 1
        }
        output.push(
          <ul class="list-disc pl-5 [&>li+li]:mt-1">
            <For each={items}>{(item) => <li>{inline(item)}</li>}</For>
          </ul>,
        )
        continue
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        const items: string[] = []
        while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
          items.push((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""))
          index += 1
        }
        output.push(
          <ol class="list-decimal pl-5 [&>li+li]:mt-1">
            <For each={items}>{(item) => <li>{inline(item)}</li>}</For>
          </ol>,
        )
        continue
      }
      if (trimmed.startsWith(">")) {
        const quoted: string[] = []
        while (index < lines.length && (lines[index] ?? "").trimStart().startsWith(">")) {
          quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""))
          index += 1
        }
        output.push(
          <blockquote class="border-l border-line-strong pl-3 text-fg-2">{inline(quoted.join("\n"))}</blockquote>,
        )
        continue
      }
      const paragraph: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ""
        if (current.trim() === "" || (paragraph.length > 0 && isBlockStart(current))) break
        paragraph.push(current)
        index += 1
      }
      output.push(<p class="whitespace-pre-wrap">{inline(paragraph.join("\n"))}</p>)
    }
    return output
  }

  return (
    <div
      class="flex flex-col gap-2.5 leading-[1.6] [overflow-wrap:anywhere]"
      classList={{
        "text-[14px]": props.small !== true,
        "text-[13px]": props.small === true,
        "text-fg": props.muted !== true,
        "text-fg-2": props.muted === true,
      }}
    >
      {blocks()}
    </div>
  )
}
