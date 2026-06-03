# bridge-heal

Self-healing + remote-recovery toolkit for the multi-session Claude bridge (the
"2nd Brain" setup). Built after a session wedged for 30+ minutes and the only
remote path in — a Cloudflare tunnel — died with it (**error 1033**), leaving no
way to recover without physically going to the host laptop.

## What broke, and the principle behind the fix

Two things failed together:

1. **The host slept.** Idle/lid sleep on a home laptop suspends *both* `cloudflared`
   (edge then returns **1033 — no connector**) *and* the `claude` session (frozen
   mid-"thinking"). Run `bin/diagnose.sh` to confirm from `pmset -g log`.
2. **The tunnel/controller were not independent of the sessions.** A *quick* tunnel
   (`cloudflared tunnel --url …`, random `trycloudflare.com` URL) started inline dies
   with its parent and hands out a fresh URL each restart — useless as a control plane.

> **The principle:** the thing that *heals* a session must be a **separate, supervised,
> always-on process** from the thing it heals — and the host must not sleep.

## Components

| File | Role |
|---|---|
| `bin/diagnose.sh` | Read-only post-mortem. Run on the Mac to find *why* it broke (sleep/wake, cloudflared launch mode, hung PID state, OOM). |
| `watchdog/watchdog.mjs` | Always-on control plane (port 8787). `/health`, `/sessions`, `/register`, `/kill/:id`, `/restart/:id`. Auto-restarts **dead** sessions; flags **wedged** ones (transcript stale while alive). Bearer-token auth. |
| `launchd/com.oni.bridge-watchdog.plist` | Runs the watchdog under launchd `KeepAlive` — it restarts itself if it crashes. |
| `launchd/com.oni.cloudflared.plist` | Runs a **named** tunnel as its own service → stable hostname, survives session death. |
| `bin/install.sh` | Disables system idle-sleep, installs + starts the watchdog, prints the token. |

## Deploy (on the Mac)

```bash
bash ops/bridge-heal/bin/install.sh          # sleep-proof + watchdog as a service
# then set up a NAMED tunnel -> http://127.0.0.1:8787 (see the cloudflared plist header)
```

## Use it remotely (from anywhere — phone, work Mac)

```bash
curl -s https://<host>/health                                            # is the host up?
curl -s -H "Authorization: Bearer $TOKEN" https://<host>/sessions        # what's wedged?
curl -s -X POST -H "Authorization: Bearer $TOKEN" https://<host>/restart/2nd-brain
```

## Make your bridge register sessions

So the watchdog can heal a session, the bridge tells it how to relaunch one when it
spawns it:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost:8787/register \
  -d '{"id":"2nd-brain","pid":'"$PID"',"jsonl":"/Users/oni/.claude/projects/.../<uuid>.jsonl","cwd":"/Users/oni","relaunch":"claude -p \"bootstrap...\" --bare"}'
```

Dead process → auto-relaunched. Wedged (transcript stale > `BRIDGE_STUCK_MINUTES`) →
flagged for you to `/restart` (or set `BRIDGE_AUTO_HEAL_STUCK=1` to auto-restart those too).
