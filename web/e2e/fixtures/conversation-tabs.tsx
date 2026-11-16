import "../../src/styles/app.css"
import { Settings } from "lucide-solid"
import { render } from "solid-js/web"
import { route } from "../../src/lib/router.ts"
import { trackMotion } from "../../src/lib/motion.ts"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"
import { openThreadTab, openThreadTabs } from "../../src/state/tabs.ts"
import { ConversationTabs } from "../../src/components/shell/conversation-tabs.tsx"

const threads: readonly ThreadSummary[] = [
  { id: 12, title: "Sidebar v2 on UI SDK", status: "working", run: 1 },
  { id: 14, title: "Review the breadcrumb header", status: "waiting", run: 1 },
  { id: 9, title: "Hover cards and link chips", status: "completed", run: 1 },
]
const project: ProjectSummary = {
  id: "p1",
  slug: "ingle",
  name: new URLSearchParams(location.search).get("project") ?? "Ingle",
  archived: false,
  coordinatorId: 1,
  threads: { working: [], waiting: [], completed: [], failed: [], cancelled: [] },
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
}

for (const thread of threads) openThreadTab("p1", thread.id)
const tabThreads = (): readonly ThreadSummary[] =>
  openThreadTabs("p1").flatMap((id) => threads.filter((thread) => thread.id === id))

const actions: string[] = []
Object.assign(window, { actions })
const active = (): number | undefined => {
  const parts = route().parts
  return parts[2] === "t" ? Number(parts[3]) : undefined
}

trackMotion()
render(
  () => (
    <div class="bg-panel">
      <ConversationTabs
        project={project}
        base="/p/ingle"
        mark={<span class="h-3.5 w-3.5 shrink-0 rounded-full bg-primary" />}
        threads={tabThreads()}
        activeThreadId={active()}
        cost={0.42}
        actions={[{ value: "settings", label: "Project settings", icon: Settings }]}
        onAction={(value) => actions.push(value)}
      />
    </div>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
