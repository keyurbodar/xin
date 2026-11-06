# Xin feature map

One file per user-facing feature. Each is driven with `xin.sh` against `wrangler dev`, and with the gate where HTTP can't reach (eviction, alarms).

| Feature | File | Since |
| --- | --- | --- |
| Health check | [health.md](health.md) | M0 |
| Owner auth | [auth.md](auth.md) | M0 |
| Host loop status and recovery | [host-loop.md](host-loop.md) | M0 |
| Commands and receipts | [commands.md](commands.md) | M1 |
| Wire protocol (socket) | [socket.md](socket.md) | M1 |
| Plugin host | [plugins.md](plugins.md) | M1 |
| Skills | [skills.md](skills.md) | M8 |
| Intake and dispatch | [intake.md](intake.md) | M2 |
| Models and credentials | [models.md](models.md) | M3 |
