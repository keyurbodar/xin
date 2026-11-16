import "../../src/styles/app.css"
import { Menu } from "@ark-ui/solid/menu"
import { createSignal, Show } from "solid-js"
import { Portal, render } from "solid-js/web"
import { Dialog } from "../../src/components/ui/dialog.tsx"
import { MENU_CONTENT, MENU_ITEM } from "../../src/components/shell/menu.ts"

function App() {
  const [open, setOpen] = createSignal(false)
  const [rows, setRows] = createSignal(true)
  return (
    <main class="p-6">
      <Show when={rows()}>
        <Menu.Root lazyMount unmountOnExit>
          <Menu.Trigger id="more" aria-label="More">
            ⋯
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content class={MENU_CONTENT}>
                <Menu.Item value="edit" class={MENU_ITEM} onSelect={() => setOpen(true)}>
                  Edit…
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      </Show>
      <Dialog open={open()} onClose={() => setOpen(false)} title="Edit automation">
        <input id="name" />
      </Dialog>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
