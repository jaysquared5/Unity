#!/system/bin/sh
# Unity Tether — boot-persistent TTL/HL normalizer.
#
# Runs in Magisk's late_start service mode (after the system has booted).
# Keeps the mangle rules asserted in a light loop, because connectivity
# changes can flush netfilter rules out from under us.

MODDIR=${0%/*}
TTL=64
MARK=unitytether

apply_rules() {
  # IPv4 TTL
  iptables -t mangle -C POSTROUTING -m comment --comment "$MARK" -j TTL --ttl-set "$TTL" 2>/dev/null \
    || iptables -t mangle -A POSTROUTING -m comment --comment "$MARK" -j TTL --ttl-set "$TTL" 2>/dev/null
  # IPv6 Hop Limit (ignore if no IPv6 / no ip6tables)
  ip6tables -t mangle -C POSTROUTING -m comment --comment "$MARK" -j HL --hl-set "$TTL" 2>/dev/null \
    || ip6tables -t mangle -A POSTROUTING -m comment --comment "$MARK" -j HL --hl-set "$TTL" 2>/dev/null
}

# Wait for the network stack to be up, then maintain the rules forever.
until [ "$(getprop sys.boot_completed)" = "1" ]; do
  sleep 2
done

while true; do
  apply_rules
  sleep 30
done
