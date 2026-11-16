import "../../src/styles/app.css"
import { FileText, LayoutGrid, MessagesSquare } from "lucide-solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ViewMenu } from "../../src/components/pane/pane.tsx"
import type { PaneEntry } from "../../src/components/pane/views.tsx"
import type { ProjectSummary, ThreadSummary } from "../../src/state/home.ts"

const thread = (id: number, title: string, status: string): ThreadSummary => ({ id, title, status, run: 1 })
const project: ProjectSummary = {
  id: "p1",
  slug: "ingle",
  name: "Ingle",
  archived: false,
  coordinatorId: 1,
  openRequests: 0,
  requestsRev: 0,
  spaces: [],
  threads: {
    working: [thread(11, "Port the dialog shell", "working")],
    waiting: [thread(12, "Review the spec", "waiting")],
    completed: [],
    failed: [],
    cancelled: [],
  },
}
const entry = (id: string, label: string, icon: PaneEntry["icon"]): PaneEntry => ({ id, label, icon, render: () => null })
const views = [entry("overview", "Overview", LayoutGrid), entry("files", "Files", FileText), entry("threads", "All threads", MessagesSquare)]

function App() {
  const [picked, setPicked] = createSignal("")
  return (
    <main class="flex items-start gap-4 p-6">
      <ViewMenu views={views} project={project} current="overview" onOpenThread={(id) => setPicked(`thread:${id}`)} />
      <output id="picked">{picked()}</output>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
