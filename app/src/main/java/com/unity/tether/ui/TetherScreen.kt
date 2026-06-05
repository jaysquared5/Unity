package com.unity.tether.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.unity.tether.HidingStatus

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun TetherScreen(vm: TetherViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val proxyState by vm.proxyState.collectAsStateWithLifecycle()

    Scaffold(
        topBar = { TopAppBar(title = { Text("Unity Tether") }) },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "Root mode — TTL/HL hiding",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            StatusCard(state.status, state.detail, state.tetherInterfaces, state.ttl)

            val active = state.status == HidingStatus.ACTIVE
            if (active) {
                Button(
                    onClick = { vm.stop() },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Stop hiding") }
            } else {
                Button(
                    onClick = { vm.start() },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Start hiding") }
            }

            HowToCard()

            HorizontalDivider(Modifier.padding(vertical = 4.dp))

            Text(
                "No-root mode — SOCKS5 proxy",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            ProxyCard(proxyState)
            if (proxyState.running) {
                Button(
                    onClick = { vm.stopProxy() },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Stop proxy") }
            } else {
                Button(
                    onClick = { vm.startProxy() },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Start proxy") }
            }
        }
    }
}

@Composable
private fun ProxyCard(proxy: com.unity.tether.ProxyState) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (proxy.running) Icons.Filled.Shield else Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = if (proxy.running) Color(0xFF2E7D32) else MaterialTheme.colorScheme.outline,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    if (proxy.running) "Proxy running" else "Proxy stopped",
                    style = MaterialTheme.typography.titleLarge,
                )
            }

            if (proxy.running) {
                val host = proxy.address ?: "your phone's hotspot gateway IP"
                Text(
                    "On the MacBook (connected to this phone's Wi-Fi hotspot):\n" +
                        "System Settings → Network → Wi-Fi → Details → Proxies →\n" +
                        "enable “SOCKS Proxy”, server = $host, port = ${proxy.port}.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "Active connections: ${proxy.activeConnections}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "No root needed — the phone re-originates each connection, so traffic leaves at the normal TTL. Covers TCP; a few apps may still send DNS directly.",
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                Text(
                    "Use this if your kernel can't do TTL rewriting, or you'd rather not root. Turn on the Wi-Fi hotspot, start the proxy, then point the MacBook's SOCKS proxy at the phone.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun StatusCard(
    status: HidingStatus,
    detail: String?,
    interfaces: List<String>,
    ttl: Int,
) {
    val (icon: ImageVector, tint: Color, headline: String) = when (status) {
        HidingStatus.ACTIVE -> Triple(Icons.Filled.Shield, Color(0xFF2E7D32), "Hiding active")
        HidingStatus.INACTIVE -> Triple(Icons.Filled.CheckCircle, MaterialTheme.colorScheme.outline, "Idle")
        HidingStatus.NO_ROOT -> Triple(Icons.Filled.Error, MaterialTheme.colorScheme.error, "Root required")
        HidingStatus.UNSUPPORTED -> Triple(Icons.Filled.Error, MaterialTheme.colorScheme.error, "Not supported")
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = tint)
                Spacer(Modifier.width(12.dp))
                Text(text = headline, style = MaterialTheme.typography.titleLarge)
            }

            when (status) {
                HidingStatus.ACTIVE -> {
                    Text("Normalizing TTL/Hop-Limit to $ttl on all outgoing packets.")
                    if (interfaces.isNotEmpty()) {
                        Text(
                            "Tether interfaces: ${interfaces.joinToString(", ")}",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        Text(
                            "No tether interface detected yet — turn on USB/Wi-Fi/Bluetooth tethering in Android settings.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                else -> detail?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun HowToCard() {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("How to use", style = MaterialTheme.typography.titleMedium)
            Text(
                "1. Grant root when prompted.\n" +
                    "2. Tap “Start hiding”.\n" +
                    "3. Turn on tethering the normal way: Settings → Hotspot & tethering → USB / Wi-Fi / Bluetooth.\n" +
                    "4. Your laptop's traffic now looks like it came from the phone.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "Tip: keep this running in the background; it re-applies the rules automatically if the connection drops.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
