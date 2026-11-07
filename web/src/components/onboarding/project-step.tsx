import { createSignal, For, Show, type JSX } from "solid-js"
import { Icon, type IconName } from "../ui/icon.tsx"
import { projectIcon } from "../../lib/project-icon.ts"
import { slugify } from "../../lib/slug.ts"
import { Field, GhostButton, PrimaryButton, StatusLine, StepHeading, TextArea, TextInput } from "./controls.tsx"
import {
  createFirstProject,
  messageOf,
  nextStep,
  onboardingProject,
  previousStep,
} from "../../state/onboarding.ts"

type Template = { readonly icon: IconName; readonly name: string; readonly goal: string }

const TEMPLATES: readonly Template[] = [
  {
    icon: "users",
    name: "Hiring plan",
    goal: "Hire two account execs and a support lead before March. Post a pipeline update every Monday.",
  },
  {
    icon: "sliders",
    name: "Sales pipeline",
    goal: "Track the deals that slip, nudge the owners, and post a forecast every Friday.",
  },
  {
    icon: "file",
    name: "Month-end close",
    goal: "Collect invoices, match payments, and flag what is still outstanding before the close.",
  },
  {
    icon: "link",
    name: "Plan a trip",
    goal: "Pick flights and stays, then turn them into a day-by-day plan.",
  },
]

export function ProjectStep(): JSX.Element {
  const existing = onboardingProject()
  const [name, setName] = createSignal(existing?.name ?? "")
  const [goal, setGoal] = createSignal(existing?.goal ?? "")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)

  const project = onboardingProject
  const slug = (): string => slugify(name())
  const previewName = (): string => (name().trim() === "" ? "Untitled project" : name().trim())
  const previewGoal = (): string => (goal().trim() === "" ? "Goal shows here." : goal().trim())

  const applyTemplate = (template: Template): void => {
    setName(template.name)
    setGoal(template.goal)
    setFailure(undefined)
  }

  const submit = async (): Promise<void> => {
    if (busy()) return
    if (project() !== undefined) {
      nextStep()
      return
    }
    if (name().trim() === "") {
      setFailure("Give the project a name.")
      return
    }
    if (slug() === "") {
      setFailure("Use at least one letter or number in the name.")
      return
    }
    setBusy(true)
    setFailure(undefined)
    try {
      await createFirstProject(name(), goal())
    } catch (error) {
      setFailure(messageOf(error, "The project could not be created."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="enter px-6 pb-16 pt-12 md:pt-16">
      <div class="mx-auto grid w-full max-w-[1024px] grid-cols-1 justify-center gap-12 lg:grid-cols-[560px_400px] lg:gap-16">
        <div class="flex flex-col gap-4">
          <StepHeading
            step="Step 2 of 4"
            title="What are you working on?"
            intro="A project is one goal with its own chat, files, memory and schedules. Start from an example or write your own."
          />

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <For each={TEMPLATES}>
              {(template) => (
                <button
                  type="button"
                  onClick={() => applyTemplate(template)}
                  class="flex items-start gap-2.5 rounded-[2px] border px-3 py-2.5 text-left transition-none"
                  classList={{
                    "border-line-strong bg-hover": name() === template.name && goal() === template.goal,
                    "border-line-inner bg-surface hover:border-line-strong hover:bg-hover":
                      name() !== template.name || goal() !== template.goal,
                  }}
                >
                  <Icon name={template.icon} size={14} class="mt-0.5 shrink-0 text-fg-3" />
                  <span class="min-w-0">
                    <span class="block text-[12.5px] font-medium">{template.name}</span>
                    <span class="block truncate text-[11.5px] text-fg-3">{template.goal}</span>
                  </span>
                </button>
              )}
            </For>
          </div>

          <Field
            label="Name"
            hint={slug() === "" ? "Letters and numbers in the name become the link." : `The project opens at /p/${slug()}.`}
          >
            <TextInput
              value={name()}
              onInput={(value) => {
                setName(value)
                setFailure(undefined)
              }}
              placeholder="Q1 hiring plan"
              ariaLabel="Project name"
              onEnter={() => void submit()}
            />
          </Field>

          <Field label="Goal" hint="The coordinator reads this before every reply. You can change it any time.">
            <TextArea
              value={goal()}
              onInput={(value) => {
                setGoal(value)
                setFailure(undefined)
              }}
              placeholder="What should this project achieve?"
              ariaLabel="Project goal"
              rows={3}
            />
          </Field>

          <StatusLine tone={failure() === undefined ? "muted" : "error"} text={failure()} />

          <Show when={project() !== undefined}>
            <div class="flex items-center gap-2.5 rounded-[2px] border border-line-inner bg-raised px-3 py-2.5">
              <Icon name="check" size={14} class="shrink-0 text-ok" />
              <span class="min-w-0 truncate text-[12.5px] text-fg-2">
                Created <span class="text-fg">{project()?.name}</span>
              </span>
              <span class="ml-auto shrink-0 font-mono text-[10.5px] text-fg-4">/p/{project()?.slug}</span>
            </div>
          </Show>

          <div class="flex items-center justify-between gap-3">
            <GhostButton label="Back" onClick={previousStep} />
            <PrimaryButton
              label={project() === undefined ? "Create project" : "Continue"}
              busy={busy()}
              disabled={project() === undefined && slug() === ""}
              onClick={() => void submit()}
            />
          </div>
        </div>

        <div class="min-w-0">
          <span class="label">Preview in the sidebar</span>
          <div class="mt-3 overflow-hidden rounded-[4px] border border-line bg-surface">
            <div class="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
              <span class="grid h-6 w-6 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2">
                <Icon name={projectIcon(slugify(previewName()))} size={14} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13px] font-medium">{previewName()}</div>
                <div class="text-[11.5px] text-fg-3">New · no threads yet</div>
              </div>
            </div>
            <div class="px-3.5 py-3.5 text-[12.5px] leading-[1.6] text-fg-3">{previewGoal()}</div>
          </div>
          <p class="mt-3.5 text-[12px] leading-[1.6] text-fg-3">
            The sidebar picks a glyph from the name. Preset defaults to Full; change it in the project’s settings.
          </p>
        </div>
      </div>
    </div>
  )
}
