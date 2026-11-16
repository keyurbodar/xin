export type CatalogSkill = {
  readonly name: string
  readonly title: string
  readonly author: string
  readonly category: string
  readonly description: string
  readonly markdown: string
}

const skill = (name: string, title: string, category: string, description: string, body: string): CatalogSkill => ({
  name,
  title,
  author: "Ingle",
  category,
  description,
  markdown: `---\nname: ${name}\ndescription: ${description}\n---\n${body.trim()}\n`,
})

export const SKILLS: readonly CatalogSkill[] = [
  skill(
    "connect-your-browser",
    "Connect your own browser",
    "Connectors",
    "Walk the owner through connecting their real Chromium browser to Ingle with anomalyco/browse (MIT) over MCP, and use it with care.",
    `
# Connect your own browser

Use this when the owner wants you to work in their real browser: their tabs, logins and extensions. It uses [browse](https://github.com/anomalyco/browse) (MIT), an MCP server plus a Chromium extension that runs on the owner's computer. browse speaks MCP over stdio only, and Ingle reaches MCP servers over HTTPS, so the owner runs a small bridge and a tunnel next to it. Give the owner these steps one at a time and wait for each to finish.

1. Install browse and pair the extension: \`curl -fsSL https://opencode.ai/browse/install | bash\`, then \`browse install --agent none\`. It opens the Chrome Web Store for the extension and pairs it once it is added.
2. Bridge it to Streamable HTTP with [supergateway](https://github.com/supercorp-ai/supergateway) (MIT), protected by a key the owner makes up: \`npx -y supergateway --stdio "browse mcp" --outputTransport streamableHttp --port 8931 --apiKey <a long random key>\`.
3. Give it a public HTTPS address, for example a Cloudflare quick tunnel: \`cloudflared tunnel --url http://localhost:8931\`. It prints an https://…trycloudflare.com address.
4. In Ingle, add the MCP server named \`browse\` with the address followed by \`/mcp\` and the header \`Authorization: Bearer <the key>\` (Settings → Integrations, or the \`mcp.add\` op). The key is stored sealed and never shown again.

Once it is connected, find its tools with tool_search (for example "browse snapshot"). They cost nothing in a request until they are loaded.

Rules while using it:
- You act with the owner's logins. Ask before anything that sends, buys, deletes, posts or changes settings.
- Work in background tabs browse opens; do not close or navigate tabs the owner already had open.
- Read pages with snapshots rather than screenshots: they are text and cost far fewer tokens.
- When the task is done, tell the owner they can stop the tunnel and the bridge (Ctrl-C in both terminals); the server then shows as failing until they start them again.
`,
  ),
  skill(
    "review-a-diff",
    "Review a diff",
    "Engineering",
    "Review a change for correctness first, then risk, then style, and say what to do about each finding.",
    `
# Review a diff

Use this when the owner asks for a review of a pull request, a patch, or a set of changed files.

1. Read the description or the request first and write down, in one sentence, what the change is meant to do. Every finding is judged against that sentence.
2. Read the whole diff once without commenting. Note which files carry the behaviour and which only follow from it.
3. Go back through the behaviour files and look for, in this order:
   - Wrong results: inverted conditions, off-by-one bounds, missing awaits, unhandled empty or missing values.
   - Broken contracts: a changed signature, schema, or stored format whose other users were not updated.
   - Failure paths: what happens on a timeout, a retry, or a crash halfway through. Work that can run twice must be safe to run twice.
   - Tests: does a test fail without this change? If none would, say which one is missing.
4. Only then mention naming, duplication, or style, and only where it would mislead the next reader.

Write each finding as: where (file and line), what is wrong, why it matters, and the smallest fix. Mark each one as "must fix", "should fix", or "optional". End with a one-line verdict: ship, ship after the must-fix items, or rethink.

Do not restate the diff, and do not praise lines that are merely correct.
`,
  ),
  skill(
    "pr-description",
    "Write a PR description",
    "Engineering",
    "Turn a branch's commits and diff into a pull request description a reviewer can act on in two minutes.",
    `
# Write a PR description

1. Read the commits and the diff. Find the one reason this change exists; if there are two unrelated reasons, say the branch should be split.
2. Write the description in this shape:
   - **Title**: an imperative sentence under 70 characters that names the behaviour, not the files ("Retry webhook delivery with backoff", not "Update webhook.ts").
   - **Why**: two or three sentences on the problem, with a link to the issue if there is one.
   - **What changed**: the behaviour a user or caller will notice, then the notable implementation choices and the alternatives you rejected.
   - **How it was checked**: the exact commands or steps, and what you could not check.
   - **Risk and rollback**: what could break, who would notice, and how to undo it.
3. Mention cost when the change touches storage, network calls, or model tokens: how many extra reads, writes, or requests per action.
4. Keep it under 300 words. Leave out anything a reviewer can read faster in the diff.
`,
  ),
  skill(
    "issue-triage",
    "Triage an issue",
    "Engineering",
    "Reproduce, size, and label a new issue, then propose the next step and who should take it.",
    `
# Triage an issue

1. Restate the report in one sentence as expected versus actual behaviour. If you cannot, list the questions that would let you, and stop there.
2. Try to reproduce it from the steps given. Record the exact environment and version. If it does not reproduce, say what you tried.
3. Find where it lives: the component, and if possible the file and function. Search for earlier issues with the same symptom and link duplicates instead of opening a second thread.
4. Size it:
   - **Severity**: data loss or security first, then broken core flows, then degraded flows, then cosmetic.
   - **Reach**: everyone, a configuration, or one account.
   - **Effort**: a guess in hours or days, with the main unknown named.
5. Propose one next step: fix now, schedule, needs more information, or close (with the reason).

Post the result as a short comment with those headings. Never close an issue only because it is old.
`,
  ),
  skill(
    "debug-a-failure",
    "Debug a failure",
    "Engineering",
    "Find the root cause of a failing test, build, or production error by narrowing it down instead of guessing.",
    `
# Debug a failure

1. Capture the exact failure: the full error text, the command that produced it, and when it started. Quote it; do not paraphrase.
2. Decide what kind of failure it is. A flaky or infrastructure error (network, quota, a machine that went away) is handled differently from a deterministic one. Run it a second time before deciding.
3. Make it smaller. Find the shortest input, the single test, or the first commit where it fails. Bisect when there is a known good version.
4. Form one hypothesis at a time and write down what result would disprove it. Run that check. Keep a list of what you ruled out.
5. When you find the cause, explain the mechanism in two sentences: why this input reaches this line and produces this result.
6. Fix the cause, not the symptom. Add a test that fails without the fix. If the same error survives two fixes, step back and question the hypothesis.

Report: the cause, the evidence, the fix, and anything you ruled out along the way.
`,
  ),
  skill(
    "release-notes",
    "Write release notes",
    "Writing",
    "Group merged changes into release notes people actually read: what changed for them, and what they must do.",
    `
# Write release notes

1. Collect the merged changes since the last release: titles, descriptions, and labels.
2. Drop internal-only changes (refactors, test-only, CI) unless they change speed or reliability someone will notice.
3. Group what is left under: **New**, **Improved**, **Fixed**, and **Action needed**. Put "Action needed" first if it has anything in it.
4. Write each item from the reader's side, in one sentence, present tense: "Search now matches file contents", not "Added content indexing to search service".
5. For breaking changes, give the exact steps to migrate and the version they apply from.
6. Thank outside contributors by name when the project does so.

Keep the whole note short enough to read in a minute. Link to the full changelog for everything else.
`,
  ),
  skill(
    "meeting-notes",
    "Meeting notes",
    "Work",
    "Turn a transcript or rough notes into decisions, owners, and dates, with the discussion kept short.",
    `
# Meeting notes

1. Read the whole transcript or notes before writing anything.
2. Write the notes in this order:
   - **Decisions**: each one a full sentence, with who made it.
   - **Actions**: a task, one owner, and a due date. If a task has no owner, list it under "Needs an owner" instead of guessing.
   - **Open questions**: what was raised but not settled, and who will bring an answer.
   - **Discussion**: at most five bullets on the reasoning behind the decisions.
3. Use names as they appear in the source. Do not infer pronouns; use names or "they".
4. Leave out small talk, repeated points, and anything said off the record.

If the owner asks, draft a short follow-up message to the attendees that lists only the decisions and actions.
`,
  ),
  skill(
    "research-brief",
    "Research brief",
    "Research",
    "Answer a question from primary sources, separate what is known from what is claimed, and cite every fact.",
    `
# Research brief

1. Restate the question and what a useful answer looks like (a number, a recommendation, a comparison). Ask only if the question has two readings that lead to different work.
2. Prefer primary sources: official documentation, papers, filings, source code, and first-hand data. Use secondary sources only to find primary ones.
3. For each fact, keep the source link and the date it was published or retrieved. Note when sources disagree, and why one is more credible.
4. Write the brief:
   - **Answer**: two or three sentences, with the main caveat.
   - **Evidence**: the facts that support it, each with its citation.
   - **What is uncertain**: gaps, stale data, and claims you could not verify.
   - **Next steps**: what would settle the uncertainty, if it matters.
5. Never present a guess as a finding. Say "I could not find" when you could not.
`,
  ),
  skill(
    "weekly-review",
    "Weekly review",
    "Work",
    "Close the week: what shipped, what slipped and why, and the three things that matter most next week.",
    `
# Weekly review

1. Gather the week's material: finished threads and issues, merged pull requests, notes, and the goals set last week.
2. Write four short sections:
   - **Shipped**: what is done and in use, one line each, with links.
   - **Slipped**: what was planned and not finished, with the honest reason (blocked, underestimated, deprioritised).
   - **Learned**: one or two things that would change how the next week is planned.
   - **Next week**: the three outcomes that matter most, each phrased as a result rather than an activity.
3. Compare "Next week" with last week's list. If the same item appears a third time, say so and suggest splitting it, delegating it, or dropping it.
4. Keep it under a page. The owner should be able to read it in two minutes on Monday morning.
`,
  ),
]
