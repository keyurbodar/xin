# Ingle design system v2

Status: spec, 16 Nov 2026 (issue AMA-23, built by thread XIN-25). It supersedes the structure parts of the v4/v5 handoff (`handoffs/design-system.md` in the Bosun drive): metrics, type, radii, layout and component anatomy. Colour and motion carry over unchanged. Each surface PR lands the tokens it consumes and rebuilds that surface's behaviour on UI SDK in the same pass, so every component changes once.

## 1. Sources and what we may take

| Source | What it is | What we take | What we never take |
|---|---|---|---|
| Linear (`handoffs/design/linear.app-DESIGN.md`) | A reading of Linear's marketing site | System structure: one grotesk at intermediate weights, hierarchy from size not boldness, a 4px rhythm, 0.5px translucent edges, 12px panel radius, compact 13px chrome, 16/14/20 icons | Its colours (canvas, pale action, acid and frosted proof), copy, names, marks, and the marketing-only scale (64–72px type, 128–224px chapter spacing, proof cards, wireframe art) |
| Palermo (palermo.tryprofound.com) | Profound's public design-system docs; not a package | Type ramp with pixel line heights on a 2/4px grid, radius scale, page gutter and compact header, and component anatomy: Composer slots, Section Header, Kbd, Status Badge, Empty State, Segmented Tabs, Split Button | Its colours and accent spectrum, its React/Radix code |
| zeron (github.com/zeronsh/zeron, MIT, © 2026 Wing) | Native iOS (UIKit) and Android apps for driving coding agents | Mobile flow and patterns: search-pill header, filter chips, foldable grouped lists, two-line cells, a floating New button, capsule composer that grows into a card, bottom sheets with a grabber and large title, a companions sheet, floating activity pills | Code. Its mobile apps are Swift and Kotlin, so nothing ports to Solid; we adapt patterns only. Attribution stays in this doc and in each mobile PR. |
| emil-design-eng skill (project-xin drive) | Motion and polish rules | Applied to every component and motion decision below (§6) | — |
| UI SDK (`@ui-sdk/core` + `@ui-sdk/web`) | Headless behaviours with ARIA | Every keyboard, focus, selection, dismissal, popup and drag behaviour (§7) | Its `web.css` look; we style from `data-slot` and state attributes with our tokens |
| sadu-ui (github.com/y0u-0/sadu-ui) | 56 React components styled after Al Sadu weaving, built on UI SDK. The repo has no licence file and no `license` field, so all rights are reserved | The woven structure as a restrained motif (§4.3), and its way of composing UI SDK primitives (§7.3), translated to Solid | Code, colours, themes, motifs, the weave renderer and its copy. No licence means nothing is reused verbatim |

Precedence when sources disagree, highest first: UI SDK for every behaviour; Linear and Palermo structure with emil-design-eng for the design system; zeron for phone UX; the Sadu motif only where it improves structure.

capy.ai's literal values stay out, as before.

## 2. Colour (unchanged)

Every colour token in `web/src/styles/tokens.css` carries over exactly: `bg`, `panel`, `card`, `card-hover`, `popover`, `muted`, `secondary`, `hover`, `line-1..3`, `ink`, `ink-2`, `ink-3`, `icon`, `placeholder`, `accent`, `accent-ink`, `on-accent`, `primary*`, `inverse`, the status set as it exists today (`working`, `working-text`, `working-soft`, `needs`, `needs-text`, `done`, `done-text`, `done-soft`, `failed`, `failed-soft`, `merged`), `diff-add`, `diff-del`, `scrim`, and the `light` and `rose` themes plus the Custom accent. v2 adds no colour. Where Linear or Palermo use a fill, we use the nearest existing Ingle role:

| Their role | Ingle role |
|---|---|
| Canvas / level 0 | `bg` |
| Raised panel / level 1 | `panel` (shell surfaces), `card` (dialogs, popovers via `popover`) |
| Translucent panel edge | `shadow-ring` (0.5px `line-2`), unchanged |
| Primary action fill | `accent` / `on-accent` |
| Secondary action fill | `secondary` with `shadow-ring` |
| Muted copy / faint copy | `ink-2` / `ink-3` |

## 3. Tokens v2

All lengths sit on a 4px grid; 2px is allowed only for hairline offsets and line heights under 16px. Names are what lands in `tokens.css`; Tailwind reads them through `@theme`.

### 3.1 Spacing

| Token | px | Use |
|---|---|---|
| `--space-0_5` | 2 | Icon-to-label nudge, list row gap (Linear footer rows) |
| `--space-1` | 4 | Chip inner gap, stacked meta lines |
| `--space-1_5` | 6 | Icon-to-label in buttons and menu items |
| `--space-2` | 8 | Grouped controls, title-to-copy, menu padding |
| `--space-3` | 12 | Card padding (compact), paired actions, sheet row padding |
| `--space-4` | 16 | Page gutter on phones, dialog row gap, section label to list |
| `--space-6` | 24 | Page gutter on desktop, dialog body padding, section-to-section |
| `--space-8` | 32 | Settings content inset, empty-state block gap |
| `--space-10` | 40 | Empty-state heading to composer |
| `--space-12` | 48 | Top of a settings page above its title |

Tailwind's `--spacing: 4px` stays, so `p-6` is 24px; the named tokens exist for the layout values below and for CSS outside Tailwind.

### 3.2 Layout

| Token | Value | Source and reason |
|---|---|---|
| `--page-gutter` | 16px under 640px, 24px from 640px | Palermo `page-gutter` |
| `--section-inset` | `calc(var(--page-gutter) / 2)` | Palermo `section-inset-unit`; aligns section headers with list rows |
| `--h-header` | 48px (was `--h-topbar` 44) | Palermo `header-compact`; a 32px control with 8px above and below |
| `--h-tab` | 32px pointer, 36px touch (was 28/32) | Room for a 16px icon, a close button and the 2px active rule |
| `--w-sidebar` | 240px, unchanged | Linear's sidebar sits between 220 and 244 |
| `--w-pane` | 432px, unchanged | |
| `--w-column` | 720px, unchanged | Reading measure for the transcript |
| `--w-settings` | 640px | Linear settings measure; content centred with `--space-8` inset |
| `--w-palette` | 640px, unchanged | |
| `--w-dialog-sm/md/lg` | 440 / 560 / 640px | Replaces per-call `w-[..]` widths |
| Breakpoints | phone < 640, tablet 640–1023, desktop ≥ 1024, wide ≥ 1280 (pane docks) | Wide is today's dock point; phone is the 390px target |

### 3.3 Sizing

| Token | Pointer | Touch | Use |
|---|---|---|---|
| `--h-control-xs` | 24 | 28 | Inline icon buttons, chips |
| `--h-control-sm` | 28 | 32 | Toolbar buttons, segmented tabs |
| `--h-control` | 32 | 40 | Default buttons, inputs, selects |
| `--h-control-lg` | 36 | 44 | Primary dialog actions, mobile composer send |
| `--h-row` | 28 | 40 | Sidebar items, menu rows are `--h-control` (32) |
| `--h-list-row` | 36 | 56 (two-line) | Issues, threads, automations, drive rows (Linear list density; zeron two-line cell on phones) |
| `--h-palette-row` | 36 | 44 | ⌘K results (was 28) |
| `--h-badge` | 20 | 24 | Status badges, Kbd |
| Icons | 16 default, 14 secondary, 20 large | same | Linear's icon footprint; matches lucide at 1.5 stroke |

Touch density applies under `(pointer: coarse)` or `data-density="touch"`, as today. The touch column now meets a 40px minimum target everywhere a finger lands first (rows, controls) and 44px for primary actions.

### 3.4 Type

Inter Variable for UI, Geist Mono for code, ids and costs, unchanged. Pixel line heights replace ratios so text sits on the grid. Weights use Inter's variable axis: 400 body, 510 titles and labels (Linear), 590 for rare emphasis. Nothing uses 700.

| Token | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| `--text-micro` | 11 / 16 | 510 | 0 | Badge counts, Kbd |
| `--text-mini` | 12 / 16 | 400 / 510 | 0 | Meta lines, section labels, timestamps |
| `--text-small` | 13 / 18 | 400 / 510 | -0.005em | All chrome: sidebar, tabs, menus, list rows, buttons (Linear's 13px chrome) |
| `--text-body` | 14 / 20 | 400 / 510 | -0.006em | Inputs, dialog body, settings descriptions |
| `--text-reading` | 15 / 24 | 400 | -0.011em | Transcript prose and documents (Linear body) |
| `--text-title-mini` | 16 / 24 | 510 | -0.011em | Dialog and sheet titles, card titles |
| `--text-title-sm` | 18 / 24 | 510 | -0.015em | Section headers, mobile sheet titles |
| `--text-title` | 24 / 32 | 510 | -0.02em | Page titles, empty-state heading |
| `--text-title-lg` | 28 / 32 | 510 | -0.022em | Mobile large titles, onboarding |

Touch density adds 1px to `small`, `body` and `reading` (13→14, 14→15, 15→16) and keeps the line heights, as today. Feature settings `"cv11", "ss01"` stay.

The old `--text-2xs..2xl` names alias the new ones until their last consumer moves, then they go: `2xs`→`micro`, `xs`→`mini`, `sm`→`small`, `base`→`body`, `lg`→`title-mini`, `xl`→`title-sm`, `2xl`→`title`.

### 3.5 Radii

| Token | px | Use |
|---|---|---|
| `--radius-xs` | 4 | Kbd, inline code, checkboxes, tiny chips |
| `--radius-sm` | 6 | Buttons, inputs, menu items, list row hover |
| `--radius-md` | 8 | Popovers, menus, toasts, cards inside panels |
| `--radius-lg` | 12 | Shell panels, dialogs, the desktop composer card (Linear panels) |
| `--radius-xl` | 16 | Mobile bottom sheets (top corners), mobile composer card |
| `--radius-full` | 9999 | Filter chips, the collapsed mobile composer capsule, the New thread button on phones, avatars |

`--radius-2xs` (2px) is dropped; its one use (progress fill) takes `full`.

### 3.6 Depth

Shadows and the 0.5px ring carry over (`shadow-ring`, `shadow-overlay`, `shadow-popover`, `shadow-composer`). Linear's lesson is restraint: edges catch light, interiors stay close to the canvas. So v2 adds no shadow, and panels inside panels use `ring` only.

## 4. Pattern map

Adopt means we build it as described. Change means we take the idea with a stated difference. Skip means we don't, and why.

### 4.1 Desktop structure

| Pattern | From | Decision | Why |
|---|---|---|---|
| Hierarchy from size at one intermediate weight (510), never bold | Linear | Adopt | Calmer chrome; our 600 titles read heavy next to 13px chrome |
| 13px chrome, 15px reading text | Linear | Adopt | Dense instruments, airy prose; today everything is 14 |
| Pixel line heights on a 4px grid | Palermo | Adopt | Rows and text align; ratios drift by half pixels |
| 0.5px translucent edges, 12px panels | Linear | Adopt (we already ring at 0.5px; radius moves 8→12 on shell panels) | Matches the instrument feel without new colours |
| Pill primary buttons | Linear marketing | Skip for app buttons; adopt for chips and the phone capsule | Pills at 13px in dense toolbars waste width; Linear's own app uses 6px buttons |
| Section Header: title, badge, subtitle left; actions right; `Section` owns vertical rhythm | Palermo | Adopt for every page and pane section | Replaces six ad-hoc header rows |
| Settings: left nav, centred 640 column, grouped rows (label and description left, control right) in a 12px ringed card with hairline separators | Linear app | Adopt | Our settings stack loose controls; grouped rows scan faster |
| List rows: leading status, mono id, title, trailing chips, assignee, date, 36px | Linear issues | Adopt for Issues; same anatomy for threads, automations and drive | One row grammar across lists |
| Filter chips row above a list (All, Needs you, Working, Pinned) with counts | zeron | Adopt on threads and issues lists, desktop and phone | One tap filters; today filtering hides behind search |
| Foldable grouped sections with counts and a section overflow | zeron, Linear sidebar | Adopt in the sidebar (per project) and lists | Long thread lists stay navigable |
| ⌘K palette with grouped results, 36px rows, Kbd hints | Linear, Palermo Command Bar | Adopt; rows grow 28→36 | Easier to hit and read; Kbd component shows shortcuts |
| Kbd component (mono 11px, 20px tall, 4px radius, `secondary` fill) | Palermo | Adopt | Shortcut hints are hand-written strings today |
| Composer anatomy: attachments strip inside the card; footer start (+, model, reasoning) and end (context meter, send/stop); attached top surface for the queue and usage notices; question takeover replaces the editor | Palermo Composer | Adopt | Our needs-you questions and queued messages get a home inside the card instead of above it |
| Composer working spectrum ring and success halo | Palermo | Change: no ring; the existing Signal shows working, and success gets no halo | Emil: animation needs a purpose; Signal already states it, a ring repeats it |
| Send button: dimmed idle, enabled while typing, becomes Stop while streaming | Palermo | Adopt | Today send and stop are separate controls |
| Empty state: icon, 24/32 title, one line, one action | Palermo, zeron new session | Adopt; a new thread shows a centred prompt above the composer | Replaces several bespoke empties |
| Status Badge (dot + label) | Palermo | Change: keep Signal as the dot | Signal is Ingle's mark |
| Split Button (primary action + menu) | Palermo | Adopt for Run now / schedule in Automations and Send / queue in the composer | Secondary choices without a second button |
| Segmented Tabs | Palermo | Adopt (UI SDK Segmented Control) for two-to-four-way choices in dialogs and settings | Replaces hand-rolled radiogroups |
| Linear's marketing scale, proof cards, wireframe art, chapter spacing | Linear | Skip | Marketing site, not an app |

### 4.2 Mobile (phone, 390px target), adapted from zeron

| Pattern | Decision | Ingle shape |
|---|---|---|
| Home is the thread list: a search pill header with the menu button left and the avatar right | Adopt | Menu opens the sidebar as a left sheet (projects, Captains, settings); search filters threads in place |
| Filter chips under the header | Adopt | All, Needs you (count), Working, Pinned |
| Grouped, foldable sections with counts | Adopt | Pinned, then one section per project, then Recent |
| Two-line cell: avatar or project tile, title, meta line (project · branch), trailing status and PR or time | Adopt | Signal replaces zeron's status text colour; 56px rows |
| Floating New thread button, bottom right, pill with label | Adopt | Opens the new-thread screen |
| New thread screen: close X, title, centred prompt, composer with project and branch chips | Adopt | Replaces the New thread dialog on phones |
| Thread screen header: back, title with a subtitle line, companions button with a count badge, overflow menu | Adopt | Companions is the right pane (overview, files, issues, crew); overflow holds side thread, pin, copy transcript, archive, delete |
| Capsule composer pinned to the bottom ("+ Message", send), growing into a card with chips when focused | Adopt | Chips: model, reasoning, context. It stays above the on-screen keyboard through `--keyboard-inset`, which UI SDK's Dialog and Drawer content set themselves; Ingle defines no such token |
| Floating activity pills above the composer ("1 working", side threads count) | Adopt | Tap opens the companions sheet at the crew section |
| Bottom sheets: grabber, large title, close X, grouped options with section labels, selected row filled with a check | Adopt | Model picker (with segmented provider tabs), project picker, session menu, companions |
| Swipe down to dismiss with momentum | Adopt | UI SDK Drawer (`side="bottom"`), per emil momentum dismissal |
| Tablet: companions as an inspector column | Adopt | Same as today's docked pane at ≥1280; tablets get a sheet below that |
| Terminal, key bar, voice, wallpaper, glass blur | Skip | No such features in Ingle; blur costs frames on mid phones |

### 4.3 Woven structure (sadu-ui), as a motif

The rule: a motif earns its place by carrying meaning (a boundary, a sequence or a state) in Ingle's existing colours. Where it only decorates, it stays out.

| Pattern | Decision | Ingle shape and why |
|---|---|---|
| Numbered section label with a trailing rule ("01 Rug ——") | Adopt for Settings sections, onboarding steps and pane sections | Mono 12/16 `ink-3` index, 13/18 510 label, then a `line-1` hairline to the edge. It gives long pages a scannable sequence, and Palermo's Section Header keeps title and actions |
| Banded divider with a centre knot (line · label · line) | Adopt for date dividers in the transcript and lists ("Today", "Earlier") and for "New since you left" | A `line-2` rule, 13/18 `ink-3` label, and a 4px rotated-square knot in `line-3` on each side. It marks a boundary in time, which a bare rule doesn't say. Built on UI SDK Separator |
| Stitched (dashed) framing | Change: only for states that aren't solid yet: the file drop target, a queued message and a draft issue | A 1px dashed `line-3` edge means "not yet". On settled surfaces it would read as noise |
| Woven band under the active tab | Change: a 2px `ink` band under the active conversation tab and the active pane tab, 1px above the strip's hairline | Stronger than a fill change at 13px, and it meets the 3:1 state contrast UI SDK asks for |
| Rhythmic repeated bands (striped meters, loom progress) | Change: the context meter's category bar keeps its 1px gaps between segments | The gap already reads as banding; more pattern would hide the numbers |
| Patterned cord edge on popups and dialogs | Skip | Every menu and dialog would carry a decorative strip; popovers read busier, and Linear's restraint wins in the precedence order |
| Woven controls (switch as cloth, rating as eyes, slider as loom), the beater animation, rugs, skeins | Skip | Ornament over function, and the beater reveal fails emil's frequency rule for UI used many times a day |
| Its palettes and day/tent themes | Skip | Ingle's colours stay |

## 5. Component anatomy (v2)

| Component | Anatomy and sizes |
|---|---|
| Button | Heights from §3.3; padding-x 10 (sm) / 12 (md) / 14 (lg); 6px radius; 13px 510; icon 16 with 6px gap. Variants: primary (`accent`), secondary (`secondary` + ring), ghost, danger (`failed` text, `failed-soft` hover). Press scale .97 via `im-press`. |
| Icon button | Square at the control height; 16px icon; `aria-label` required. |
| Input / Textarea | 32px (touch 40); 8px horizontal padding; 6px radius; ring `line-2`, focus `primary` 1px + 3px `primary-soft`; 14px text. |
| Menu | 8px radius popover, 4px padding, rows 32px with 8px padding, 13px text, 16px leading icon, trailing Kbd; section label 12px 510 `ink-3`; separators `line-1` with 4px margin. |
| Popover / picker | Menu surface; search input row 36px with a bottom hairline; results as a listbox. |
| Dialog | Widths from §3.2; 12px radius; header 48px with 16/24 510 title and close; body 24px padding with 16px gaps; footer 56px, actions right, primary last. |
| Bottom sheet (phone) | 16px top radius; grabber 36×4 at 8px; title 18/24 510 at 16px gutter; rows 48px; close X 32px. |
| Tabs (conversation strip) | 32px tabs, 13px, close on hover or focus, active tab `card` with ring; strip 40px with 4px gaps. |
| Section Header | Title 18/24 510 (page) or 13/18 510 `ink-2` (pane section), optional badge, subtitle 13/18 `ink-3`; actions right; 12px below. |
| List row | §4.1 row grammar at `--h-list-row`; hover `hover`, selected `secondary` + 2px accent rule only for keyboard focus (`focus-visible`). |
| Filter chip | 28px (touch 32), full radius, 12px padding, 13px; selected `inverse` fill and `on-inverse` text; count in `micro`. |
| Kbd | 20px tall, 4px radius, mono 11px, `secondary` fill, `ink-2`. |
| Toast | Unchanged (Sonner rules in `ingle-motion.css`). |

## 6. Motion and polish (emil-design-eng)

`web/src/styles/ingle-motion.css` stays the source of truth and stays byte-identical to `handoffs/ingle-motion.css`; a change to one is a change to both in the same PR. v2 adds no new curve. Decisions for the new pieces, in the skill's required format:

| Before | After | Why |
|---|---|---|
| Palette rows animate on open | Palette opens and closes with no animation | Used 100+ times a day; keyboard-started |
| Filter chip swaps instantly | Fill transitions 100ms `--ease-color`; list below does not animate | Feedback on the control; animating a filtered list hides results |
| Mobile sheets fade | Sheet slides up 300ms `--ease-drawer`, exits at 70% (210ms), swipe dismiss uses release velocity | Spatial: it comes from and returns to the edge it lives on |
| Capsule composer jumps to card | Height and radius transition 200ms `--ease-out`, chips fade in 150ms after 50ms | Explains the change of state without delaying typing |
| Section fold collapses instantly | `im-grow` (grid rows) 200ms, chevron rotates 90° | The one allowed layout transition; already in the system |
| Hover states on touch | Gated behind `(hover: hover) and (pointer: fine)` | Sticky hover on phones reads as a bug |
| Popovers scale from centre | `transform-origin: var(--transform-origin)` from UI SDK | Origin-aware; dialogs stay centred |

Reduced motion keeps opacity and colour, drops movement, as today. Keyboard-started overlay changes stay instant (`data-instant`).

## 7. Behaviours on UI SDK

### 7.1 Adapter

`@ui-sdk/solid` requires Solid 2 (`solid-js` and `@solidjs/web` ≥ 2.0.0-rc.14); the app is on Solid 1.9.17, and Solid 2 is a release candidate with breaking changes across 40 `createResource` and 66 `createEffect` call sites. UI SDK's framework-neutral adapter, `@ui-sdk/web`, ships the same primitives as light-DOM custom elements, and Solid 1 renders them natively. A spike in Chromium confirmed it: a menu with Solid-rendered `<For>` items got `role="menu"`/`menuitem`, ArrowDown moved focus, Enter fired `action`, and focus returned to the trigger; a dialog driven by `prop:open` trapped focus, closed on Escape and restored focus. So surfaces use `<ui-*>` elements with `prop:` and `on:` bindings, typed in `web/src/ui-sdk.d.ts`, and `@ark-ui/solid` goes once its last use moves. Moving to `@ui-sdk/solid` becomes a mechanical rename when the app adopts Solid 2.

Two adapter facts each surface must respect: options are set as attributes or primitive properties (a function-valued option set as a property is stringified into its attribute, so use selectors), and a controlled overlay cancels `openchange` and lets the app flip `open`.

### 7.2 Audit: every behaviour and what replaces it

| Where | Today | UI SDK primitive | Surface PR |
|---|---|---|---|
| `ui/dialog.tsx` (shared Dialog shell, 9 dialogs) | Hand-rolled focus trap, Escape, scrim press, focus restore, a focusin hack for menus | Dialog | Overlays and menus |
| `onboarding/notifications-dialog.tsx` | Hand-rolled trap (`trapTab`), Escape, scrim | Dialog | Overlays and menus |
| `extensions/install-sheet.tsx`, `extensions/add-url.tsx` | Hand-rolled Escape and scrim sheets | Dialog (desktop), Drawer `side="bottom"` (phone) | Settings (after #35) |
| `shell/shell.tsx` sidebar drawer | Presence + scrim click, no trap, no Escape | Drawer `side="left"` | Shell and sidebar |
| `screens/project.tsx`, `screens/captain.tsx` pane sheet | Presence, no dismissal | Drawer `side="right"` non-modal below 1280px; Drawer `side="bottom"` on phones | Shell and sidebar |
| `shell/palette.tsx` ⌘K | Hand-rolled dialog, ArrowUp/Down, Enter, Escape, `aria-activedescendant` list | Command inside Dialog | Shell and sidebar (after #30) |
| `shell/shell.tsx` ⌘K / ⌘B | Window keydown | Dialog trigger `shortcut="mod+k"`; ⌘B stays app code (no primitive) | Shell and sidebar |
| `shell/conversation-tabs.tsx` tab strip | `role="tablist"` by hand, no arrow keys | Tabs (activation follows focus off, manual) | Shell and sidebar (after #30) |
| `shell/conversation-tabs.tsx` tab context menu | Ark `useMenu` | Menu with `ui-menu-context-trigger` | Shell and sidebar |
| `shell/conversation-tabs.tsx` drag reorder | Pointer events, FLIP, `tab-order.ts` | `createReorder` from `@ui-sdk/core` (keyboard reorder added); FLIP motion kept | Shell and sidebar |
| `shell/sidebar.tsx` row menus | Ark Menu | Menu | Shell and sidebar |
| `shell/sidebar.tsx` thread filter Escape | Inline keydown | Input with clear-on-Escape | Shell and sidebar |
| `composer/plus-menu.tsx` | Ark Menu with submenus | Menu with Sub | Composer and thread |
| `composer/reasoning-menu.tsx` | Ark Menu (radio) | Menu radio group | Composer and thread |
| `composer/model-picker.tsx` | Ark Popover + Listbox + collection, pointer guard | Combobox (search) in a Popover; Drawer on phones | Composer and thread |
| `composer/context-meter.tsx` | Ark Popover | Popover | Composer and thread |
| `chat/composer.tsx` ⌘/ attach shortcut | Document keydown | Stays app code: a global shortcut, not a control's behaviour | Composer and thread (after #30) |
| `chat/memory.tsx` inline edit Escape | Inline keydown | Input; Escape cancel stays app code | Composer and thread |
| `pane/pane.tsx` view picker | Ark Popover + Listbox | Command in a Popover | Overlays and menus |
| `pane/issues.tsx` new-issue popover | Ark Popover with a form | Popover | Issues |
| `pane/issue-edit.tsx` assignee and link pickers | Ark Popover + unroving button list + Enter-picks-first | Combobox in a Popover | Issues |
| `pane/issue-edit.tsx` inline title edit Escape | Inline keydown | Input; app code | Issues |
| `pane/issue-edit.tsx` link-kind radiogroup | Hand-rolled `role="radiogroup"` | Segmented Control | Issues |
| `pane/issue.tsx` issue menu | Ark Menu | Menu | Issues |
| `pane/drive.tsx` file menu, rename Escape | Ark Menu, inline keydown | Menu; Input | Drive |
| `pane/crew.tsx` thread menu | Ark Menu | Menu | Captains |
| `automations/parts.tsx` row menu | Ark Menu | Menu | Automations |
| `automations/dialog.tsx` "each run goes to" | Hand-rolled `role="radiogroup"` | Segmented Control | Automations |
| `onboarding/provider-step.tsx` provider choice | Hand-rolled `role="radiogroup"` | Radio Group | Settings |
| `extensions/chrome.tsx` toggle | Hand-rolled `role="switch"` | Switch | Settings |
| `settings/plugins.tsx`, `pane/overview.tsx` disclosures | `inert` + `im-grow` by hand | Collapsible (keeps `im-grow` motion) | Settings; Shell and sidebar |
| `ui/toast.tsx` + `state/toasts.ts` | Hand-rolled stack, swipe, Escape, timers | Toast with `ui-overlay-host`; Sonner motion kept | Overlays and menus (after #30) |
| `screens/offline.tsx` | Full-screen `role="alertdialog"` over an `inert` app (`app.tsx`), Tab trapped with `trapTab` | Alert Dialog, `dismissible="false"`; its modal makes the page inert, so the `inert` wrapper and `trapTab` go | Shell and sidebar |
| `screens/boot-failed.tsx` screen | Full-screen `role="alertdialog"`, no app behind it | Skip: nothing sits behind it to trap or make inert; it keeps `role="alertdialog"` with `aria-labelledby` | — |
| `screens/boot-failed.tsx` confirm | Inline `role="group"` with type-to-confirm, Escape closes it, focus moves in on mount | Skip: an inline confirmation inside the page, not a popup; Escape-to-cancel stays app code | — |
| `chat/composer.tsx` drop and paste, `pane/drive.tsx` drop, `screens/file.tsx` drop | `onDragOver`/`onDragLeave`/`onDrop` and `onPaste` by hand | File Input (dropzone and paste); our upload code stays | Composer and thread (after #30), Drive, Drive |
| `chat/automations.tsx`, `screens/automations.tsx` focus after delete | `neighbourAfter` + `firstFocusable` from `lib/focus.ts` | `createFocusRecovery` from `@ui-sdk/core` on the row list | Automations |
| `composer/attachments.tsx` chips leaving | `createPresence` keeps a chip mounted through its exit | Skip: app-driven list motion (the Sonner rule), not a popup behaviour. `shell/presence.ts` shrinks to this one use as the overlays above move to UI SDK, which keeps closing content shown until its exit ends | — |
| `automations/history.tsx` `RunRow` | `aria-expanded` disclosure by hand | Collapsible (keeps `im-grow`) | Automations |
| `pane/issues.tsx` priority and state pickers | Single-choice button groups with `aria-pressed` | Radio Group styled as segments (priority), Select (state) | Issues |
| `automations/triggers.tsx` cron presets | Single-choice `aria-pressed` buttons | Radio Group styled as segments | Automations |
| `onboarding/captain-step.tsx` templates | Single-choice `aria-pressed` buttons | Radio Group | Settings (onboarding) |
| `pane/drive.tsx` content/history mode | Two `aria-pressed` buttons | Segmented Control | Drive |
| `pane/drive.tsx` version list | `aria-pressed` per version row, one selected | Listbox | Drive |
| Independent toggles: `chat/markdown.tsx` wrap, `composer/model-picker.tsx` favourite, `shell/sidebar.tsx` search, `pane/issues.tsx` show closed | `aria-pressed` buttons | Toggle | Composer and thread, Composer and thread, Shell and sidebar, Issues |
| `screens/signin.tsx` reveal | `aria-pressed` show/hide on a password field | Password Input (its own toggle) | Settings (sign-in) |
| Native `<select>`: `captain/captain-dialog.tsx` (2), `automations/dialog.tsx`, `settings/parts.tsx`, `settings/models.tsx`, `extensions/config-form.tsx`, `onboarding/provider-step.tsx`, `onboarding/captain-step.tsx`, `pane/drive.tsx` | Native select | Select, styled with our tokens; it keeps form submission through `name` and adds typeahead that agents can see | Captains, Automations, Settings ×3, Settings (after #35), Settings (onboarding) ×2, Drive |
| `settings/models.tsx` native checkbox | `type="checkbox"` | Checkbox | Settings |
| Enter or mod+Enter to submit: `chat/composer.tsx` (2), `chat/cards.tsx`, `onboarding/thread-step.tsx`, `settings/usage.tsx`, `pane/issue.tsx` | `onKeyDown` on native inputs and textareas | Input and Textarea; the submit key stays app code, because submitting is the app's action and not a control behaviour | The surface that owns each field |
| `composer/model-picker.tsx` mod+D favourite | `onKeyDown` on the list | Moves with the picker to Combobox; the shortcut stays app code on the highlighted item | Composer and thread |
| `shell/conversation-tabs.tsx` ContextMenu / Shift+F10 | Hand-rolled key handler | Menu context trigger (handles both keys) | Shell and sidebar |
| `lib/motion.ts` keyboard/pointer tracking | Window listeners for `data-instant` | Skip: motion policy, not a behaviour UI SDK owns | — |
| Tooltips (`title` attributes today) | Native | Tooltip where a control has no visible text, with delay skip on subsequent hovers | Each surface |

Ark UI is gone when the last row above ships; the PR that moves it removes the dependency.

### 7.3 Composition, learned from sadu-ui

sadu-ui is React on `@ui-sdk/react`; these are the patterns, not its code:

- **One popup surface.** Every menu, popover, select and combobox content renders inside one shared surface component (radius, ring, shadow, padding, `--transform-origin`, `--available-height` max height). Ingle: `ui/surface.tsx` replaces the `MENU_CONTENT`, `SURFACE` and per-file class strings.
- **One overlay kit.** Dialog, Alert Dialog and Drawer share header (title + close), body and footer parts, so the three overlays can't drift. Ingle: the Dialog shell's header and footer become parts that the notifications dialog, the extension sheets and the phone sheets reuse.
- **Shortcuts come from the core.** `formatShortcut` and `ariaKeyshortcuts` from `@ui-sdk/core` render the Kbd text and the `aria-keyshortcuts` value from one `mod+k` string, replacing hand-written "⌘/" labels.
- **Thin wrappers that forward state.** Each wrapper styles the UI SDK part through `data-slot` and state attributes and passes every other prop through, so behaviour stays UI SDK's and the wrapper owns only the look.
- **Separator for every rule that has meaning.** Labelled dividers use UI SDK Separator, so screen readers get `role="separator"` once and decorative rules stay `aria-hidden`.

## 8. Surface order

The open plugin stack (#30) touches `chat/composer.tsx`, `chat/entries.tsx`, `chat/transcript.tsx`, `pane/views.tsx`, `settings/general.tsx`, `shell/conversation-tabs.tsx`, `shell/palette.tsx`, `shell/sidebar.tsx`, `ui/toast.tsx`, `ui/icon.tsx`, `state/toasts.ts`, `screens/settings.tsx`, `lib/theme.ts` and the plugin slots; #35 touches the extensions sheets. Surfaces that don't overlap go first:

1. Overlays and menus: tokens v2 land here with the Dialog shell, menus, popovers and the pane view picker. Palette and toasts wait for #30.
2. Drive.
3. Issues.
4. Automations.
5. Captains.
6. Shell and sidebar (after #30): sidebar, tabs, drag reorder, palette, drawers.
7. Composer and thread (after #30).
8. Settings (after #30 and #35).
9. Mobile: the phone flow in §4.2 across the surfaces above, at 390px.

Every surface PR attaches desktop and 390px renders (also in `renders/XIN-25/` in the Bosun drive), adds Chromium tests for the keyboard and dismissal behaviour it moves, and keeps `bun scripts/gate.ts` and `bun test src` green.
