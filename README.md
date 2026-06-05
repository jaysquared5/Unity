# Unity Tether

A self-hosted replacement for **PdaNet+ / FoxFi**, focused on the one feature
that actually mattered: **hiding tethered traffic from your carrier** so your
laptop's data looks like it came from your phone.

It does *not* reinvent tethering. Android already does USB / Wi-Fi hotspot /
Bluetooth tethering perfectly well — the part carriers charged extra for (or
throttled) was never the tethering itself, it was getting caught. Unity Tether
adds the "don't get caught" layer on top of Android's built-in tethering.

> ⚠️ **Use responsibly.** This normalizes packet TTL/Hop-Limit on your own
> device and your own data. Whether that's permitted is between you and your
> carrier's terms of service. This project is for personal use on hardware and
> service you own/pay for. Don't use it to defraud anyone.

---

## How it works

Carriers detect tethering primarily by inspecting the IP **TTL** (IPv4
Time-To-Live) or **Hop Limit** (IPv6) of your packets:

- A packet that originates on the phone leaves with the OS default: **64**.
- A packet forwarded from a tethered laptop has been through one extra hop, so
  it leaves the phone with **63** — a dead giveaway.

Unity Tether installs two netfilter `mangle` rules that rewrite the TTL/HL of
*every* outgoing packet back to 64, making tethered and native traffic
indistinguishable:

```
iptables  -t mangle -A POSTROUTING -m comment --comment unitytether -j TTL --ttl-set 64
ip6tables -t mangle -A POSTROUTING -m comment --comment unitytether -j HL  --hl-set 64
```

A foreground service re-asserts these rules every few seconds, because
connectivity changes (radio drops, toggling tethering) can flush them.

### Requirements

- **Root** (Magisk, etc.). The TTL/HL rewrite happens in the kernel firewall,
  which is privileged. The app degrades gracefully and tells you if root isn't
  granted.
- A kernel with the `xt_HL` / `xt_TTL` netfilter target
  (`CONFIG_NETFILTER_XT_TARGET_HL`). Most stock Android kernels have it; the app
  probes for it and reports clearly if yours doesn't.
- Android 8.0 (API 26) or newer.

**No root? There's a fallback.** A built-in **SOCKS5 proxy** mode (no root, no
special kernel) achieves the same hiding a different way: the laptop sends its
traffic to a proxy on the phone, and the phone re-originates each connection so
packets leave at the normal TTL. Turn on the Wi-Fi hotspot, tap **Start proxy**,
and point the MacBook's SOCKS proxy at the phone. See [DESIGN.md](DESIGN.md) for
how it works and its trade-offs (TCP only; the root path is more complete).

---

## Using it

1. Install the app (build it — see below) and grant root when prompted.
2. Tap **Start hiding**.
3. Turn on tethering the normal way:
   *Settings → Network & internet → Hotspot & tethering →* USB / Wi-Fi hotspot /
   Bluetooth tethering.
4. Connect your laptop. Its traffic now leaves the phone with TTL 64.

The app shows which tether interface(s) it detects (`rndis0`, `ap0`, `bt-pan`,
etc.) and keeps the rules applied in the background.

### Verifying it's working

From a tethered laptop, send a packet and have someone/something upstream check
the arriving TTL, or check on the phone:

```sh
# On the phone (root shell) — confirm the rules are present:
iptables  -t mangle -S POSTROUTING | grep unitytether
ip6tables -t mangle -S POSTROUTING | grep unitytether
```

---

## Boot-persistent mode (optional Magisk module)

If you want hiding always-on without launching the app, flash the Magisk module
in [`magisk-module/`](magisk-module/):

```sh
cd magisk-module && zip -r ../unitytether-magisk.zip . && cd ..
# Flash unitytether-magisk.zip in the Magisk app → Modules → Install from storage
```

It applies the same rules at boot and maintains them in a light loop.

---

## Building

You need the Android SDK (platform 34, build-tools 34) and JDK 17+.

```sh
./gradlew :app:assembleDebug      # debug APK → app/build/outputs/apk/debug/
./gradlew :app:assembleRelease    # release (configure signing first)
```

The Gradle wrapper is committed, so a fresh checkout + Android Studio (or the
command line above) is all you need. `local.properties` with `sdk.dir=...` is
created automatically by Android Studio, or set `ANDROID_HOME`.

---

## Status

**v0.1** — the carrier-hiding core, working and build-verified. See
[DESIGN.md](DESIGN.md) for architecture and the roadmap (no-root VpnService
fallback, one-tap tether toggling, per-transport controls, TTL verification).
