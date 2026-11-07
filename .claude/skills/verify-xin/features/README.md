# Xin feature map

One file per user-facing feature. Each is driven with `xin.sh` against `wrangler dev`, and with the gate where HTTP can't reach (eviction, alarms).

| Feature | File | Since |
| --- | --- | --- |
| Health check | [health.md](health.md) | M0 |
| Owner auth | [auth.md](auth.md) | M0 |
| Host loop status and recovery | [host-loop.md](host-loop.md) | M0 |
| Commands and receipts | [commands.md](commands.md) | M1 |
| Wire protocol (socket) | [socket.md](socket.md) | M1 |
| Plugins (everything is a row) | [plugins.md](plugins.md) | M1, P1 |
| Skills | [skills.md](skills.md) | M8 |
| Intake and dispatch | [intake.md](intake.md) | M2 |
| Models and credentials | [models.md](models.md) | M3 |
| Files and uploads | [files.md](files.md) | M4 |
| Memory and Dreamer | [memory.md](memory.md) | M7 |
| Web push | [push.md](push.md) | M9 |
| MCP servers | [mcp.md](mcp.md) | M8 |
| Market and runtime bundles | [market.md](market.md) | P6, P7, P8 |
| Schedules | [schedules.md](schedules.md) | M8, P12 |
| Goals, compaction and the loop guard | [goals.md](goals.md) | P11, P13 |
| Projects and threads | [threads.md](threads.md) | M5 |
| Jobs, questions, watchdog | [jobs-questions.md](jobs-questions.md) | M6 |
