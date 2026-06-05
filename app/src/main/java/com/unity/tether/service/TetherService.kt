package com.unity.tether.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.unity.tether.HidingState
import com.unity.tether.HidingStateHolder
import com.unity.tether.HidingStatus
import com.unity.tether.MainActivity
import com.unity.tether.R
import com.unity.tether.TetherApp
import com.unity.tether.net.TtlManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service that owns the hiding layer for as long as it's wanted.
 *
 * Connectivity changes (radio drop, tether toggle) can flush netfilter rules,
 * so rather than apply-once we keep a light watchdog loop that re-asserts the
 * rules and refreshes the detected tether interfaces. This is what makes the
 * hiding "stick" across a real tethering session.
 */
class TetherService : LifecycleService() {

    private var watchdog: Job? = null
    private var ttl: Int = TtlManager.DEFAULT_TTL

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> {
                stopHiding()
                return START_NOT_STICKY
            }
            else -> {
                ttl = intent?.getIntExtra(EXTRA_TTL, TtlManager.DEFAULT_TTL)
                    ?: TtlManager.DEFAULT_TTL
                startHiding()
            }
        }
        return START_STICKY
    }

    private fun startHiding() {
        startForegroundCompat(NOTIF_ID, buildNotification(HidingStatus.INACTIVE, emptyList()))

        watchdog?.cancel()
        watchdog = lifecycleScope.launch {
            when (val support = TtlManager.checkSupport()) {
                is TtlManager.SupportResult.NoRoot -> {
                    publish(HidingStatus.NO_ROOT, detail = "Grant root access, then try again.")
                    stopSelfClean()
                    return@launch
                }
                is TtlManager.SupportResult.Unsupported -> {
                    publish(HidingStatus.UNSUPPORTED, detail = support.reason)
                    stopSelfClean()
                    return@launch
                }
                is TtlManager.SupportResult.Supported -> Unit
            }

            // Watchdog: assert rules, refresh interfaces, sleep, repeat.
            while (isActive) {
                TtlManager.apply(ttl)
                val ifaces = TtlManager.activeTetherInterfaces()
                publish(HidingStatus.ACTIVE, ifaces = ifaces)
                delay(WATCHDOG_INTERVAL_MS)
            }
        }
    }

    private fun stopHiding() {
        watchdog?.cancel()
        lifecycleScope.launch {
            TtlManager.clear(ttl)
            publish(HidingStatus.INACTIVE)
            stopSelfClean()
        }
    }

    private suspend fun publish(
        status: HidingStatus,
        ifaces: List<String> = emptyList(),
        detail: String? = null,
    ) {
        HidingStateHolder.update {
            HidingState(status = status, ttl = ttl, tetherInterfaces = ifaces, detail = detail)
        }
        // Keep the persistent notification in sync with state.
        val notif = buildNotification(status, ifaces)
        getSystemService(android.app.NotificationManager::class.java)
            .notify(NOTIF_ID, notif)
    }

    private fun stopSelfClean() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun buildNotification(status: HidingStatus, ifaces: List<String>): Notification {
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, TetherService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val text = when (status) {
            HidingStatus.ACTIVE -> if (ifaces.isEmpty()) {
                getString(R.string.notif_active_no_iface, ttl)
            } else {
                getString(R.string.notif_active, ttl, ifaces.joinToString(", "))
            }
            HidingStatus.NO_ROOT -> getString(R.string.notif_no_root)
            HidingStatus.UNSUPPORTED -> getString(R.string.notif_unsupported)
            HidingStatus.INACTIVE -> getString(R.string.notif_inactive)
        }

        return NotificationCompat.Builder(this, TetherApp.CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(status == HidingStatus.ACTIVE)
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
        const val ACTION_START = "com.unity.tether.START"
        const val ACTION_STOP = "com.unity.tether.STOP"
        const val EXTRA_TTL = "ttl"
        private const val NOTIF_ID = 42
        private const val WATCHDOG_INTERVAL_MS = 5_000L

        fun start(context: Context, ttl: Int) {
            val intent = Intent(context, TetherService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TTL, ttl)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, TetherService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
