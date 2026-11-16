import type { JSX } from "solid-js"

export function inline(text: string): JSX.Element[] {
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
              class="text-ink underline decoration-line-3 underline-offset-[3px] hover:decoration-ink"
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
        parts.push(<strong class="font-medium text-ink">{text.slice(index + 2, close)}</strong>)
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
          <code class="rounded-sm border border-line-2 bg-secondary px-1 py-0.5 font-mono text-sm text-ink-2">
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
