import * as p0 from "../plugins/artifacts/index.ts"
import * as p1 from "../plugins/artifacts/tools.ts"
import * as p2 from "../plugins/compact/index.ts"
import * as p3 from "../plugins/deploy-hook/deployhook.ts"
import * as p4 from "../plugins/failures/index.ts"
import * as p5 from "../plugins/files/index.ts"
import * as p6 from "../plugins/files/tools.ts"
import * as p7 from "../plugins/git/index.ts"
import * as p8 from "../plugins/git-native/index.ts"
import * as p9 from "../plugins/goals/index.ts"
import * as p10 from "../plugins/goals/tools.ts"
import * as p11 from "../plugins/goals/rounds.ts"
import * as p12 from "../plugins/guard/index.ts"
import * as p13 from "../plugins/hello/index.ts"
import * as p14 from "../plugins/intake/index.ts"
import * as p15 from "../plugins/issues/index.ts"
import * as p16 from "../plugins/issues/tools.ts"
import * as p17 from "../plugins/jobs/index.ts"
import * as p18 from "../plugins/market/index.ts"
import * as p19 from "../plugins/mcp/index.ts"
import * as p20 from "../plugins/mcp/tools.ts"
import * as p21 from "../plugins/mcp/server.ts"
import * as p22 from "../plugins/memory/index.ts"
import * as p23 from "../plugins/memory/tools.ts"
import * as p24 from "../plugins/models/index.ts"
import * as p25 from "../plugins/models/tools.ts"
import * as p26 from "../plugins/orchestrator/index.ts"
import * as p27 from "../plugins/orchestrator/tools.ts"
import * as p28 from "../plugins/presets/index.ts"
import * as p29 from "../plugins/presets/preset.ts"
import * as p30 from "../plugins/push/index.ts"
import * as p31 from "../plugins/questions/index.ts"
import * as p32 from "../plugins/questions/tools.ts"
import * as p33 from "../plugins/schedules/index.ts"
import * as p34 from "../plugins/schedules/tools.ts"
import * as p35 from "../plugins/skills/index.ts"
import * as p36 from "../plugins/skills/tools.ts"
import * as p37 from "../plugins/time/index.ts"
import * as p38 from "../plugins/watchdog/index.ts"
import * as p39 from "../plugins/web/index.ts"
import * as p40 from "../plugins/workspace/index.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog } from "./kernel/loader.ts"

export const CATALOG: Catalog = {
  artifacts: {
    plugin: p0,
    title: "Artifacts",
    description: "Thread documents with a revision.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-artifacts@0.1.0",
  },
  "tool-artifacts": {
    plugin: p1,
    title: "Artifact tools",
    description: "The model-facing artifact tool. Disable to hide it; the artifacts service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-artifacts@0.1.0",
  },
  compact: {
    plugin: p2,
    title: "Compaction",
    description:
      "Conversation compaction: the owner's manual compaction, tool-result pruning and summaries on the utility model.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-compact@0.1.0",
  },
  "deploy-hook": {
    plugin: p3,
    title: "Deploy hook",
    description: "Deploys a new build by POSTing to a configured hook URL.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-deploy-hook@0.1.0",
  },
  failures: {
    plugin: p4,
    title: "Failures",
    description: "Run failures as visible entries.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-failures@0.1.0",
  },
  files: {
    plugin: p5,
    title: "Files",
    description: "R2-backed read, write and edit for pi's file tools.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-files@0.1.0",
  },
  "tool-files": {
    plugin: p6,
    title: "Files tools",
    description: "The model-facing files tools. Disable to hide them; the files service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-files@0.1.0",
  },
  "tool-git": {
    plugin: p7,
    title: "Git tools",
    description: "Read-only log, diff, show and blame for the project's GitHub repository.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-git@0.1.0",
  },
  "tool-git-native": {
    plugin: p8,
    title: "Native git tools",
    description:
      "Clone and read a public git repository of any host inside the Worker: history, a file at a revision, and a diff between two revisions.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-git-native@0.1.0",
  },
  goals: {
    plugin: p9,
    title: "Goals",
    description: "One durable objective per conversation: create, edit, pause, resume, complete, block and clear.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-goals@0.1.0",
  },
  "tool-goals": {
    plugin: p10,
    title: "Goal tools",
    description: "The model-facing goal tools. Disable to hide them; the goals service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-goals@0.1.0",
  },
  "goal-rounds": {
    plugin: p11,
    title: "Goal rounds",
    description: "Continues an active goal with one automatic round each time a run ends.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-goals@0.1.0",
  },
  guard: {
    plugin: p12,
    title: "Loop guard",
    description: "Reminds the model when it repeats the same tool call with identical arguments.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-guard@0.1.0",
  },
  hello: {
    plugin: p13,
    title: "Hello",
    description: "One tool and one prompt: the smallest plugin that adds something you can see.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-hello@0.1.0",
  },
  intake: {
    plugin: p14,
    title: "Intake",
    description: "Inbound debounce, batch claim and dispatch.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-intake@0.1.0",
  },
  issues: {
    plugin: p15,
    title: "Issues",
    description:
      "Issues with editable states, sub-issues, links, a timeline and search. Comments, state and assignee changes wake the owning thread.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-issues@0.1.0",
  },
  "tool-issues": {
    plugin: p16,
    title: "Issue tools",
    description:
      "The model-facing issue tool (create, read, update, comment). Off by default: its declaration adds about a kilobyte to every request.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-issues@0.1.0",
  },
  jobs: {
    plugin: p17,
    title: "Jobs",
    description: "Slow tools as jobs that report back.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-jobs@0.1.0",
  },
  market: {
    plugin: p18,
    title: "Market",
    description: "Discovery, install and update checks for plugin packages.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-market@0.1.0",
  },
  mcp: {
    plugin: p19,
    title: "MCP",
    description: "MCP servers as deferred tools.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-mcp@0.1.0",
  },
  "tool-mcp": {
    plugin: p20,
    title: "MCP tools",
    description: "The model-facing mcp tools. Disable to hide them; the mcp service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-mcp@0.1.0",
  },
  "mcp-server": {
    plugin: p21,
    title: "MCP server",
    description: "One MCP server connection carried by a row, for bundles.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-mcp@0.1.0",
  },
  memory: {
    plugin: p22,
    title: "Memory",
    description: "Notes with FTS recall and the Dreamer.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-memory@0.1.0",
  },
  "tool-memory": {
    plugin: p23,
    title: "Memory tools",
    description: "The model-facing memory tools. Disable to hide them; the memory service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-memory@0.1.0",
  },
  models: {
    plugin: p24,
    title: "Models",
    description: "Run-time model catalog, credentials and set_model.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-models@0.1.0",
  },
  "tool-models": {
    plugin: p25,
    title: "Models tools",
    description: "The model-facing models tools. Disable to hide them; the models service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-models@0.1.0",
  },
  orchestrator: {
    plugin: p26,
    title: "Orchestrator",
    description: "Coordinator tools and threads.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-orchestrator@0.1.0",
  },
  "tool-orchestrator": {
    plugin: p27,
    title: "Orchestrator tools",
    description: "The model-facing orchestrator tools. Disable to hide them; the orchestrator service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-orchestrator@0.1.0",
  },
  presets: {
    plugin: p28,
    title: "Presets",
    description: "Named agent presets that choose a conversation's plugins.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-presets@0.1.0",
  },
  preset: {
    plugin: p29,
    title: "Preset",
    description: "One agent preset carried by a row, for bundles.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-presets@0.1.0",
  },
  push: {
    plugin: p30,
    title: "Web Push",
    description: "Encrypted pushes when no tab is open.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-push@0.1.0",
  },
  questions: {
    plugin: p31,
    title: "Questions",
    description: "ask_user and pending requests.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-questions@0.1.0",
  },
  "tool-questions": {
    plugin: p32,
    title: "Questions tools",
    description: "The model-facing questions tools. Disable to hide them; the questions service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-questions@0.1.0",
  },
  schedules: {
    plugin: p33,
    title: "Schedules",
    description: "Scheduled tasks: recurring rules that deliver a prompt to a conversation.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-schedules@0.1.0",
  },
  "tool-schedules": {
    plugin: p34,
    title: "Schedules tools",
    description:
      "The model-facing create, list, view and edit tools for scheduled tasks. Disable to hide them; the schedules service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-schedules@0.1.0",
  },
  skills: {
    plugin: p35,
    title: "Skills",
    description: "Markdown skills loaded on demand.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-skills@0.1.0",
  },
  "tool-skills": {
    plugin: p36,
    title: "Skills tools",
    description: "The model-facing skills tools. Disable to hide them; the skills service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-skills@0.1.0",
  },
  time: {
    plugin: p37,
    title: "Current time",
    description:
      "A user-role time reading with the owner's zone and the elapsed time before each request, without a tool.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-time@0.1.0",
  },
  watchdog: {
    plugin: p38,
    title: "Watchdog",
    description: "Fails stalled threads and overdue jobs.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-watchdog@0.1.0",
  },
  "tool-web": {
    plugin: p39,
    title: "Web tools",
    description: "Search the public web and fetch a page as readable text.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-web@0.1.0",
  },
  workspace: {
    plugin: p40,
    title: "Workspace",
    description: "Projects and thread documents.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "ingle-plugin-workspace@0.1.0",
  },
}

export const BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "ingle-plugin-artifacts": [
    { id: "artifacts", name: "cordis:artifacts" },
    { id: "tool-artifacts", name: "cordis:tool-artifacts" },
  ],
  "ingle-plugin-compact": [{ id: "compact", name: "cordis:compact" }],
  "ingle-plugin-deploy-hook": [{ id: "deploy-hook", name: "cordis:deploy-hook" }],
  "ingle-plugin-failures": [{ id: "failures", name: "cordis:failures" }],
  "ingle-plugin-files": [
    { id: "files", name: "cordis:files" },
    { id: "tool-files", name: "cordis:tool-files" },
  ],
  "ingle-plugin-git": [{ id: "tool-git", name: "cordis:tool-git", disabled: true }],
  "ingle-plugin-git-native": [{ id: "tool-git-native", name: "cordis:tool-git-native", disabled: true }],
  "ingle-plugin-goals": [
    { id: "goals", name: "cordis:goals" },
    { id: "tool-goals", name: "cordis:tool-goals" },
    { id: "goal-rounds", name: "cordis:goal-rounds" },
  ],
  "ingle-plugin-guard": [{ id: "guard", name: "cordis:guard" }],
  "ingle-plugin-hello": [{ id: "hello", name: "cordis:hello" }],
  "ingle-plugin-intake": [{ id: "intake", name: "cordis:intake" }],
  "ingle-plugin-issues": [
    { id: "issues", name: "cordis:issues" },
    { id: "tool-issues", name: "cordis:tool-issues", disabled: true },
  ],
  "ingle-plugin-jobs": [{ id: "jobs", name: "cordis:jobs" }],
  "ingle-plugin-market": [{ id: "market", name: "cordis:market" }],
  "ingle-plugin-mcp": [
    { id: "mcp", name: "cordis:mcp" },
    { id: "tool-mcp", name: "cordis:tool-mcp" },
  ],
  "ingle-plugin-memory": [
    { id: "memory", name: "cordis:memory" },
    { id: "tool-memory", name: "cordis:tool-memory" },
  ],
  "ingle-plugin-models": [
    { id: "models", name: "cordis:models" },
    { id: "tool-models", name: "cordis:tool-models" },
  ],
  "ingle-plugin-orchestrator": [
    { id: "orchestrator", name: "cordis:orchestrator" },
    { id: "tool-orchestrator", name: "cordis:tool-orchestrator" },
  ],
  "ingle-plugin-presets": [
    {
      id: "presets",
      name: "cordis:presets",
      config: { default: "full", threadOmits: ["tool-schedules", "tool-goals"] },
    },
    {
      id: "preset-full",
      name: "cordis:preset",
      config: { id: "full", name: "Full", description: "Every plugin.", plugins: "all" },
    },
    {
      id: "preset-minimal",
      name: "cordis:preset",
      config: {
        id: "minimal",
        name: "Minimal",
        description: "Memory and skills only.",
        plugins: ["tool-memory", "tool-skills"],
      },
    },
  ],
  "ingle-plugin-push": [{ id: "push", name: "cordis:push" }],
  "ingle-plugin-questions": [
    { id: "questions", name: "cordis:questions" },
    { id: "tool-questions", name: "cordis:tool-questions" },
  ],
  "ingle-plugin-schedules": [
    { id: "schedules", name: "cordis:schedules" },
    { id: "tool-schedules", name: "cordis:tool-schedules" },
  ],
  "ingle-plugin-skills": [
    { id: "skills", name: "cordis:skills" },
    { id: "tool-skills", name: "cordis:tool-skills" },
  ],
  "ingle-plugin-time": [{ id: "time", name: "cordis:time", config: { timezone: "UTC" } }],
  "ingle-plugin-watchdog": [{ id: "watchdog", name: "cordis:watchdog" }],
  "ingle-plugin-web": [{ id: "tool-web", name: "cordis:tool-web", disabled: true }],
  "ingle-plugin-workspace": [{ id: "workspace", name: "cordis:workspace" }],
}

export const INGLE_VERSION = "0.1.0"
