package com.unity.tether.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.unity.tether.MainActivity
import com.unity.tether.ProxyState
import com.unity.tether.ProxyStateHolder
import com.unity.tether.R
import com.unity.tether.TetherApp
import com.unity.tether.proxy.Socks5ProxyServer

/**
 * Foreground service that hosts the no-root [Socks5ProxyServer] for as long as
 * the user wants it. Pairs with the Wi-Fi hotspot transport: the laptop joins
 * the hotspot and points its SOCKS proxy at this phone.
 */
class ProxyService : Service() {

    private var server: Socks5ProxyServer? = null
    private var port: Int = Socks5ProxyServer.DEFAULT_PORT

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopProxy()
                return START_NOT_STICKY
            }
            else -> {
                port = intent?.getIntExtra(EXTRA_PORT, Socks5ProxyServer.DEFAULT_PORT)
                    ?: Socks5ProxyServer.DEFAULT_PORT
                startProxy()
            }
        }
        return START_STICKY
    }

    private fun startProxy() {
        val address = Socks5ProxyServer.hotspotAddress()
        publish(ProxyState(running = true, port = port, address = address, activeConnections = 0))
        startForegroundCompat(NOTIF_ID, buildNotification(0))

        server = Socks5ProxyServer(port) { count ->
            ProxyStateHolder.update { it.copy(activeConnections = count) }
            getSystemService(NotificationManager::class.java)
                .notify(NOTIF_ID, buildNotification(count))
        }.also { runCatching { it.start() } }
    }

    private fun stopProxy() {
        runCatching { server?.stop() }
        server = null
        publish(ProxyState(running = false, port = port))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        runCatching { server?.stop() }
        super.onDestroy()
    }

    private fun publish(state: ProxyState) = ProxyStateHolder.update { state }

    private fun buildNotification(connections: Int): Notification {
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 2,
            Intent(this, ProxyService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val text = getString(R.string.notif_proxy_active, port, connections)

        return NotificationCompat.Builder(this, TetherApp.CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .addAction(0, getString(R.string.action_stop), stopIntent)
            .build()
    }

    private fun startForegroundCompat(id: Int, notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(id, notification)
        }
    }

    companion object {
        const val ACTION_START = "com.unity.tether.PROXY_START"
        const val ACTION_STOP = "com.unity.tether.PROXY_STOP"
        const val EXTRA_PORT = "port"
        private const val NOTIF_ID = 43

        fun start(context: Context, port: Int = Socks5ProxyServer.DEFAULT_PORT) {
            val intent = Intent(context, ProxyService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_PORT, port)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, ProxyService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
