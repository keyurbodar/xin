# Goal: the Xin design system and product boards

Work on Doop canvas `dKdthNj8oB`. Start with `get_guide({ topic: "doop-instructions" })` and follow it.

## Objective

Design the full Xin web app as a complete board set, as deep as the Kiko Design System (KDS) boards. That means foundations, components, every surface, every state, every spec with measurements, motion sheets and variant explorations. The catalogue below lists 120 boards plus a variant board for every ★ surface, about 140 in all, not a handful of frames.

Xin is a personal agent that runs durably in the cloud. It is shaped like Claude Projects (beta): each project has one coordinator chat, and the coordinator starts threads that work in parallel and report back. You design mockups, layouts, micro-interactions and motion. Ignore the backend, except for the product facts listed under "What Xin does".

The goal is done when every board in the catalogue below exists and meets the board standard, and the final review board passes.

## Inputs

1. **Claude Projects demo video.** `/home/keyur/.t3/userdata/attachments/91da4c4b-a840-44e2-90d3-727366a2f7f3-a86d583b-5eda-41fc-885d-0f246e2c772f-mp4.mp4` (4 min 33 s). Extract frames with `ffmpeg -i <video> -vf fps=2 frames/%04d.png` and go through every UI moment frame by frame. Write a frame log (timestamp, what is on screen, what we keep, what we change) as board `X0`. Moments to study:
   - the projects list and the New project dialog (name, goal, context)
   - the welcome message with suggestions
   - the coordinator chat with inline thread chips and live status lines
   - the right panel: Threads grouped Waiting on you, Working, Idle and Resolved; Library; schedules; an opened thread with "Steer this thread"; expand and collapse
   - the Connectors directory (Yours, Discover, categories)
   - the Settings modal (General, Memory, Environment, Usage)
   - the schedule card and the regression card with "View thread"
2. **KDS design system zip.** `/home/keyur/.t3/userdata/attachments/91da4c4b-a840-44e2-90d3-727366a2f7f3-0491c92c-7eff-425d-814d-bdc5f2962a45-zip.zip`. It holds `KDS/boards` (61 boards in html and png), `KDS/tokens`, `KDS/icons/phosphor`, `KDS/icons/pictograms` and `KDS/brand`. Spec: `/home/keyur/.t3/userdata/attachments/91da4c4b-a840-44e2-90d3-727366a2f7f3-05e82f04-bad7-4cc4-b483-62dfe4c865c7-md.md`. Treat it as the model for **how deep and how organised** the boards must be. Its mockups describe an older product.
3. **Source of truth for tokens and components: the live Kiko code in `/home/keyur/kiko`.** It has changed a lot since the zip. Read these before drawing anything:
   - `apps/web-solid/src/index.css`
   - `apps/web-solid/src/settings/kit.css`
   - `apps/web-solid/src/files/card.css`
   - `packages/theme/src` (palette, look, system, chips, display)
   - `packages/ui/src` (components, icons)

   Wherever the code and the zip disagree, the code wins. Board `F0` records every difference you found.

## Design language (keep from KDS, values from the live code)

- Graphite surfaces. One accent colour, used only for focus, links, live work, unread and selection.
- States are translucent overlays (`fill-*`). Borders are inset shadows.
- Status uses rings and discs, never ticks. Danger and warning always come with a word.
- Instrument Sans for the UI, Newsreader for display only, mono for code only. No italics, no dot separators, no mono labels.
- Every number on a board is a token from the live code: colour, space, radius, type, shadow, duration, easing.
- Dark and light themes for every surface board.

## What changes from Kiko

Kiko is an agent roster with chats, like x.ai. Xin is projects. There is no agent roster and there are no group chats. Xin is not code-first, so repos, PRs and CI are not core UI. A project's context is its files, memory and connectors. A plugin may add cards later, so design one generic card a plugin can fill.

## What Xin does (design every one of these)

| Feature | Notes |
|---|---|
| Projects | Each has a coordinator chat, a goal, instructions, a preset, files, memory and schedules |
| Coordinator | Answers directly or starts threads. Posts updates when threads finish or need you |
| Threads | States: queued, working, waiting on you, completed, failed, cancelled. Each has a live status line and elapsed time, and can be opened, steered, stopped and re-run |
| Reports | A thread's result lands in the coordinator chat as a report card |
| Questions | "Waiting on you" cards with an inline answer (choices or free text). They also appear in the right panel and as push notifications |
| Files | Project library with folders, previews and a viewer. Agent-written documents appear here |
| Memory | What Xin remembers, by project and global. Editable and forgettable |
| Schedules | Created in plain language ("every day at 5pm…"). Confirmation card, list, next run, pause, history |
| Jobs | Long-running background work with progress |
| Models | Any model, picked per project or conversation, switched mid-chat by picker or in plain language. Effort level. No model is hard-coded, so the picker lists whatever the catalog has |
| Presets | Named tool sets per project, such as Full or Minimal |
| Failures and cost | Visible failure entries with Retry. Usage and cost per project and model |
| Push | Web push for waiting-on-you, finished and failed |
| Extensions (market) | Discover, Installed, Updates. Two package kinds: **Instant** (a bundle: skills, prompts, MCP servers, presets; installs and updates in seconds) and **Needs a build** (code; applies on the next deploy). Install review, update, rollback, deploy |
| Customize | Skills, prompts, MCP servers (connectors), presets |
| Advanced | Plugin rows: on/off toggles, config forms generated from a schema, secret fields, which layer set each value |
| System | Version, "Update Xin", restart, a degraded or boot-failed state |

## Board standard (every board)

- **Title and ID** as in the catalogue, plus one sentence on the board's job.
- **Surface boards:** dark and light, at desktop width (1440) and, where the catalogue asks, at tablet (1024) and mobile (390).
- **States:** every state the element can be in: rest, hover, focus-visible, pressed, selected, disabled, loading, empty, error, live and overflow (long text, many items). Show these side by side.
- **Spec boards:** redlines with sizes, paddings, gaps, radii, type styles and token names. Every number traced to a token.
- **Motion boards:** each motion as a filmstrip of keyframes plus a table: trigger, property, from, to, duration token, easing token, delay, stagger. Include the `prefers-reduced-motion` fallback for each.
- **Variant boards (`…V`):** 2 or 3 real alternatives for the same surface, each with a short pros and cons note, and a marked recommendation. A variant board exists for every surface whose design is a real choice (marked ★ in the catalogue).
- **Real content.** Write project names, thread titles, status lines, reports and settings copy as if from a real owner. No lorem ipsum.
- **Decisions** you made without asking go in a "Calls I made" note on the board.

## Board catalogue

Keep these IDs and this order. A family may add boards when the content needs them.

### X · Research
- X0 Video frame log (from the demo, frame by frame)
- X1 Kiko to Xin delta: what we keep, change and drop
- X2 Product map: every screen and how you move between them
- X3 Information architecture: nav, project, panel, settings, extensions

### F · Foundations (from the live code)
- F0 Token audit: differences between the zip and the code
- F1 Colour: surfaces, text, overlays, borders, accent, danger and warning, dark and light
- F2 Type scale and usage
- F3 Space, radius and shape
- F4 Elevation and layering (canvas, panel, raised, overlay, toast)
- F5 Interaction states as overlays
- F6 Motion foundations: duration and easing tokens, choreography rules
- F7 Iconography: the Phosphor set we use, sizes, plus new pictograms for Xin
- F8 Status language: rings, discs and words for every thread and job state
- F9 Layout grid and breakpoints: desktop, tablet, mobile, and how the three columns flex
- F10 Accessibility: contrast pairs, focus rings, hit targets, reduced motion

### C · Components
- C1 Buttons (primary, secondary, ghost, danger, icon, split)
- C2 Fields (text, textarea, search, select, secret field with reveal, inline edit)
- C3 Menus, dropdowns and context menus
- C4 Chips and tags (status chip, kind badge Instant or Needs a build, count badge)
- C5 Toggles, checkboxes, radios and segmented controls
- C6 Tabs (panel tabs, page tabs)
- C7 Dialogs, sheets and drawers
- C8 Toasts, banners and inline notices (including the build-pending bar)
- C9 Tooltips and popovers
- C10 Lists and rows (nav row, thread row, file row, plugin row)
- C11 Cards (thread chip, report card, question card, schedule card, failure card, generic plugin card)
- C12 Progress (spinner, live ring, determinate bar, elapsed timer)
- C13 Code and markdown rendering
- C14 Empty, loading and error components
- C15 Avatars and identity (owner, coordinator, thread)
- C16 Keyboard shortcuts sheet and command palette

### S · Left sidebar
- S1 Sidebar spec ★ (S1V variants)
- S2 Sidebar states (live dot, waiting on you, unread, renaming, drag to reorder)
- S3 Sidebar motion
- S4 Collapsed rail
- S5 Project switcher and search

### H · Home and projects
- H1 Home: project list with live counts ★ (H1V)
- H2 Home empty, first project
- H3 New project dialog (name, goal, context, preset) ★ (H3V)
- H4 New project motion: dialog to the first coordinator message
- H5 Project welcome with suggestions

### B · Coordinator chat
- B1 Chat layout spec ★ (B1V)
- B2 Bubbles and message spec (me, coordinator, system notice)
- B3 Thread chips inline: queued, working with status line, waiting, done, failed ★ (B3V)
- B4 Fan-out: one message starts eight threads
- B5 Report card landing ★ (B5V)
- B6 Question card: choices, free text, answered state ★ (B6V)
- B7 Schedule confirmation card and run result card
- B8 Failure card with Retry, and a cost or limit notice
- B9 Model switch notice, mid-chat, by picker and by plain language
- B10 Attachments and files in chat
- B11 Message actions (copy, retry, edit, open thread)
- B12 Long and streaming content, working indicator with elapsed time
- B13 Chat motion

### M · Composer
- M1 Composer spec ★ (M1V)
- M2 Model and effort picker ★ (M2V)
- M3 Preset chip and switcher
- M4 Attachments and drop
- M5 Send, Stop and Steer states
- M6 Slash commands and mentions (threads, files, skills)
- M7 Composer motion

### P · Right panel
- P1 Panel spec and tabs ★ (P1V)
- P2 Threads tab grouped (Waiting on you, Working, Idle, Done, Failed) ★ (P2V)
- P3 Thread row states and overflow
- P4 Opened thread: transcript, "Steer this thread", Stop, status, re-run ★ (P4V)
- P5 Expanded thread (full width) and back
- P6 Files tab: library, folders, sort, grid and list
- P7 File viewer (doc, image, code, markdown, pdf) and the agent-written document view
- P8 Memory tab: entries, edit, forget, search
- P9 Schedules tab: list, next run, pause, history
- P10 Jobs: background work with progress
- P11 Panel search
- P12 Panel motion: tab switch, open thread, expand, collapse

### E · Extensions (market)
- E1 Discover: search, categories, featured ★ (E1V)
- E2 Package card states: available, installed, update, pending build, local, incompatible
- E3 Package page: README, versions, what it adds, what it can reach, requires ★ (E3V)
- E4 Install review sheet ★ (E4V)
- E5 Installed list: on/off, configure, remove
- E6 Updates: count, Update, Update all, changelog
- E7 Update flow: Lahn published 1.1, then the badge, click, progress, done
- E8 Rollback: "1.1 failed to start, back on 1.0", plus manual rollback
- E9 Build pending bar, Deploy, the deploying state, done after reload
- E10 Index sources: add an index URL
- E11 Extensions motion

### K · Customize
- K1 Customize home
- K2 Skills: list, editor, a skill from a bundle (read-only, with its source)
- K3 Prompts: list and editor
- K4 Connectors (MCP servers): add, connected, failed, secret headers
- K5 Presets: list, editor (tool picker), assign to project
- K6 Advanced: plugin rows with toggles and layer badges
- K7 Advanced: generated config form, secrets, reset to default, "set by" provenance

### T · Settings
- T1 Settings modal spec ★ (T1V)
- T2 General: coordinator and thread models, effort, thread limit, pause the project
- T3 Instructions and preset
- T4 Memory settings
- T5 Notifications and push
- T6 Usage and cost: per project, per model, over time
- T7 Models and providers: keys, catalog
- T8 System: version, Update Xin, restart, degraded state
- T9 Account and owner token

### O · First run
- O1 Sign in with the owner token
- O2 Add a model provider key
- O3 Create the first project
- O4 First message to the first report
- O5 Turn on notifications

### Q · Mobile (390)
- Q1 Home
- Q2 Project chat
- Q3 Right panel as a bottom sheet ★ (Q3V)
- Q4 Opened thread
- Q5 Question answered from a push notification
- Q6 Extensions on mobile
- Q7 Mobile motion

### Z · System states
- Z1 Offline and reconnecting
- Z2 Boot failed and degraded
- Z3 Loading skeletons for every surface
- Z4 Errors: op rejected, unavailable, rate limited
- Z5 Very large data: 40 threads, 500 files, long names

### R · Review
- R1 Coverage checklist: every feature in "What Xin does" mapped to its boards
- R2 Consistency audit: every number on every board traced to a token
- R3 Open questions for the owner

## Process

1. Do X0 to X3 and F0 first. Post the product map and the token audit, then continue without waiting.
2. Build F, then C, before the surface boards, so every surface uses the components.
3. For each ★ surface, make the variant board first, pick one, then make its spec, states and motion boards.
4. Ask the owner only about product choices that you cannot settle yourself. Make every other call and log it on the board.
5. Finish with R1 to R3.
