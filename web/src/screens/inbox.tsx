import { For, onMount, Show, type JSX } from "solid-js"
import { EmptyInbox, LoadingInbox } from "../components/inbox/empty.tsx"
import { QuestionRow, ThreadRow } from "../components/inbox/rows.tsx"
import { TopBar, TopButton } from "../components/shell/topbar.tsx"
import { Icon } from "../components/ui/icon.tsx"
import { inboxFailure, inboxGroups, inboxSource, loadRequests, refreshRequests } from "../state/requests.ts"

export function InboxScreen(): JSX.Element {
  onMount(loadRequests)

  const groups = () => inboxGroups()
  const total = () => groups().reduce((count, group) => count + group.items.length, 0)
  const grouped = () => groups().length > 1
  const hasQuestions = () => groups().some((group) => group.items.some((item) => item.kind === "question"))

  const subtitle = (): string => {
    const state = inboxSource()
    switch (state) {
      case "loading":
        return "Loading"
      case "error":
        return "Could not load"
      case "threads":
      case "requests":
        return total() === 0 ? "Nothing waits on you" : `${total()} ${total() === 1 ? "needs" : "need"} you`
      default: {
        const _exhaustive: never = state
        return _exhaustive
      }
    }
  }

  return (
    <>
      <TopBar
        title="Inbox"
        subtitle={subtitle()}
        actions={
          <TopButton
            icon={<Icon name="refresh" size={14} />}
            label="Refresh"
            onClick={() => void refreshRequests()}
          />
        }
      />
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-10 pb-12 pt-7">
          <Show when={inboxSource() === "loading"}>
            <LoadingInbox />
          </Show>

          <Show when={inboxSource() === "error"}>
            <div class="flex items-center gap-3 rounded-[4px] border border-bad/40 bg-bad-bg px-3.5 py-3 text-[12.5px] text-fg-2">
              <span class="min-w-0 flex-1">{inboxFailure() ?? "The inbox could not load."}</span>
              <button type="button" class="chip shrink-0" onClick={() => void refreshRequests()}>
                Try again
              </button>
            </div>
          </Show>

          <Show when={inboxSource() !== "loading" && inboxSource() !== "error" && groups().length === 0}>
            <EmptyInbox />
          </Show>

          <Show when={hasQuestions()}>
            <p class="text-[12px] text-fg-3">
              Answering resumes the thread right away. The coordinator sees your answer too.
            </p>
          </Show>

          <For each={groups()}>
            {(group) => (
              <section class="flex flex-col gap-2">
                <Show when={grouped()}>
                  <div class="flex items-baseline gap-2.5">
                    <span class="label">{group.name}</span>
                    <span class="text-[11.5px] text-fg-3">{group.items.length}</span>
                  </div>
                </Show>
                <div class="flex flex-col overflow-hidden rounded-[4px] border border-line bg-surface">
                  <For each={group.items}>
                    {(item) =>
                      item.kind === "question" ? (
                        <QuestionRow
                          question={item.question}
                          projectName={item.projectName}
                          threadTitle={item.threadTitle}
                          projectSlug={item.projectSlug}
                        />
                      ) : (
                        <ThreadRow thread={item.thread} project={item.project} state={item.state} />
                      )
                    }
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </div>
    </>
  )
}
