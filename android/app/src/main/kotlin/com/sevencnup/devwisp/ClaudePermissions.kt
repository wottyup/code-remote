package com.sevencnup.devwisp

import org.json.JSONObject

internal data class ClaudePermissionKey(val threadId: String, val permissionId: String)

internal data class ClaudePermissionRequest(
    val key: ClaudePermissionKey,
    val toolName: String,
    val command: String,
    val filePath: String,
    val cwd: String,
    val reason: String,
) {
    companion object {
        fun fromJson(value: JSONObject): ClaudePermissionRequest? {
            fun text(name: String) = (value.opt(name) as? String).orEmpty()
            val threadId = text("threadId")
            val permissionId = text("permissionId")
            if (threadId.isBlank() || permissionId.isBlank()) return null
            return ClaudePermissionRequest(ClaudePermissionKey(threadId, permissionId),
                text("toolName"), text("command"), text("filePath"), text("cwd"), text("reason"))
        }
    }
}

/** Main-thread state. A late recovery response must never resurrect a resolved request. */
internal class ClaudePermissionInbox {
    private val requests = linkedMapOf<ClaudePermissionKey, ClaudePermissionRequest>()
    private val submitting = mutableSetOf<ClaudePermissionKey>()
    var revision = 0L
        private set

    fun forThread(threadId: String?): List<ClaudePermissionRequest> =
        requests.values.filter { it.key.threadId == threadId }

    fun isSubmitting(key: ClaudePermissionKey) = key in submitting

    fun receive(request: ClaudePermissionRequest): Boolean {
        revision++
        return requests.put(request.key, request) != request
    }

    fun resolve(key: ClaudePermissionKey): Boolean {
        revision++
        submitting.remove(key)
        return requests.remove(key) != null
    }

    fun reconcile(snapshot: List<ClaudePermissionRequest>, expectedRevision: Long): Boolean {
        if (revision != expectedRevision) return false
        val replacement = snapshot.associateByTo(linkedMapOf()) { it.key }
        if (requests == replacement) return false
        requests.clear()
        requests.putAll(replacement)
        submitting.retainAll(requests.keys)
        revision++
        return true
    }

    fun beginDecision(key: ClaudePermissionKey): Boolean {
        if (key !in requests || !submitting.add(key)) return false
        revision++
        return true
    }

    fun finishDecision(key: ClaudePermissionKey, resolved: Boolean) {
        if (resolved) resolve(key) else {
            submitting.remove(key)
            revision++
        }
    }

    fun clear() {
        requests.clear()
        submitting.clear()
        revision++
    }
}
