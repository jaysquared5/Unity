package com.unity.tether

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** State of the no-root SOCKS5 proxy path, shared between service and UI. */
data class ProxyState(
    val running: Boolean = false,
    val port: Int = 8282,
    /** Best-effort hotspot gateway IP the laptop should target, if detected. */
    val address: String? = null,
    val activeConnections: Int = 0,
)

object ProxyStateHolder {
    private val _state = MutableStateFlow(ProxyState())
    val state: StateFlow<ProxyState> = _state.asStateFlow()

    fun update(transform: (ProxyState) -> ProxyState) {
        _state.value = transform(_state.value)
    }
}
