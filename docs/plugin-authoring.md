# Write a Xin plugin

A plugin adds one ability to a Home: a tool the model can call, a prompt the owner runs as a slash command, a timer, an op, a route. It is one TypeScript module plus a manifest in `package.json`, and it runs with the same access as the kernel. Installing the build is the trust decision: there is nothing to approve and no sandbox.

Work in a checkout of Xin. `bun install` here and in `web/` (the gate typechecks the client too), then:

## 1 · Scaffold

```bash
bun scripts/xin.ts plugin new greeting
```

This writes `plugins/greeting/` — `index.ts`, `package.json` and `greeting.test.ts` — regenerates `src/catalog.gen.ts`, and adds `xin-plugin-greeting` to `xin.profile.json`, the list of packages your build mounts. The name is lowercase letters, digits and hyphens, starting with a letter.

## 2 · Edit the module

`plugins/greeting/index.ts` is the whole plugin:

```ts
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { obj, opt, str } from "@earendil-works/pi-schema"
import { rowId } from "../../src/contributions.ts"
import { type Context, Schema, textResult } from "../../src/kernel/index.ts"

export const name = "greeting"
export const inject = ["pi", "prompts"]

export const Config = Schema.object({
  greeting: Schema.string().default("Hi").description("The word the tool opens with."),
})

type Config = { readonly greeting: string }

export function apply(ctx: Context, config: Config): void {
  ctx.pi.install(
    defineExtension({
      name: `tool-${name}`,
      tools: [
        defineTool({
          name: "greeting",
          description: "Greet the owner with the greeting this plugin is configured with.",
          parameters: obj({
            who: opt(str({ minLength: 1, maxLength: 64, description: "Who to greet. The owner by default." })),
          }),
          replay: "safe",
          execute: async (args) => textResult(`${config.greeting}, ${args.who ?? "owner"}!`),
        }),
      ],
    }),
  )
  ctx.prompts.contribute(
    {
      name: "greeting",
      description: "Greet me with the greeting tool.",
      text: "Greet me with the greeting tool, then tell me which greeting the plugin is configured with.",
    },
    rowId(ctx),
  )
}
```

- `name` is the plugin's name, the same word the manifest uses.
- `inject` lists the kernel services the module reads. Every `ctx.<service>` you touch must be in it; the gate's lint fails otherwise.
- `Config` is validated settings with working defaults. The owner changes them with `plugin.configure` or the Extensions screen; the plugin does useful work before anyone configures it.
- `apply` registers capabilities, and every registration is an effect: turning the plugin off or reconfiguring it unwinds exactly what it added.
- The tool is model-facing; the prompt is the owner's slash command, listed by `prompt.list`.
- The pi extension that carries the tools is named `tool-*`; that is the one naming rule the registry enforces.

## 3 · Test it

```bash
id=$(bun scripts/gate.ts submit types test --only=plugins/greeting)
bun scripts/gate.ts wait $id
```

`greeting.test.ts` turns the plugin on in a real Home, has the model call its tool, and reads `prompt.list`. The file runs in about a second. Extend it as you add capabilities; the same command runs the whole gate without `--only` before you deploy.

## 4 · Deploy it

Deploy the build the way you deploy Xin (`wrangler deploy`, or your CI's deploy step). Then `plugin.doctor` answers `ok: true`, `plugin.list` shows the plugin as active, and `prompt.list` shows the prompt.

## The manifest

```json
{
  "xin": {
    "plugins": {
      "greeting": {
        "module": "./index.ts",
        "title": "Greeting",
        "description": "Greets the owner and offers a slash command.",
        "api": 1
      }
    },
    "bundle": [{ "id": "greeting", "plugin": "greeting" }]
  }
}
```

| Field | Meaning |
| --- | --- |
| `module` | the file that exports `name`, `inject` and `apply` |
| `title`, `description` | what the owner sees in Extensions |
| `api` | the plugin API the module is written against; `1` today, and a module written for another version fails alone, with the reason in `plugin.doctor` |
| `requires` | other plugins it needs, as `name` or `name@range`; a missing or too-old one fails that plugin alone, not the Home |
| `bundle` | the entries this package mounts when it is in your build; one plugin needs one entry, and it can be omitted when the package declares exactly one plugin |

## What a plugin can add

| Capability | Registration |
| --- | --- |
| tool | `defineTool` in an extension named `tool-*` |
| prompt | `ctx.prompts.contribute(prompt, rowId(ctx))` |
| skill | `ctx.skills.contribute(skill, rowId(ctx))` |
| prompt section | `section(key, render)` |
| hook | `hook(GenerationTask \| ToolTask, handlers)` |
| wrap | `wrapTool` / `wrapSection` |
| task, doc | `defineTask`, `defineDoc` |
| op | `ctx.ops.define(op)` |
| timer | `ctx.clock.timer({ due, fire })` |
| route | `ctx.http.route("GET /path", handler)` |
| service | `ctx.provide(key, value)`, for other plugins to `inject` |

A plugin that others call provides a service; one that only adds tools, prompts or ops provides none.

## Where it applies

A plugin is on or off per **preset**, and a preset applies at one **scope**: the whole Home, a project, or a thread. Your build mounts the plugin; a preset decides which conversations get its tools and prompts. The shipped `full` preset keeps every plugin, so a new one is available everywhere until the owner makes a narrower preset.

## Removing one

Delete `plugins/greeting/`, then:

```bash
bun scripts/xin.ts plugin disable xin-plugin-greeting
bun scripts/xin.ts plugin generate
```
