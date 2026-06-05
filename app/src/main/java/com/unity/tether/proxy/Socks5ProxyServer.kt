package com.unity.tether.proxy

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * A minimal, no-root **SOCKS5 proxy** (RFC 1928) — the no-root path to carrier
 * hiding.
 *
 * ## Why a proxy instead of a VpnService
 * Android's `VpnService` only captures traffic from apps running *on the phone*.
 * It does **not** capture the forwarded traffic from a tethered laptop, so a
 * VpnService-based TTL rewrite can't touch the packets we actually care about.
 *
 * A proxy sidesteps the whole problem: the tethered device sends its traffic to
 * this server, and the phone opens a **brand-new** outbound connection to each
 * destination. Because the phone is the genuine origin of those connections,
 * their packets leave the radio with the phone's normal TTL/Hop-Limit (64) — no
 * kernel mangling and no root required. DNS for SOCKS5-aware clients is resolved
 * here on the phone too, so it doesn't leak at TTL 63 either.
 *
 * Scope: CONNECT (TCP) only — covers essentially all web/streaming traffic.
 * BIND and UDP ASSOCIATE are intentionally unsupported (rare for this use case).
 */
class Socks5ProxyServer(
    private val port: Int = DEFAULT_PORT,
    /** Called with the current active-connection count whenever it changes. */
    private val onConnectionCount: (Int) -> Unit = {},
) {
    private var serverSocket: ServerSocket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = AtomicInteger(0)

    /** Bind to all interfaces so hotspot clients can reach us, and start accepting. */
    fun start() {
        val ss = ServerSocket()
        ss.reuseAddress = true
        ss.bind(InetSocketAddress("0.0.0.0", port))
        serverSocket = ss

        scope.launch {
            while (isActive) {
                val client = try {
                    ss.accept()
                } catch (_: IOException) {
                    break // socket closed by stop()
                }
                scope.launch { handleClient(client) }
            }
        }
    }

    fun stop() {
        runCatching { serverSocket?.close() }
        scope.cancel()
    }

    private fun handleClient(client: Socket) {
        onConnectionCount(active.incrementAndGet())
        var remote: Socket? = null
        try {
            client.tcpNoDelay = true
            val din = DataInputStream(client.getInputStream())
            val out = client.getOutputStream()

            if (!negotiate(din, out)) return

            val req = readRequest(din)
            if (req.cmd != CMD_CONNECT) {
                reply(out, REP_CMD_NOT_SUPPORTED); return
            }

            remote = try {
                Socket().apply {
                    tcpNoDelay = true
                    // Domain names resolve here, on the phone (no DNS leak).
                    connect(InetSocketAddress(req.host, req.port), CONNECT_TIMEOUT_MS)
                }
            } catch (_: IOException) {
                reply(out, REP_HOST_UNREACHABLE); return
            }

            reply(out, REP_SUCCESS)

            // Pump both directions. Closing the sockets in `finally` unblocks
            // whichever read is still parked, so both halves tear down cleanly.
            val r = remote
            scope.launch { pump(din, r.getOutputStream()) }
            pump(r.getInputStream(), out)
        } catch (_: IOException) {
            // client hung up mid-handshake; nothing to do
        } finally {
            runCatching { remote?.close() }
            runCatching { client.close() }
            onConnectionCount(active.decrementAndGet())
        }
    }

    // --- SOCKS5 protocol ----------------------------------------------------------

    /** Method-selection handshake. We only offer "no authentication". */
    private fun negotiate(din: DataInputStream, out: OutputStream): Boolean {
        if (din.readUnsignedByte() != SOCKS_VERSION) return false
        val nMethods = din.readUnsignedByte()
        din.skipFully(nMethods)
        out.write(byteArrayOf(SOCKS_VERSION.toByte(), METHOD_NO_AUTH.toByte()))
        out.flush()
        return true
    }

    private data class Request(val cmd: Int, val host: String, val port: Int)

    private fun readRequest(din: DataInputStream): Request {
        if (din.readUnsignedByte() != SOCKS_VERSION) throw IOException("bad version")
        val cmd = din.readUnsignedByte()
        din.readUnsignedByte() // RSV
        val host = when (val atyp = din.readUnsignedByte()) {
            ATYP_IPV4 -> readAddr(din, 4)
            ATYP_IPV6 -> readAddr(din, 16)
            ATYP_DOMAIN -> {
                val len = din.readUnsignedByte()
                val bytes = ByteArray(len)
                din.readFully(bytes)
                String(bytes, Charsets.US_ASCII)
            }
            else -> throw IOException("unsupported address type $atyp")
        }
        val port = din.readUnsignedShort()
        return Request(cmd, host, port)
    }

    private fun readAddr(din: DataInputStream, n: Int): String {
        val bytes = ByteArray(n)
        din.readFully(bytes)
        return InetAddress.getByAddress(bytes).hostAddress ?: throw IOException("bad addr")
    }

    /** Reply with the given code and a zeroed IPv4 BND.ADDR/PORT (clients ignore it). */
    private fun reply(out: OutputStream, rep: Int) {
        out.write(
            byteArrayOf(
                SOCKS_VERSION.toByte(), rep.toByte(), 0x00, ATYP_IPV4.toByte(),
                0, 0, 0, 0, // 0.0.0.0
                0, 0, // port 0
            ),
        )
        out.flush()
    }

    private fun pump(from: InputStream, to: OutputStream) {
        val buf = ByteArray(BUFFER_SIZE)
        try {
            while (true) {
                val n = from.read(buf)
                if (n < 0) break
                to.write(buf, 0, n)
                to.flush()
            }
        } catch (_: IOException) {
            // peer closed; the finally block in handleClient cleans up
        }
    }

    private fun DataInputStream.skipFully(n: Int) {
        var remaining = n
        while (remaining > 0) {
            val skipped = skip(remaining.toLong())
            if (skipped <= 0) {
                if (read() < 0) throw IOException("unexpected EOF")
                remaining--
            } else {
                remaining -= skipped.toInt()
            }
        }
    }

    companion object {
        const val DEFAULT_PORT = 8282

        private const val SOCKS_VERSION = 0x05
        private const val METHOD_NO_AUTH = 0x00
        private const val CMD_CONNECT = 0x01
        private const val ATYP_IPV4 = 0x01
        private const val ATYP_DOMAIN = 0x03
        private const val ATYP_IPV6 = 0x04
        private const val REP_SUCCESS = 0x00
        private const val REP_HOST_UNREACHABLE = 0x04
        private const val REP_CMD_NOT_SUPPORTED = 0x07

        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val BUFFER_SIZE = 16 * 1024

        /**
         * Best-effort guess of the Wi-Fi hotspot gateway IP to show the user —
         * the address their laptop should point its SOCKS proxy at. Looks for a
         * site-local IPv4 on a tether-like interface. No permissions required.
         */
        fun hotspotAddress(): String? {
            val prefixes = listOf("ap", "wlan", "swlan", "softap", "rndis", "usb")
            return runCatching {
                NetworkInterface.getNetworkInterfaces().toList()
                    .filter { iface -> prefixes.any { iface.name.startsWith(it) } }
                    .flatMap { it.inetAddresses.toList() }
                    .firstOrNull { it.isSiteLocalAddress && it.address.size == 4 }
                    ?.hostAddress
            }.getOrNull()
        }
    }
}
