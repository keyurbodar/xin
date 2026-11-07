import { For, type JSX } from "solid-js"


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
        parts.push(<em class="italic">{text.slice(index + 1, close)}</em>)
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
          <code class="rounded-[2px] border border-line bg-surface px-1 py-0.5 font-mono text-[12px] text-fg-2">
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
        index += 1
        const code: string[] = []
        while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
          code.push(lines[index] ?? "")
          index += 1
        }
        index += 1
        output.push(
          <pre class="overflow-x-auto rounded-[2px] border border-line bg-surface px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-fg-2">
            <code>{code.join("\n")}</code>
          </pre>,
        )
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
