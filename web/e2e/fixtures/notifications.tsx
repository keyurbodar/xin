import "../../src/styles/app.css"
import { render } from "solid-js/web"
import { NotificationsDialog } from "../../src/components/onboarding/notifications-dialog.tsx"
import { openNotifications } from "../../src/state/onboarding.ts"

render(
  () => (
    <main class="p-6">
      <button id="opener" type="button" onClick={() => openNotifications(true)}>
        Notifications
      </button>
      <NotificationsDialog />
    </main>
  ),
  document.getElementById("app")!,
)
document.body.dataset.ready = "1"
