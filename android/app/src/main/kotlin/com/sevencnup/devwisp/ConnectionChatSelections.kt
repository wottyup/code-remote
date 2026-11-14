package com.sevencnup.devwisp

/** Persists each connection's current mode and chat alongside older per-mode selections. */
internal class ConnectionChatSelections(
    private val read: (String) -> String?,
    private val write: (Map<String, String>) -> Unit,
) {
    data class Selection(val mode: String, val threadId: String?, val explicitlyEmpty: Boolean)

    fun save(connectionId: String, legacyId: String?, mode: String, threadId: String?) {
        val values = mutableMapOf(
            GLOBAL_MODE_KEY to mode,
            scopedKey(connectionId, legacyId, CONNECTION_MODE_KEY) to mode,
            scopedKey(connectionId, legacyId, CONNECTION_THREAD_KEY) to threadId.orEmpty(),
        )
        if (!threadId.isNullOrBlank()) {
            values[scopedKey(connectionId, legacyId, "$ACTIVE_THREAD_PREFIX$mode")] = threadId
        }
        write(values)
    }

    fun restore(connectionId: String, legacyId: String?, fallbackMode: String?): Selection {
        val savedMode = read(scopedKey(connectionId, legacyId, CONNECTION_MODE_KEY))
        val savedThread = read(scopedKey(connectionId, legacyId, CONNECTION_THREAD_KEY))
        val fallback = validMode(fallbackMode) ?: "codex"
        val alternate = if (fallback == "codex") "claude-code" else "codex"
        fun oldThread(mode: String): String? =
            read(scopedKey(connectionId, legacyId, "$ACTIVE_THREAD_PREFIX$mode"))?.takeIf(String::isNotBlank)
        val mode = validMode(savedMode) ?: if (savedThread == null && oldThread(fallback) == null && oldThread(alternate) != null) {
            alternate
        } else fallback
        val threadId = if (savedThread != null) savedThread.takeIf(String::isNotBlank)
        else oldThread(mode)
        return Selection(mode, threadId, savedThread != null && threadId == null)
    }

    private fun validMode(mode: String?): String? = mode?.takeIf { it == "codex" || it == "claude-code" }

    companion object {
        const val GLOBAL_MODE_KEY = "native_engine_mode"
        const val ACTIVE_THREAD_PREFIX = "native_active_thread_"
        private const val CONNECTION_MODE_KEY = "native_connection_last_mode"
        private const val CONNECTION_THREAD_KEY = "native_connection_last_thread"

        fun scopedKey(connectionId: String, legacyId: String?, base: String): String =
            if (connectionId.isBlank() || connectionId == legacyId) base else "${connectionId}_$base"
    }
}
