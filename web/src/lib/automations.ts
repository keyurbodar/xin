export type AutomationTrigger =
  | { readonly id: string; readonly kind: "schedule"; readonly cron: string; readonly tz: string; readonly nextAt: string | null }
  | { readonly id: string; readonly kind: "once"; readonly at: string; readonly nextAt: string | null }
  | { readonly id: string; readonly kind: "webhook"; readonly path: string }

export type AutomationRun = {
  readonly id: string
  readonly status: "queued" | "running" | "delivered" | "completed" | "failed" | "cancelled"
  readonly threadId: number | null
  readonly createdAt: string
}

export type Automation = {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly project: string | null
  readonly target: "fresh" | "same"
  readonly enabled: boolean
  readonly updatedAt: string
  readonly nextAt: string | null
  readonly triggers: readonly AutomationTrigger[]
  readonly lastRun: AutomationRun | null
}

export type AutomationList = { readonly automations: readonly Automation[] }

function triggerLabel(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return `${trigger.cron} (${trigger.tz})`
    case "once": {
      const at = Date.parse(trigger.at)
      return Number.isNaN(at) ? trigger.at : new Date(at).toLocaleString()
    }
    case "webhook":
      return "webhook"
    default: {
      const _exhaustive: never = trigger
      return _exhaustive
    }
  }
}

export function describeTriggers(automation: Automation): string {
  return automation.triggers.length === 0 ? "manual only" : automation.triggers.map(triggerLabel).join(", ")
}

export function nextRun(value: string | null): string {
  if (value === null) return "not scheduled"
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
}
