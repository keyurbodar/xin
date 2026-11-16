import { createSignal, onCleanup, type JSX } from "solid-js"
import { Glyph } from "./glyph.tsx"

/** An SRI split for display: its algorithm, and the hash cut to its first and last 8 characters. */
export function shortPin(integrity: string): { readonly algorithm: string; readonly hash: string } {
  const dash = integrity.indexOf("-")
  const algorithm = integrity.slice(0, dash)
  const hash = integrity.slice(dash + 1)
  return { algorithm, hash: hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-8)}` }
}

/** A registry pin, shortened, with the full SRI in its title and one button that copies it. */
export function IntegrityPin(props: { integrity: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const short = () => shortPin(props.integrity)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.integrity)
      setCopied(true)
      clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <span class="inline-flex min-w-0 items-center gap-1.5">
      <span class="text-ink-3">{short().algorithm}</span>
      <code class="truncate font-mono text-ink" title={props.integrity}>
        {short().hash}
      </code>
      <button
        type="button"
        aria-label={copied() ? "Copied" : "Copy integrity"}
        title={copied() ? "Copied" : props.integrity}
        onClick={() => void copy()}
        class="im-press inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:text-ink"
      >
        <Glyph name={copied() ? "check" : "copy"} size={12} />
      </button>
    </span>
  )
}
