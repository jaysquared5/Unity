package com.unity.tether.net

import com.unity.tether.root.RootShell

/**
 * Applies and removes the "carrier hiding" layer.
 *
 * ## Why this works
 * Carriers commonly detect tethering by inspecting the IP **TTL** (IPv4
 * Time-To-Live) / **Hop Limit** (IPv6) of packets leaving your phone. Each hop
 * through a router decrements that field by one. A packet that originates on
 * the phone itself leaves with the OS default (64 on Android/Linux). A packet
 * that came from a tethered laptop is *forwarded* by the phone, so it leaves
 * with 63 — a tell-tale sign of tethering.
 *
 * We normalize every outgoing packet's TTL/HL back to a fixed value (default
 * 64) using the kernel's netfilter `TTL` / `HL` mangle targets, so tethered
 * traffic becomes indistinguishable from the phone's own traffic. Applying it
 * in `POSTROUTING` catches forwarded (tethered) packets just before they hit
 * the radio; it's a harmless no-op for the phone's own already-64 packets.
 *
 * This requires root and a kernel built with `CONFIG_NETFILTER_XT_TARGET_HL`
 * (the `xt_HL` module). Most stock Android kernels include it; [checkSupport]
 * verifies before we promise the user anything.
 */
object TtlManager {

    /** Marker comment so we can find and remove exactly our own rules. */
    private const val MARK = "unitytether"

    /** Default value matches the Android/Linux egress default. */
    const val DEFAULT_TTL = 64

    /**
     * Interface name prefixes Android uses for the various tether transports.
     * Used only for status display — the rules themselves are interface-wide.
     */
    private val TETHER_IFACE_PREFIXES = listOf(
        "rndis", "usb", "ncm",       // USB tethering
        "ap", "wlan1", "swlan",      // Wi-Fi hotspot (varies by OEM)
        "bt-pan",                    // Bluetooth PAN
    )

    sealed interface SupportResult {
        data object Supported : SupportResult
        data class Unsupported(val reason: String) : SupportResult
        data object NoRoot : SupportResult
    }

    /** Verify root + that the kernel exposes the TTL/HL mangle targets. */
    suspend fun checkSupport(): SupportResult {
        if (!RootShell.isRootAvailable()) return SupportResult.NoRoot

        // A dry-run insert+delete of a throwaway rule tells us whether the
        // kernel target exists without leaving anything behind.
        val probe = RootShell.exec(
            "iptables -t mangle -A POSTROUTING -j TTL --ttl-set $DEFAULT_TTL 2>&1 && " +
                "iptables -t mangle -D POSTROUTING -j TTL --ttl-set $DEFAULT_TTL 2>&1",
        )
        if (!probe.isSuccess) {
            val msg = (probe.stdout + probe.stderr)
            return SupportResult.Unsupported(
                when {
                    msg.contains("Couldn't load target") ||
                        msg.contains("No chain/target/match") ->
                        "Kernel is missing the xt_TTL/xt_HL netfilter target."
                    else -> msg.ifBlank { "Unknown iptables error." }
                },
            )
        }
        return SupportResult.Supported
    }

    /** True if our hiding rules are currently installed. */
    suspend fun isActive(): Boolean {
        val v4 = RootShell.exec(checkCmd("iptables", ttlTarget(DEFAULT_TTL)))
        return v4.isSuccess
    }

    /**
     * Install the hiding rules (idempotent — checks before adding) for both
     * IPv4 and IPv6. [ttl] defaults to 64.
     */
    suspend fun apply(ttl: Int = DEFAULT_TTL): RootShell.Result {
        return RootShell.exec(
            // IPv4 TTL
            "${checkCmd("iptables", ttlTarget(ttl))} || ${addCmd("iptables", ttlTarget(ttl))}",
            // IPv6 Hop Limit (best-effort; ignore failure if device has no IPv6)
            "${checkCmd("ip6tables", hlTarget(ttl))} || ${addCmd("ip6tables", hlTarget(ttl))} || true",
        )
    }

    /** Remove our rules (idempotent). */
    suspend fun clear(ttl: Int = DEFAULT_TTL): RootShell.Result {
        return RootShell.exec(
            "${delCmd("iptables", ttlTarget(ttl))} || true",
            "${delCmd("ip6tables", hlTarget(ttl))} || true",
        )
    }

    /** Names of currently-up interfaces that look like tether interfaces. */
    suspend fun activeTetherInterfaces(): List<String> {
        val r = RootShell.exec("ip -o link show up 2>/dev/null | awk -F': ' '{print \$2}'")
        if (!r.isSuccess) return emptyList()
        return r.stdout.lineSequence()
            .map { it.substringBefore('@').trim() }
            .filter { name -> TETHER_IFACE_PREFIXES.any { name.startsWith(it) } }
            .toList()
    }

    // --- iptables command builders -------------------------------------------------

    private fun ttlTarget(ttl: Int) =
        "POSTROUTING -m comment --comment $MARK -j TTL --ttl-set $ttl"

    private fun hlTarget(ttl: Int) =
        "POSTROUTING -m comment --comment $MARK -j HL --hl-set $ttl"

    private fun checkCmd(bin: String, rule: String) = "$bin -t mangle -C $rule 2>/dev/null"
    private fun addCmd(bin: String, rule: String) = "$bin -t mangle -A $rule"
    private fun delCmd(bin: String, rule: String) = "$bin -t mangle -D $rule 2>/dev/null"
}
