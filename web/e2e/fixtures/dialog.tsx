import "../../src/styles/app.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Dialog, FIELD_INPUT, Field } from "../../src/components/ui/dialog.tsx"

function App() {
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [submits, setSubmits] = createSignal(0)
  const [returnFocus, setReturnFocus] = createSignal<HTMLElement>()
  Object.assign(window, {
    setBusy,
    closeTo: (id: string) => {
      setReturnFocus(document.getElementById(id) ?? undefined)
      setOpen(false)
    },
  })
  return (
    <main class="p-6">
      <button id="opener" type="button" onClick={() => setOpen(true)}>
        New project
      </button>
      <button id="after" type="button">
        After
      </button>
      <output id="submits">{submits()}</output>
      <Dialog
        open={open()}
        onClose={() => setOpen(false)}
        title="New project"
        busy={busy()}
        returnFocus={returnFocus()}
        onSubmit={() => setSubmits(submits() + 1)}
        footer={<button type="submit">Create</button>}
      >
        <Field label="Name">
          <input id="name" class={`${FIELD_INPUT} h-9`} />
        </Field>
        <Field label="Notes">
          <textarea id="notes" class={FIELD_INPUT} />
        </Field>
      </Dialog>
    </main>
  )
}

render(() => <App />, document.getElementById("app")!)
document.body.dataset.ready = "1"
