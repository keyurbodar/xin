import type { JSX } from "solid-js"
import { STATUS_LABEL, STATUS_SIGNAL, type IntegrationStatus } from "../../lib/integrations.ts"
import { Signal } from "./signal.tsx"

export function StatusPill(props: { status: IntegrationStatus }): JSX.Element {
  return (
    <span
      class="inline-flex h-[var(--h-badge)] shrink-0 items-center gap-1.5 rounded-full border border-line-2 bg-card pl-1.5 pr-2 text-micro text-ink-2"
      data-status={props.status}
    >
      <span aria-hidden="true" class="flex">
        <Signal state={STATUS_SIGNAL[props.status]} size={12} />
      </span>
      {STATUS_LABEL[props.status]}
    </span>
  )
}

export function IntegrationRow(props: {
  mark: JSX.Element
  name: string
  detail: string
  status: IntegrationStatus
  actions?: JSX.Element
}): JSX.Element {
  return (
    <div class="flex min-w-0 items-center gap-3">
      {props.mark}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium text-ink">{props.name}</span>
        <span class="block truncate text-xs text-ink-3" title={props.detail}>
          {props.detail}
        </span>
      </span>
      <StatusPill status={props.status} />
      {props.actions}
    </div>
  )
}
