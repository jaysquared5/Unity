# Design & Architecture

## Goal

Recreate the genuinely-useful part of PdaNet+/FoxFi — **carrier tether
detection bypass** — as a small, auditable, open app, while leaning on
Android's built-in tethering for the data plane.

## Why not reimplement tethering?

PdaNet historically shipped its own USB/Wi-Fi data path because older Android
versions either lacked tethering or let carriers disable it. On a modern rooted
phone that's no longer necessary:

- USB / Wi-Fi hotspot / Bluetooth PAN tethering are all built in and reliable.
- The only thing the carrier can still do is *detect* tethering (mainly via
  TTL/HL, sometimes via clearer signals like DPI of OS-update User-Agents or
  the separate `dun` APN) and throttle/charge accordingly.

So Unity Tether's job is narrow and well-defined: **make tethered packets
indistinguishable from phone-originated packets.**

## Detection vectors & what we handle

| Vector | How carriers use it | Our handling |
| --- | --- | --- |
| **TTL / Hop Limit** | Forwarded packets arrive at TTL 63 instead of 64 | ✅ Rewrite to 64 in `mangle/POSTROUTING` (v0.1) |
| Separate tether/`dun` APN | Some carriers route hotspot via a metered APN | Out of scope (don't enable that APN) |
| DPI / SNI / User-Agent | Desktop OS update servers, browser UAs | Roadmap: optional proxy/UA rewrite |
| Clear-text MTU / fingerprint | Less common | Not handled |

TTL is by far the dominant, real-world vector, which is why v0.1 nails it first.

## Components (v0.1)

```
MainActivity ──> TetherScreen (Compose UI) ──> TetherViewModel
                                                     │ start/stop
                                                     ▼
                                              TetherService (foreground)
                                                     │ watchdog loop (5s)
                                                     ▼
                                              TtlManager ──> RootShell ──> su
                                                     │
                                              HidingStateHolder (StateFlow) ──> UI
```

- **`RootShell`** — the single choke point for privileged commands. Everything
  run as root goes through here, so it's the one file to audit. No `libsu`
  dependency on purpose.
- **`TtlManager`** — builds/applies/removes the iptables/ip6tables rules,
  probes kernel support (`checkSupport`), and detects active tether interfaces
  for display. Rules are tagged with a `--comment unitytether` marker so we
  add/remove exactly our own and stay idempotent.
- **`TetherService`** — `LifecycleService` foreground service. Applies rules,
  re-asserts them on a 5s watchdog (connectivity changes flush netfilter),
  publishes status, and exposes a Stop action in its notification.
- **`HidingStateHolder`** — process-wide `StateFlow<HidingState>`; single source
  of truth shared by service and UI.
- **`magisk-module/`** — optional boot-persistent version of the same rules for
  users who want always-on hiding without the app.

## Key decisions

- **Global `POSTROUTING` set-ttl vs. per-interface match.** We normalize *all*
  egress rather than matching only the tether subnet/interface. It's simpler and
  more robust across OEM interface naming (`rndis0`/`ap0`/`swlan0`/`bt-pan`/…),
  and it's a harmless no-op for the phone's own already-64 packets. Per-interface
  targeting can be added later if a user wants to scope it.
- **Lean on built-in tethering.** Avoids fragile, OEM-specific programmatic
  tether toggling and keeps the app's responsibility crisp.
- **Graceful degradation.** No root → clear "Root required" state. Root but no
  `xt_HL` → clear "Not supported" with the kernel reason, instead of silently
  failing.

## No-root path (implemented): SOCKS5 proxy

A `VpnService` TTL rewrite **does not work for tethering**: Android's
`VpnService` only captures traffic from apps on the phone, not the forwarded
traffic from a tethered laptop — exactly the packets we need to fix. So the
no-root path is instead a **local SOCKS5 proxy** (`proxy/Socks5ProxyServer.kt`,
hosted by `service/ProxyService.kt`):

- The laptop joins the phone's Wi-Fi hotspot and points its SOCKS proxy at the
  phone.
- For each connection, the phone opens a **fresh** outbound socket to the
  destination. Because the phone is the genuine origin, packets leave at its
  normal TTL/HL (64) — no mangling, no root.
- Domain names resolve on the phone, so DNS doesn't leak at TTL 63 for
  SOCKS5-aware clients either.

Trade-offs vs. the root path: covers **TCP** (CONNECT) only — no UDP associate —
and a few apps that bypass the system SOCKS setting may still send some traffic
(e.g. DNS) directly. The root TTL rewrite is more complete; the proxy needs no
root. This is the same approach no-root competitors (NetShare) use.

## Roadmap

1. **UDP support in the proxy** (SOCKS5 UDP ASSOCIATE) to close the DNS/QUIC gap.
2. **One-tap tether toggling (root)** — best-effort enabling of USB/Wi-Fi/BT
   tethering via shell (`svc usb setFunctions rndis`, `cmd`/`service` calls),
   labeled experimental due to OEM variance.
3. **Built-in TTL verification** — run a quick check (e.g. an outbound probe to
   a known echo endpoint) and report the TTL the carrier actually sees.
4. **Per-transport UI** — show/scope hiding by USB vs Wi-Fi vs Bluetooth.
5. **Optional DPI mitigations** — UA/SNI normalization proxy for carriers that
   go beyond TTL.
6. **Quick Settings tile** for start/stop without opening the app.

## Testing notes

The hiding logic is shell-command driven, which makes it hard to unit-test in
isolation but trivial to verify on-device (`iptables -t mangle -S`). A future
refactor could inject a `ShellRunner` interface into `TtlManager` to allow
asserting the exact command strings in JVM tests.
