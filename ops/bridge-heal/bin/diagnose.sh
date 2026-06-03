#!/usr/bin/env bash
# diagnose.sh — post-mortem for the "2nd Brain" tunnel/session hang (Cloudflare 1033).
# Run this ON THE MAC that hosts the bridge (the home laptop, user `oni`).
# It only READS state — it kills nothing. Output is written to a file you can paste back.
#
#   bash ops/bridge-heal/bin/diagnose.sh
#
set -uo pipefail

OUT="${TMPDIR:-/tmp}/bridge-diagnose-$(date +%Y%m%d-%H%M%S).txt"
HUNG_PID="${1:-21837}"   # the PID from the handoff; override by passing one as $1

section() { printf '\n========== %s ==========\n' "$1" | tee -a "$OUT"; }
run()     { printf '\n$ %s\n' "$*" | tee -a "$OUT"; "$@" 2>&1 | tee -a "$OUT"; }

{
  printf 'bridge-heal diagnose — %s\nhost: %s  user: %s\n' "$(date)" "$(hostname)" "$(whoami)"
} | tee "$OUT"

section "1. SLEEP / WAKE  (did the laptop suspend and kill tunnel + session?)"
# Lines like 'Entering Sleep' / 'Wake from' around the hang window are the smoking gun.
run bash -c "pmset -g log | grep -iE 'Sleep|Wake|DarkWake' | tail -40"
section "1b. Current sleep settings (are sleep/displaysleep disabled while bridging?)"
run bash -c "pmset -g | grep -iE 'sleep|hibernatemode|disksleep|standby|powernap'"
run bash -c "pmset -g assertions | grep -iE 'PreventUserIdleSystemSleep|PreventSystemSleep|caffeinate' || echo '(no sleep-prevention assertions held — laptop is free to sleep)'"

section "2. CLOUDFLARED  (is the connector alive? how was it launched?)"
run bash -c "pgrep -fl cloudflared || echo '(cloudflared NOT running — explains 1033)'"
run bash -c "ls -la ~/.cloudflared 2>/dev/null || echo '(no ~/.cloudflared dir)'"
run bash -c "cat ~/.cloudflared/config.yml 2>/dev/null || echo '(no config.yml — likely a *quick* tunnel: ephemeral URL, dies with parent)'"
run bash -c "launchctl list 2>/dev/null | grep -i cloudflare || echo '(cloudflared is NOT a launchd service — it was run inline, so it dies with its terminal/session)'"
run bash -c "log show --predicate 'process == \"cloudflared\"' --last 8h --style compact 2>/dev/null | tail -120 || echo '(no unified-log entries; quick tunnels log to the terminal only)'"

section "3. THE HUNG SESSION  (is PID $HUNG_PID still around? what state?)"
# STAT: 'U' = uninterruptible wait, 'T' = stopped/suspended (sleep), 'R' = spinning.
run bash -c "ps -p $HUNG_PID -o pid,ppid,stat,etime,%cpu,%mem,wq,command 2>/dev/null || echo '(PID $HUNG_PID no longer exists)'"
run bash -c "ps -axo pid,ppid,stat,etime,%cpu,%mem,command | grep -iE 'claude| -p ' | grep -v grep || echo '(no claude processes)'"

section "4. THE CONTROLLER / BRIDGE  (what serves the HTML controller, on which port?)"
run bash -c "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'node|python|cloudflared|caddy|nginx|ruby' || echo '(nothing obvious listening)'"

section "5. RESOURCE PRESSURE  (did it get OOM-killed / jetsam'd?)"
run bash -c "log show --predicate 'eventMessage CONTAINS[c] \"jetsam\" OR eventMessage CONTAINS[c] \"lowswap\" OR eventMessage CONTAINS[c] \"memory pressure\"' --last 8h --style compact 2>/dev/null | tail -40 || echo '(none found)'"
run bash -c "vm_stat | head -8"

section "DONE"
echo "Full report: $OUT"
echo "Paste sections 1–3 back, or upload the file."
