import * as p0 from "../plugins/artifacts/index.ts"
import * as p1 from "../plugins/artifacts/tools.ts"
import * as p2 from "../plugins/compact/index.ts"
import * as p3 from "../plugins/deploy-hook/deployhook.ts"
import * as p4 from "../plugins/failures/index.ts"
import * as p5 from "../plugins/files/index.ts"
import * as p6 from "../plugins/files/tools.ts"
import * as p7 from "../plugins/git/index.ts"
import * as p8 from "../plugins/goals/index.ts"
import * as p9 from "../plugins/goals/tools.ts"
import * as p10 from "../plugins/goals/rounds.ts"
import * as p11 from "../plugins/guard/index.ts"
import * as p12 from "../plugins/intake/index.ts"
import * as p13 from "../plugins/jobs/index.ts"
import * as p14 from "../plugins/market/index.ts"
import * as p15 from "../plugins/mcp/index.ts"
import * as p16 from "../plugins/mcp/tools.ts"
import * as p17 from "../plugins/mcp/server.ts"
import * as p18 from "../plugins/memory/index.ts"
import * as p19 from "../plugins/memory/tools.ts"
import * as p20 from "../plugins/models/index.ts"
import * as p21 from "../plugins/models/tools.ts"
import * as p22 from "../plugins/orchestrator/index.ts"
import * as p23 from "../plugins/orchestrator/tools.ts"
import * as p24 from "../plugins/presets/index.ts"
import * as p25 from "../plugins/presets/preset.ts"
import * as p26 from "../plugins/push/index.ts"
import * as p27 from "../plugins/questions/index.ts"
import * as p28 from "../plugins/questions/tools.ts"
import * as p29 from "../plugins/schedules/index.ts"
import * as p30 from "../plugins/schedules/tools.ts"
import * as p31 from "../plugins/skills/index.ts"
import * as p32 from "../plugins/skills/tools.ts"
import * as p33 from "../plugins/time/index.ts"
import * as p34 from "../plugins/watchdog/index.ts"
import * as p35 from "../plugins/web/index.ts"
import * as p36 from "../plugins/workspace/index.ts"
import type { Row } from "./kernel/layers.ts"
import type { Catalog } from "./kernel/loader.ts"

export const CATALOG: Catalog = {
  artifacts: {
    plugin: p0,
    title: "Artifacts",
    description: "Thread documents with a revision.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-artifacts@0.1.0",
  },
  "tool-artifacts": {
    plugin: p1,
    title: "Artifact tools",
    description: "The model-facing artifact tool. Disable to hide it; the artifacts service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-artifacts@0.1.0",
  },
  compact: {
    plugin: p2,
    title: "Compaction",
    description: "Manual conversation compaction for the owner.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-compact@0.1.0",
  },
  "deploy-hook": {
    plugin: p3,
    title: "Deploy hook",
    description: "Deploys a new build by POSTing to a configured hook URL.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-deploy-hook@0.1.0",
  },
  failures: {
    plugin: p4,
    title: "Failures",
    description: "Run failures as visible entries.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-failures@0.1.0",
  },
  files: {
    plugin: p5,
    title: "Files",
    description: "R2-backed read, write and edit for pi's file tools.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-files@0.1.0",
  },
  "tool-files": {
    plugin: p6,
    title: "Files tools",
    description: "The model-facing files tools. Disable to hide them; the files service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-files@0.1.0",
  },
  "tool-git": {
    plugin: p7,
    title: "Git tools",
    description: "Read-only log, diff, show and blame for the project's GitHub repository.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-git@0.1.0",
  },
  goals: {
    plugin: p8,
    title: "Goals",
    description: "One durable objective per conversation: create, edit, pause, resume, complete, block and clear.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-goals@0.1.0",
  },
  "tool-goals": {
    plugin: p9,
    title: "Goal tools",
    description: "The model-facing goal tools. Disable to hide them; the goals service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-goals@0.1.0",
  },
  "goal-rounds": {
    plugin: p10,
    title: "Goal rounds",
    description: "Continues an active goal with one automatic round each time a run ends.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-goals@0.1.0",
  },
  guard: {
    plugin: p11,
    title: "Loop guard",
    description: "Reminds the model when it repeats the same tool call with identical arguments.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-guard@0.1.0",
  },
  intake: {
    plugin: p12,
    title: "Intake",
    description: "Inbound debounce, batch claim and dispatch.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-intake@0.1.0",
  },
  jobs: {
    plugin: p13,
    title: "Jobs",
    description: "Slow tools as jobs that report back.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-jobs@0.1.0",
  },
  market: {
    plugin: p14,
    title: "Market",
    description: "Discovery, install and update checks for plugin packages.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-market@0.1.0",
  },
  mcp: {
    plugin: p15,
    title: "MCP",
    description: "MCP servers as deferred tools.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-mcp@0.1.0",
  },
  "tool-mcp": {
    plugin: p16,
    title: "MCP tools",
    description: "The model-facing mcp tools. Disable to hide them; the mcp service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-mcp@0.1.0",
  },
  "mcp-server": {
    plugin: p17,
    title: "MCP server",
    description: "One MCP server connection carried by a row, for bundles.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-mcp@0.1.0",
  },
  memory: {
    plugin: p18,
    title: "Memory",
    description: "Notes with FTS recall and the Dreamer.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-memory@0.1.0",
  },
  "tool-memory": {
    plugin: p19,
    title: "Memory tools",
    description: "The model-facing memory tools. Disable to hide them; the memory service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-memory@0.1.0",
  },
  models: {
    plugin: p20,
    title: "Models",
    description: "Run-time model catalog, credentials and set_model.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-models@0.1.0",
  },
  "tool-models": {
    plugin: p21,
    title: "Models tools",
    description: "The model-facing models tools. Disable to hide them; the models service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-models@0.1.0",
  },
  orchestrator: {
    plugin: p22,
    title: "Orchestrator",
    description: "Coordinator tools and threads.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-orchestrator@0.1.0",
  },
  "tool-orchestrator": {
    plugin: p23,
    title: "Orchestrator tools",
    description: "The model-facing orchestrator tools. Disable to hide them; the orchestrator service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-orchestrator@0.1.0",
  },
  presets: {
    plugin: p24,
    title: "Presets",
    description: "Named agent presets that choose a conversation's plugins.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-presets@0.1.0",
  },
  preset: {
    plugin: p25,
    title: "Preset",
    description: "One agent preset carried by a row, for bundles.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-presets@0.1.0",
  },
  push: {
    plugin: p26,
    title: "Web Push",
    description: "Encrypted pushes when no tab is open.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-push@0.1.0",
  },
  questions: {
    plugin: p27,
    title: "Questions",
    description: "ask_user and pending requests.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-questions@0.1.0",
  },
  "tool-questions": {
    plugin: p28,
    title: "Questions tools",
    description: "The model-facing questions tools. Disable to hide them; the questions service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-questions@0.1.0",
  },
  schedules: {
    plugin: p29,
    title: "Schedules",
    description: "Scheduled tasks: recurring rules that deliver a prompt to a conversation.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-schedules@0.1.0",
  },
  "tool-schedules": {
    plugin: p30,
    title: "Schedules tools",
    description:
      "The model-facing create, list, view and edit tools for scheduled tasks. Disable to hide them; the schedules service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-schedules@0.1.0",
  },
  skills: {
    plugin: p31,
    title: "Skills",
    description: "Markdown skills loaded on demand.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-skills@0.1.0",
  },
  "tool-skills": {
    plugin: p32,
    title: "Skills tools",
    description: "The model-facing skills tools. Disable to hide them; the skills service keeps running.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-skills@0.1.0",
  },
  time: {
    plugin: p33,
    title: "Current time",
    description:
      "A user-role time reading with the owner's zone and the elapsed time before each request, without a tool.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-time@0.1.0",
  },
  watchdog: {
    plugin: p34,
    title: "Watchdog",
    description: "Fails stalled threads and overdue jobs.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-watchdog@0.1.0",
  },
  "tool-web": {
    plugin: p35,
    title: "Web tools",
    description: "Search the public web and fetch a page as readable text.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-web@0.1.0",
  },
  workspace: {
    plugin: p36,
    title: "Workspace",
    description: "Projects and thread documents.",
    manifest: { api: 1, requires: [] },
    local: true,
    source: "xin-plugin-workspace@0.1.0",
  },
}

export const BUNDLES: Readonly<Record<string, readonly Row[]>> = {
  "xin-plugin-artifacts": [
    { id: "artifacts", name: "cordis:artifacts" },
    { id: "tool-artifacts", name: "cordis:tool-artifacts" },
  ],
  "xin-plugin-compact": [{ id: "compact", name: "cordis:compact" }],
  "xin-plugin-deploy-hook": [{ id: "deploy-hook", name: "cordis:deploy-hook" }],
  "xin-plugin-failures": [{ id: "failures", name: "cordis:failures" }],
  "xin-plugin-files": [
    { id: "files", name: "cordis:files" },
    { id: "tool-files", name: "cordis:tool-files" },
  ],
  "xin-plugin-git": [{ id: "tool-git", name: "cordis:tool-git" }],
  "xin-plugin-goals": [
    { id: "goals", name: "cordis:goals" },
    { id: "tool-goals", name: "cordis:tool-goals" },
    { id: "goal-rounds", name: "cordis:goal-rounds" },
  ],
  "xin-plugin-guard": [{ id: "guard", name: "cordis:guard" }],
  "xin-plugin-intake": [{ id: "intake", name: "cordis:intake" }],
  "xin-plugin-jobs": [{ id: "jobs", name: "cordis:jobs" }],
  "xin-plugin-market": [{ id: "market", name: "cordis:market" }],
  "xin-plugin-mcp": [
    { id: "mcp", name: "cordis:mcp" },
    { id: "tool-mcp", name: "cordis:tool-mcp" },
  ],
  "xin-plugin-memory": [
    { id: "memory", name: "cordis:memory" },
    { id: "tool-memory", name: "cordis:tool-memory" },
  ],
  "xin-plugin-models": [
    { id: "models", name: "cordis:models" },
    { id: "tool-models", name: "cordis:tool-models" },
  ],
  "xin-plugin-orchestrator": [
    { id: "orchestrator", name: "cordis:orchestrator" },
    { id: "tool-orchestrator", name: "cordis:tool-orchestrator" },
  ],
  "xin-plugin-presets": [
    { id: "presets", name: "cordis:presets", config: { default: "full" } },
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
  "xin-plugin-push": [{ id: "push", name: "cordis:push" }],
  "xin-plugin-questions": [
    { id: "questions", name: "cordis:questions" },
    { id: "tool-questions", name: "cordis:tool-questions" },
  ],
  "xin-plugin-schedules": [
    { id: "schedules", name: "cordis:schedules" },
    { id: "tool-schedules", name: "cordis:tool-schedules" },
  ],
  "xin-plugin-skills": [
    { id: "skills", name: "cordis:skills" },
    { id: "tool-skills", name: "cordis:tool-skills" },
  ],
  "xin-plugin-time": [{ id: "time", name: "cordis:time", config: { timezone: "UTC" } }],
  "xin-plugin-watchdog": [{ id: "watchdog", name: "cordis:watchdog" }],
  "xin-plugin-web": [{ id: "tool-web", name: "cordis:tool-web" }],
  "xin-plugin-workspace": [{ id: "workspace", name: "cordis:workspace" }],
}

export const XIN_VERSION = "0.1.0"
