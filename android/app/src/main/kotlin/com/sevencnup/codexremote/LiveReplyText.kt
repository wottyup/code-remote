package com.sevencnup.codexremote

/** Keeps the visible reply behind incoming text for at most a few display frames. */
internal class LiveReplyText(initialText: String = "") {
    private val target = StringBuilder(initialText)
    private var framesRemaining = 18
    var visibleLength: Int = initialText.length
        private set
    var completed: Boolean = false
        private set

    val targetText: String get() = target.toString()
    val visibleText: String get() = target.substring(0, visibleLength)
    val hasPendingText: Boolean get() = visibleLength < target.length

    fun append(delta: String): Boolean {
        if (completed || delta.isEmpty()) return false
        if (!hasPendingText) framesRemaining = 18
        target.append(delta)
        return true
    }

    fun acceptSnapshot(snapshot: String): Boolean {
        if (completed || snapshot.length <= target.length || !snapshot.startsWith(target.toString())) return false
        if (!hasPendingText) framesRemaining = 18
        target.setLength(0)
        target.append(snapshot)
        return true
    }

    fun revealNext(maxFrames: Int = 18): String {
        if (!hasPendingText) return ""
        val remainingCodePoints = Character.codePointCount(target, visibleLength, target.length)
        val frames = framesRemaining.coerceAtMost(maxFrames.coerceAtLeast(1))
        val step = ((remainingCodePoints + frames - 1) / frames).coerceAtLeast(1)
        val start = visibleLength
        repeat(step) {
            if (visibleLength < target.length) {
                visibleLength += Character.charCount(Character.codePointAt(target, visibleLength))
            }
        }
        framesRemaining = (frames - 1).coerceAtLeast(1)
        return target.substring(start, visibleLength)
    }

    fun complete(finalText: String? = null) {
        if (!finalText.isNullOrEmpty()) {
            target.setLength(0)
            target.append(finalText)
        }
        visibleLength = target.length
        framesRemaining = 18
        completed = true
    }

    fun flush() {
        visibleLength = target.length
        framesRemaining = 18
    }
}
