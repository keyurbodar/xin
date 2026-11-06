# Skills

Markdown skills with `name` and `description` frontmatter. Every conversation gets a `skills` prompt section that lists names and descriptions only. The `skill(name)` tool loads a skill's body on demand. Owner skills live in kv under `skill:<name>` and apply to the next request.

## Sub-features

- `skill.put {name, markdown}`: a malformed frontmatter or a name mismatch gives a `bad_args` ack (stored, so a retry gets the same answer).
- `skill.list`, `skill.delete {name}`.
- `skill(name)` for an unknown name gives an error result with close names.

## How to get to it (user POV)

Settings, Skills: paste a Markdown skill. The model sees the list and loads a skill when the task matches.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
$S call POST /v1/cmd '{"id":"vs-1","op":"skill.put","args":{"name":"research","markdown":"---\nname: research\ndescription: How to research a topic\n---\nSearch, read three sources, summarise."}}'   # ok, {name, description}
$S call POST /v1/cmd '{"id":"vs-2","op":"skill.put","args":{"name":"bad","markdown":"no frontmatter"}}'   # ok:false bad_args
$S call POST /v1/cmd '{"id":"vs-3","op":"skill.list"}'          # [{name:"research", ...}]
$S call POST /v1/cmd '{"id":"vs-4","op":"skill.delete","args":{"name":"research"}}'
```

That the model's request carries the section but not the body, and that the tool result carries the body, is proven through the gate in `plugins/skills/skills.test.ts` (it needs a faux model).

## Gotchas

- Plugin-declared skills arrive through `skillsFrom()` once M8a wires the manifest `skills` field.

Evidence from the last wrangler dev drive: `.verify/evidence/M2-M8skills.txt`.
