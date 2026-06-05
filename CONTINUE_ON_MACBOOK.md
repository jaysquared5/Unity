# Continue here — bring up Unity Tether on a rooted phone (MacBook session)

This is a self-contained runbook for a **fresh code session running on a
MacBook** that has USB access to a **rooted (Magisk) Android phone**. It assumes
no memory of the previous session.

## What this project is

**Unity Tether** is a PdaNet+/FoxFi replacement. It does *not* reimplement
tethering — Android already does USB/Wi-Fi/Bluetooth tethering. It adds the one
feature carriers charged for: **hiding tethered traffic** by rewriting outgoing
IPv4 **TTL** / IPv6 **Hop Limit** to 64, so a tethered laptop's packets look
like they came from the phone instead of arriving at TTL 63 (the tethering
tell). The rewrite is a kernel `iptables`/`ip6tables` mangle rule, which is why
root is required.

Read `README.md` and `DESIGN.md` for the full picture. Code lives in
`app/src/main/java/com/unity/tether/`. Branch: `claude/pdanet-replacement-mrCtj`.

## State as of this handoff

- ✅ App code written and **build-verified** (debug APK compiles).
- ✅ Phone is **rooted with Magisk**.
- ✅ Two hiding paths implemented: **root** (TTL/HL mangle) and **no-root**
  (SOCKS5 proxy).
- ⬜ App not yet installed on the phone.
- ⬜ Hiding not yet verified against a real tether session.

**Primary plan: the root path** (Steps 1–7 below) — it's more complete. The
no-root SOCKS5 proxy is a fallback if Step 1's kernel probe fails; see
"Alternative: no-root proxy" near the end.

## Important: transport on a Mac

macOS has **no native driver for Android USB tethering (RNDIS)**, so you cannot
share the phone's internet to the Mac over USB on modern/Apple-Silicon macOS.
USB still works for `adb`. For actually getting internet onto the Mac, use the
**Wi-Fi hotspot** transport (Settings → Hotspot & tethering → Wi-Fi hotspot).
The TTL/HL hiding is transport-agnostic and works the same either way.

---

## Step 0 — Verify the phone is connected and rooted

```sh
# Install platform-tools if `adb` is missing:
#   brew install --cask android-platform-tools

adb devices                      # should list one device as "device" (not "unauthorized")
adb shell getprop ro.product.model
adb shell su -c id               # MUST print uid=0(root). Approve the Magisk prompt on the phone.
```

If `adb shell su -c id` does not return `uid=0`, root isn't usable yet — open
the **Magisk** app on the phone, ensure Superuser is enabled, and re-run. Don't
proceed until this prints root.

## Step 1 — Confirm the kernel supports TTL/HL rewriting

This is the one hard requirement besides root. Probe it directly (adds a
throwaway rule and removes it):

```sh
adb shell su -c 'iptables -t mangle -A POSTROUTING -j TTL --ttl-set 64 \
  && iptables -t mangle -D POSTROUTING -j TTL --ttl-set 64 \
  && echo TTL_OK'
adb shell su -c 'ip6tables -t mangle -A POSTROUTING -j HL --hl-set 64 \
  && ip6tables -t mangle -D POSTROUTING -j HL --hl-set 64 \
  && echo HL_OK'
```

- Both print `TTL_OK` / `HL_OK` → you're good.
- `Couldn't load target 'TTL'` or `No chain/target/match by that name` → the
  kernel lacks `xt_TTL`/`xt_HL` (`CONFIG_NETFILTER_XT_TARGET_HL`). The app will
  report "Not supported." Options: a custom kernel that includes it, or fall
  back to the no-root `VpnService` path (roadmap in `DESIGN.md`). Stop here and
  tell the user if this fails.

## Step 2 — Build the debug APK

Requires JDK 17+ and the Android SDK (platform-34, build-tools-34).

### If Android Studio is installed
Open the project, let it sync, and Build → Build APK, **or** just run the
Gradle command below (Studio provides the SDK).

### Command-line SDK setup (if no SDK yet)

```sh
brew install openjdk@17        # if no JDK 17+

# Android SDK command-line tools:
export ANDROID_HOME="$HOME/android-sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
curl -L -o /tmp/cmdtools.zip \
  https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip
unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"
echo "sdk.dir=$ANDROID_HOME" > local.properties
```

### Build

```sh
export ANDROID_HOME="$HOME/android-sdk"   # or your Studio SDK path
./gradlew :app:assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```

> Note: `local.properties` is git-ignored and machine-specific — create it as
> above (or let Android Studio create it). Don't commit it.

## Step 3 — Install and launch

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.unity.tether -c android.intent.category.LAUNCHER 1
```

On the phone: tap **Start hiding** and **approve the Magisk root prompt** when it
appears. The status card should switch to **"Hiding active."**

(You can also drive it without the UI — see Step 5 for applying rules directly.)

## Step 4 — Turn on tethering

On the phone: **Settings → Network & internet → Hotspot & tethering → Wi-Fi
hotspot** (recommended on Mac). Connect the MacBook to that hotspot's SSID.

The app's status card should now list a tether interface (e.g. `ap0`, `wlan1`,
`swlan0`).

## Step 5 — Verify the hiding is actually applied

### a) Confirm the rules are installed and taking traffic

```sh
# Rules present (look for the "unitytether" comment):
adb shell su -c 'iptables  -t mangle -S POSTROUTING | grep unitytether'
adb shell su -c 'ip6tables -t mangle -S POSTROUTING | grep unitytether'

# Packet counters on our rule — generate traffic on the Mac, then re-run;
# the counters should climb, proving tethered traffic hits the rule:
adb shell su -c 'iptables -t mangle -L POSTROUTING -v -n | grep -i ttl'
```

### b) (Advanced, most convincing) Watch egress TTL on the phone

If a `tcpdump` binary is available on the phone (some Magisk modules provide one),
capture on the WAN radio interface. `tcpdump` sees packets *after* POSTROUTING
mangle, so tethered traffic should show **ttl 64**, not 63:

```sh
adb shell su -c 'ip route | grep default'         # find the WAN iface, e.g. rmnet_data0
adb shell su -c 'tcpdump -ni rmnet_data0 -v "tcp" | head -20'
# Generate traffic from the Mac; look at the "ttl" field in the output.
```

Without the hiding rule, forwarded packets would read `ttl 63`. With it, `ttl 64`.

### c) Manual apply/clear (debugging, bypasses the app)

```sh
# Apply:
adb shell su -c 'iptables  -t mangle -A POSTROUTING -m comment --comment unitytether -j TTL --ttl-set 64'
adb shell su -c 'ip6tables -t mangle -A POSTROUTING -m comment --comment unitytether -j HL  --hl-set 64'
# Clear:
adb shell su -c 'iptables  -t mangle -D POSTROUTING -m comment --comment unitytether -j TTL --ttl-set 64'
adb shell su -c 'ip6tables -t mangle -D POSTROUTING -m comment --comment unitytether -j HL  --hl-set 64'
```

## Step 6 — (Optional) Boot-persistent hiding via Magisk module

So hiding survives reboots without launching the app:

```sh
cd magisk-module && zip -r ../unitytether-magisk.zip . && cd ..
adb push unitytether-magisk.zip /sdcard/Download/
# On the phone: Magisk app → Modules → Install from storage → pick the zip → reboot.
```

## Step 7 — Real-world confirmation

The ultimate test: with hiding active and the Mac on the hotspot, use the Mac
normally and confirm the carrier no longer throttles/flags it (e.g. speed stays
full, no "tethering detected" notice). TTL=64 defeats the dominant detection
vector; if your carrier still flags it, they're likely using a secondary signal
(DPI, a separate tether APN) — see the roadmap in `DESIGN.md`.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `adb shell su -c id` ≠ uid=0 | Magisk Superuser off, or prompt was denied. Open Magisk, enable, retry. |
| App shows "Root required" | App's root request was denied — re-tap Start, approve the Magisk popup. |
| App shows "Not supported" | Kernel lacks `xt_TTL`/`xt_HL` (Step 1 failed). Need a kernel with `CONFIG_NETFILTER_XT_TARGET_HL`, or use the no-root path. |
| No tether interface listed | Tethering not actually on, or unusual iface name. Add the prefix to `TETHER_IFACE_PREFIXES` in `TtlManager.kt` (cosmetic only — rules are interface-wide and still work). |
| Rules vanish after a while | Expected on connectivity change; the foreground service re-asserts every 5s. Keep the app running, or install the Magisk module (Step 6). |
| Mac gets no internet over USB | Expected — macOS has no RNDIS driver. Use the Wi-Fi hotspot transport. |
| Gradle build fails on SDK | `ANDROID_HOME` unset or wrong; ensure platform-34 + build-tools-34 installed and `local.properties` has `sdk.dir`. |

## Alternative: no-root proxy (use if Step 1's kernel probe fails)

No root or no `xt_TTL`/`xt_HL`? Use the built-in SOCKS5 proxy instead — the phone
re-originates each connection, so traffic leaves at the normal TTL with no
mangling. Build/install the app the same way (Steps 2–3), then:

1. On the phone: turn on **Wi-Fi hotspot**; connect the MacBook to it.
2. In the app, scroll to **"No-root mode — SOCKS5 proxy"** → **Start proxy**.
   It shows the phone's hotspot IP and port (default `8282`).
3. On the Mac: **System Settings → Network → Wi-Fi → Details → Proxies →**
   enable **SOCKS Proxy**, server = that IP, port = `8282`.
4. Verify: the app's connection counter rises as you browse on the Mac.

Limitation: TCP only (no UDP yet), so some DNS/QUIC may still go direct. The
root path is more complete. (UDP ASSOCIATE is the top roadmap item.)

## Where to take it next (from `DESIGN.md` roadmap)

1. No-root `VpnService` fallback (userspace TTL rewrite) for non-rooted/unsupported kernels.
2. One-tap tether toggling from the app (root shell, experimental per OEM).
3. Built-in TTL verifier (probe an endpoint and report the externally-seen TTL).
4. Quick Settings tile, per-transport UI, optional DPI/UA mitigations.
