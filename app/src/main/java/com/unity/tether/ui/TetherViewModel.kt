package com.unity.tether.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.unity.tether.HidingStateHolder
import com.unity.tether.net.TtlManager
import com.unity.tether.service.TetherService
import kotlinx.coroutines.flow.StateFlow

class TetherViewModel(app: Application) : AndroidViewModel(app) {

    val state: StateFlow<com.unity.tether.HidingState> = HidingStateHolder.state

    /** TTL the user wants to normalize to. 64 works for virtually all carriers. */
    var ttl: Int = TtlManager.DEFAULT_TTL
        private set

    fun setTtl(value: Int) {
        ttl = value.coerceIn(1, 255)
    }

    fun start() = TetherService.start(getApplication(), ttl)

    fun stop() = TetherService.stop(getApplication())
}
