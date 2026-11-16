# Client plugins: adding to the shell

A plugin's web module is a `client.tsx` that default-exports `definePlugin` from `@ingle/sdk`. `plugin generate` compiles it into the web build through a lazy `import()` loader in `web/src/plugins.gen.ts`, so it becomes its own chunk. Nothing is fetched from outside the build at run time. The shell loads each module on its own and renders each slot component in its own error boundary, so a module that throws at import or while rendering is logged and left out, and the rest of the shell keeps working.

Declare it in the manifest next to the server module, together with every slot it fills:

```json
"weather": {
  "module": "./index.ts",
  "client": "./client.tsx",
  "slots": ["pane.tab", "palette.command"]
}
```

`plugin generate` refuses a module without slots and slots without a module. A plugin that is UI only still ships a server module, which may be an empty `apply`, because its row is what `plugin.enable` turns on and off.

## Slots

| Slot | Where it shows | Fields | Component props |
| --- | --- | --- | --- |
| `sidebar.section` | the sidebar, below the first-party sections | `id`, `title`, `component`, `order?` | `{ host }` |
| `pane.tab` | a tab in a conversation's right pane | `id`, `title`, `icon?`, `component`, `order?` | `{ host, conversation }` |
| `composer.action` | a button in the composer toolbar | `id`, `title`, `icon?`, `run(host, composer)` | none |
| `message.renderer` | the transcript card for one tool's result | `tool`, `component` | `{ host, call }` |
| `palette.command` | a row in the command palette (⌘K) | `id`, `title`, `keywords?`, `shortcut?`, `run(host)` | none |
| `settings.page` | a page under Settings, in the Plugins group | `id`, `title`, `component` | `{ host }` |
| `theme` | the Theme picker in Settings → General | `id`, `label`, `scheme`, `tokens` | data only |

`conversation` is `{ id, entries }`, or undefined when no conversation is open. `call` is `{ name, args, output, details, status }`, where `status` is `"running"`, `"done"` or `"error"`. The SDK re-exports `entryText`, `entryToolCalls` and `entryBatchRows`, so a pane can read the transcript in the same way the shell does.

## The host

Every slot receives `host`:

| Member | Does |
| --- | --- |
| `cmd(op, args)` | runs a backend op, the same `POST /v1/cmd` the shell uses |
| `navigate(path)` | moves the shell to a hash route |
| `conversation()` | returns the open conversation's id, if any |
| `composer.insert(text)`, `composer.submit(text)` | write to the open composer |
| `toast(text)` | shows a short notice |

Use `host.cmd` to reach the backend, and add an op to your server module when you need data no op returns. Nothing enforces that: a client module runs in the shell's own page with the owner's session, so it can call any op the owner can, open its own requests and read the page. Its manifest's `permissions` govern its server rows, not its client code. Installing a plugin with a client module is a decision to trust its author with the owner's account.

## Example

```tsx
import { definePlugin } from "@ingle/sdk"

export default definePlugin({
  name: "weather",
  slots: {
    "pane.tab": [
      {
        id: "forecast",
        title: "Forecast",
        component: (props) => <div class="px-4 py-3 text-sm text-ink-2">{props.conversation?.entries.length ?? 0} entries</div>,
      },
    ],
    "palette.command": [
      { id: "ask", title: "Ask for the forecast", run: (host) => host.composer.insert("What's the forecast?") },
    ],
  },
})
```

Use the shell's token classes (`text-ink`, `bg-card`, `border-line-2`, …), so your UI follows the owner's theme. `plugins/outline`, `plugins/standup` and `plugins/theme-pack` are working examples. They ship disabled, and you can turn them on in Extensions.

## Themes

A theme is data. It has a base `scheme` (`"dark"` or `"light"`) and `tokens` that override the colour tokens in `web/src/styles/tokens.css`, using their names without the `--color-` prefix (`bg`, `panel`, `card`, `ink`, `ink-2`, `accent`, `line-1`, …). Unknown names are dropped. The chosen theme's id and scheme are stored on the device, so the right scheme paints before the app loads.

## When a registration shows

A registration shows while at least one of its plugin's rows is `active` in the home snapshot. `plugin.enable` republishes that snapshot, so turning a plugin on or off updates every open tab at once.
