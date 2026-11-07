import { createSignal, Show, type JSX } from "solid-js"
import { setToken, token } from "../../lib/auth.ts"
import { Button, Chip, MissingOp, Note, Panel } from "../extensions/chrome.tsx"
import { Glyph } from "../extensions/glyph.tsx"
import { Group, Row } from "./parts.tsx"

export function Profile(): JSX.Element {
  const [replacing, setReplacing] = createSignal(false)
  const signedIn = (): boolean => token() !== ""

  const replace = (): void => {
    setToken("")
    window.location.reload()
  }

  return (
    <div class="flex max-w-[820px] flex-col gap-6">
      <div class="flex items-center gap-3.5">
        <span class="grid h-11 w-11 place-items-center rounded-full bg-line-inner text-[16px] text-fg-2">O</span>
        <div>
          <span class="block text-[15px] text-fg">Owner</span>
          <span class="block text-[12px] text-fg-3">The only account this home has</span>
        </div>
        <div class="ml-auto">
          <MissingOp op="owner.profile" detail="No name, avatar or profile record is stored." />
        </div>
      </div>

      <Group title="Owner token">
        <Row title="Owner token" detail="Signs you in on a new device; anyone with it has full access">
          <div class="flex flex-col gap-2.5">
            <div class="flex h-9 items-center gap-2.5 rounded-[2px] border border-line bg-page px-3">
              <Glyph name="key" size={14} class="text-fg-3" />
              <Show
                when={signedIn()}
                fallback={<span class="font-mono text-[12.5px] text-fg-3">No token in this browser</span>}
              >
                <span class="font-mono text-[12.5px] tracking-[0.08em] text-fg">own_••••••••••••••••••••</span>
                <Chip tone="ok" class="ml-auto">
                  Set
                </Chip>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Show
                when={replacing()}
                fallback={
                  <Button
                    size="sm"
                    onClick={() => setReplacing(true)}
                  >
                    <Glyph name="rotate-ccw" size={14} />
                    Replace token
                  </Button>
                }
              >
                <span class="text-[12px] text-fg-2">This signs you out and reloads the sign-in screen.</span>
                <Button size="sm" variant="quiet" onClick={() => setReplacing(false)}>Keep</Button>
                <Button size="sm" variant="primary" onClick={replace}>Sign out and replace</Button>
              </Show>
            </div>
            <Note>
              The token is never rendered here. The stored copy stays in this browser; replacing it goes through the sign-in
              flow, which verifies the new token before saving it.
            </Note>
          </div>
        </Row>
      </Group>

      <Group title="Signed in">
        <Panel>
          <div class="flex items-center gap-2.5 px-3.5 py-2.5">
            <Glyph name="monitor" size={14} class="text-fg-3" />
            <div class="min-w-0 flex-1">
              <span class="block text-[12.5px] text-fg">This browser</span>
              <span class="block text-[11.5px] text-fg-3">Owner session · token in local storage</span>
            </div>
            <Chip tone="ok">This device</Chip>
          </div>
        </Panel>
        <div class="pt-2">
          <MissingOp op="session.list" detail="The backend keeps no session table; one token is the whole identity." />
        </div>
      </Group>

      <Group title="Danger">
        <Row title="Sign out everywhere" detail="Rotating the owner token is the only recovery path">
          <div class="flex items-center gap-2">
            <Button size="sm" variant="danger" disabled>Sign out everywhere</Button>
            <MissingOp op="session.revoke" />
          </div>
        </Row>
      </Group>
    </div>
  )
}
