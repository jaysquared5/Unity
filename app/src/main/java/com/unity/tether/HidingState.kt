package com.unity.tether

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Top-level status of the hiding layer, shared between the service and the UI. */
enum class HidingStatus {
    /** Rules are not installed. */
    INACTIVE,

    /** Rules are installed and being maintained by the foreground service. */
    ACTIVE,

    /** Root not granted. */
    NO_ROOT,

    /** Root present but the kernel lacks the TTL/HL target. */
    UNSUPPORTED,
}

data class HidingState(
    val status: HidingStatus = HidingStatus.INACTIVE,
    val ttl: Int = 64,
    val tetherInterfaces: List<String> = emptyList(),
    val detail: String? = null,
)

/**
 * Process-wide single source of truth. The [com.unity.tether.service.TetherService]
 * writes to it; the UI observes it. Kept dead simple on purpose.
 */
object HidingStateHolder {
    private val _state = MutableStateFlow(HidingState())
    val state: StateFlow<HidingState> = _state.asStateFlow()

    fun update(transform: (HidingState) -> HidingState) {
        _state.value = transform(_state.value)
    }
}
