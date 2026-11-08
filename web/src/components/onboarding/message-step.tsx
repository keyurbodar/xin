import { For, Show, type JSX } from "solid-js"
import { Icon, type IconName } from "../ui/icon.tsx"
import { ProjectMark } from "../chat/project-glyph.tsx"
import { navigate } from "../../lib/router.ts"
import { GhostButton, PrimaryButton } from "./controls.tsx"
import { nextStep, onboardingProject, previousStep, projectPath } from "../../state/onboarding.ts"

type Suggestion = { readonly icon: IconName; readonly title: string; readonly detail: string }

const SUGGESTIONS: readonly Suggestion[] = [
  { icon: "file", title: "Draft the first plan", detail: "Uses your goal and any files you add" },
  { icon: "search", title: "Research what I need", detail: "Starts a few threads in parallel" },
  { icon: "calendar", title: "Post an update every Monday", detail: "Sets up a schedule" },
  { icon: "link", title: "Connect a tool", detail: "Servers, APIs and extensions" },
]

export function MessageStep(): JSX.Element {
  const project = onboardingProject

  return (
    <div class="enter px-6 pb-16 pt-10 md:pt-12">
      <div class="mx-auto flex w-full max-w-[760px] flex-col gap-6">
        <div class="flex flex-col gap-2.5">
          <span class="label">Step 3 of 4</span>
          <h1 class="text-[28px] font-light leading-[1.15] tracking-[-0.03em] md:text-[32px]">
            <Show when={project() !== undefined} fallback="Your project is ready">
              Say hello to {project()?.name}
            </Show>
          </h1>
          <p class="max-w-[560px] text-[13.5px] leading-[1.6] text-fg-3">
            The coordinator answers here and splits the work into threads when the job is bigger. Open the project to
            send your first message.
          </p>
        </div>

        <Show when={project() !== undefined} fallback={<MissingProject />}>
          <div class="overflow-hidden rounded-[4px] border border-line bg-surface">
            <div class="flex items-center gap-2.5 border-b border-line px-4 py-3">
              <span class="grid h-6 w-6 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2">
                <ProjectMark slug={project()?.slug ?? ""} name={project()?.name ?? ""} size={15} />
              </span>
              <span class="min-w-0 truncate text-[14px] font-medium">{project()?.name}</span>
              <Show when={project()?.goal !== undefined}>
                <span class="min-w-0 truncate text-[12.5px] text-fg-3">· {project()?.goal}</span>
              </Show>
            </div>

            <div class="flex flex-col gap-5 px-5 py-5">
              <div class="flex items-start gap-3">
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-[2px] border border-line-inner bg-raised text-fg-2">
                  <ProjectMark slug={project()?.slug ?? ""} name={project()?.name ?? ""} size={15} />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-3">
                  <span class="font-mono text-[10.5px] text-fg-4">Coordinator · just now</span>
                  <p class="max-w-[560px] text-[13.5px] leading-[1.6] text-fg-2">
                    I’ve read the goal. Here are a few ways to start. You can also just tell me what you need.
                  </p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <For each={SUGGESTIONS}>
                      {(suggestion) => (
                        <div class="flex items-start gap-2.5 rounded-[2px] border border-line-inner bg-raised px-3 py-2.5">
                          <Icon name={suggestion.icon} size={14} class="mt-0.5 shrink-0 text-fg-3" />
                          <span class="min-w-0">
                            <span class="block text-[12.5px] text-fg">{suggestion.title}</span>
                            <span class="block text-[11.5px] leading-[1.4] text-fg-3">{suggestion.detail}</span>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>

            <div class="px-4 pb-4">
              <div class="rounded-[4px] border border-line-strong bg-raised shadow-[0_0_0_1px_var(--color-page),0_0_0_3px_rgba(255,90,0,0.35)]">
                <div class="px-3.5 pb-1 pt-3 text-[13.5px] text-fg-4">
                  Message {project()?.name}…
                  <span class="ml-0.5 inline-block h-[15px] w-px animate-pulse bg-fg align-[-3px]" />
                </div>
                <div class="flex items-center gap-1.5 px-2 pb-2 pt-1.5 text-[12px] text-fg-2">
                  <span class="grid h-8 w-8 place-items-center rounded-[2px] text-fg-3">
                    <Icon name="paperclip" size={15} />
                  </span>
                  <span class="mx-1 h-3.5 w-px bg-line-inner" />
                  <span class="flex items-center gap-1.5 text-fg-3">
                    <Icon name="layers" size={14} />
                    <span class="text-fg-2">Full</span>
                  </span>
                  <span class="mx-1 h-3.5 w-px bg-line-inner" />
                  <span class="text-fg-3">Catalog default</span>
                  <span class="ml-1 flex items-end gap-0.5" aria-hidden="true">
                    <span class="h-1.5 w-[3px] rounded-[1px] bg-fg-2" />
                    <span class="h-2.5 w-[3px] rounded-[1px] bg-fg-2" />
                    <span class="h-3 w-[3px] rounded-[1px] bg-line-strong" />
                  </span>
                  <span class="text-fg-3">Medium</span>
                  <span class="ml-auto grid h-8 w-8 place-items-center rounded-[2px] bg-accent text-ink">
                    <Icon name="arrow-up" size={15} />
                  </span>
                </div>
              </div>
              <p class="mt-2 text-center text-[11.5px] text-fg-4">The composer sends from the project view.</p>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3">
            <GhostButton label="Back" onClick={previousStep} />
            <div class="flex items-center gap-2">
              <GhostButton label="Next" onClick={nextStep} />
              <PrimaryButton label="Open the project" onClick={() => navigate(projectPath(project()))} />
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

function MissingProject(): JSX.Element {
  return (
    <div class="flex flex-col gap-4 rounded-[4px] border border-line bg-surface px-4 py-4">
      <p class="text-[13px] leading-[1.6] text-fg-3">
        Create a project first, then the coordinator’s welcome and the composer appear here.
      </p>
      <div>
        <GhostButton label="Back to the project step" onClick={previousStep} />
      </div>
    </div>
  )
}
