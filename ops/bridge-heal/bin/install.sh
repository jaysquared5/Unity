#!/usr/bin/env bash
# install.sh — deploy the bridge-heal toolkit on the Mac host (user `oni`).
# Idempotent-ish; safe to re-run. Run from the repo root ON THE MAC:
#   bash ops/bridge-heal/bin/install.sh
set -euo pipefail

DEST="${BRIDGE_HOME:-$HOME/bridge-heal}"
LA="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node || true)"

[ -n "$NODE_BIN" ] || { echo "node not found on PATH; install Node (brew install node) first."; exit 1; }

echo "==> copying watchdog to $DEST"
mkdir -p "$DEST/watchdog" "$HOME/.bridge-heal/logs" "$LA"
cp "$(dirname "$0")/../watchdog/watchdog.mjs" "$DEST/watchdog/watchdog.mjs"

# 1) sleep-proof the host: a wedged session is bad, a SLEEPING host is worse —
#    it suspends both cloudflared (1033) and every session. Keep the system awake
#    (display may still sleep). This is the single biggest fix for a home laptop.
echo "==> disabling system idle sleep on AC (sudo)"
sudo pmset -c sleep 0 disksleep 0 || echo "  (skip: pmset needs sudo; run 'sudo pmset -c sleep 0' manually)"

# 2) watchdog launch agent
TOKEN="${BRIDGE_TOKEN:-$(openssl rand -hex 24)}"
PLIST="$LA/com.oni.bridge-watchdog.plist"
echo "==> writing $PLIST"
sed -e "s#/opt/homebrew/bin/node#$NODE_BIN#g" \
    -e "s#/Users/oni#$HOME#g" \
    -e "s#CHANGE-ME-to-a-long-random-secret#$TOKEN#g" \
    "$(dirname "$0")/../launchd/com.oni.bridge-watchdog.plist" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo
echo "==> watchdog installed. token saved below — keep it secret:"
echo "    BRIDGE_TOKEN=$TOKEN"
echo "    test locally:  curl -s localhost:8787/health"
echo
echo "Next: point a NAMED cloudflared tunnel at http://127.0.0.1:8787 and run it as a"
echo "service (see ops/bridge-heal/launchd/com.oni.cloudflared.plist). Then from anywhere:"
echo "    curl -s https://<your-host>/health"
echo "    curl -s -H \"Authorization: Bearer \$BRIDGE_TOKEN\" https://<your-host>/sessions"
