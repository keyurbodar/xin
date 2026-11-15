# Ingle plugins

Everything in Ingle past the kernel is a plugin: the orchestrator, memory, schedules, the market itself. A plugin is a package under `plugins/<name>/` (or an npm dependency) with an `ingle` field in its `package.json`. It can have two halves:

- **A server module** (`index.ts`): a Cordis plugin that runs in your Home's Durable Object and adds tools, prompts, ops, timers, routes or services.
- **A web module** (`client.tsx`, optional): it fills named slots in the shell, such as a pane tab, a palette command, a composer button, a tool's transcript card or a theme.

Both halves are compiled into the build, so a plugin costs **0 Worker requests and 0 Durable Object rows per user action**. Turning one on or off is a single `plugin.enable` op, and the same switch governs both halves.

| Read | When |
| --- | --- |
| [authoring.md](authoring.md) | You are writing a plugin: scaffold, the dev loop, tests, deploy, the manifest |
| [client.md](client.md) | Your plugin adds UI: the seven slots, the SDK, the host API, themes |
| [permissions.md](permissions.md) | Your plugin reads secrets, files, storage, models or conversations, or you are deciding whether to install one |
| [publishing.md](publishing.md) | You want other Homes to install your plugin from a market index |

## Commands

```bash
bun scripts/ingle.ts plugin new <name> [--client]   # scaffold plugins/<name> from plugins/hello
bun scripts/ingle.ts plugin dev [--port N]          # Worker + web with live reload
bun scripts/ingle.ts plugin generate                # rewrite the catalog after a manifest change
bun scripts/ingle.ts plugin list                    # packages, plugins, and whether the build mounts them
bun scripts/ingle.ts plugin add <spec> [--enable]   # add an npm or git package to the build
```

The design and its reasoning live in the spec: `docs/plan/architecture/09-plugins.md` (plugins, permissions, client slots) and `12-market.md` (market, consent, integrity).
