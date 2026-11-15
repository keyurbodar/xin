# Projects and threads

A project has one coordinator conversation and a list of threads. The coordinator delegates work with `delegate_task`. Each thread is a task-owned child conversation, and its Reporter writes one report (`report:<threadId>:<run>`) back into the coordinator's intake. Thread status is `working`, `waiting`, `completed`, `failed` or `cancelled`.

## Sub-features

- Owner ops: `project.create` (`slug`, `name`, `goal?`), `project.update`, `project.archive`, `thread.rename`, `workspace.read`, `thread.send`, `thread.stop`, `message.retry`.
- Coordinator tools: `capabilities`, `delegate_task`, `task_status`, `task_cancel`, `thread_send`, `thread_read`, `thread_list`. Threads get a narrower set and can't create grandchildren.
- Thread model: delegate `target.model`, then project thread default, then owner thread default, then the coordinator's model.
- A run that fails (for example with no model chosen) commits an `xin.error` entry. `message.retry` resubmits the last batch.
- The home stream (`sub home`) shows projects with threads grouped by status, pushed on every thread change.

## How to get to it (user POV)

The owner creates a project, picks a model, and chats with its coordinator. The Overview lists threads and their results.

## Driving it with xin.sh

```bash
S=.claude/skills/verify-xin/xin.sh
KEY=$(grep -o '^OPENCODE_API_KEY=.*' .dev.vars | cut -d= -f2-)      # local only, never echo it
$S call POST /v1/cmd "{\"id\":\"c\",\"op\":\"credential.set\",\"args\":{\"provider\":\"opencode-go\",\"key\":\"$KEY\"}}" >/dev/null
$S call POST /v1/cmd '{"id":"p","op":"project.create","args":{"slug":"live","name":"Live"}}'   # → coordinatorId
$S call POST /v1/cmd '{"id":"m1","op":"conv.configure","args":{"conv":3,"model":{"provider":"opencode-go","modelId":"iceman-contributor-free"}}}'
$S call POST /v1/cmd '{"id":"s","op":"message.send","args":{"conv":3,"text":"Call delegate_task once with mode async, title haiku, task: write a haiku about rain."}}'
$S call POST /v1/cmd '{"id":"m2","op":"conv.configure","args":{"conv":3,"model":{"provider":"opencode-go","modelId":"beam-free"}}}'   # mid-run switch
sleep 50
$S call POST /v1/cmd '{"id":"r","op":"workspace.read","args":{}}'      # thread completed with result text
$S ws '{"t":"sub","stream":"conv:3"}'                                     # delegate_task on model 1, report batch, reply on model 2
```

Proof: `workspace.read` shows the thread `completed` with the reply text as `result`, and the coordinator's entries show a report `xin.batch` followed by an assistant message from the switched model. Evidence: `.verify/evidence/M5-live.txt`.

## Gotchas

- Without a model the batch is followed by `xin.error` ("pick a model").
- `xin.sh stop` wipes state, so read the thread conversation (`sub conv:<threadId>`) before stopping.
- Faux replies have no thinking parts. Real models do, so keep the live check in the loop for report text.
