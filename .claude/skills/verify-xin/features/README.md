# Xin feature map

One file per user-facing feature. Each is driven with `xin.sh` against `wrangler dev`, and with the gate where HTTP can't reach (eviction, alarms).

| Feature | File | Since |
| --- | --- | --- |
| Health check | [health.md](health.md) | M0 |
| Owner auth | [auth.md](auth.md) | M0 |
| Host loop status and recovery | [host-loop.md](host-loop.md) | M0 |
