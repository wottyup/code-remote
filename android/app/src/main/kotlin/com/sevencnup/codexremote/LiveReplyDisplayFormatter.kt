package com.sevencnup.codexremote

/** Formats only the displayed stream; the original reply remains untouched. */
internal class LiveReplyDisplayFormatter {
    private val line = StringBuilder()
    private val leadingWhitespace = StringBuilder()
    private var fenceCharacter: Char? = null
    private var fenceLength = 0
    private var trailingNewlines = 0
    private var hasDisplayedText = false
    private var skipLineFeed = false
    private var inLeadingWhitespace = true

    fun append(chunk: String): String {
        val output = StringBuilder(chunk.length)
        for (character in chunk) {
            if (skipLineFeed) {
                skipLineFeed = false
                if (character == '\n') continue
            }
            if (character == '\r' || character == '\n') {
                if (character == '\r') skipLineFeed = true
                if (fenceCharacter != null || hasDisplayedText && trailingNewlines < 2) {
                    output.append('\n')
                    trailingNewlines++
                }
                updateFence()
                line.setLength(0)
                leadingWhitespace.setLength(0)
                inLeadingWhitespace = true
                continue
            }
            val atLineStart = inLeadingWhitespace
            if (character != ' ' && character != '\t') inLeadingWhitespace = false
            line.append(character)
            if (fenceCharacter == null && atLineStart && (character == ' ' || character == '\t')) {
                leadingWhitespace.append(character)
                continue
            }
            if (leadingWhitespace.isNotEmpty()) {
                output.append(leadingWhitespace)
                leadingWhitespace.setLength(0)
            }
            output.append(character)
            if (character != ' ' && character != '\t') {
                hasDisplayedText = true
                trailingNewlines = 0
            }
        }
        return output.toString()
    }

    private fun updateFence() {
        val text = line.toString()
        val indentation = text.takeWhile { it == ' ' }.length
        if (indentation > 3) return
        val remainder = text.drop(indentation)
        val activeFence = fenceCharacter
        if (activeFence == null) {
            val character = remainder.firstOrNull()?.takeIf { it == '`' || it == '~' } ?: return
            val length = remainder.takeWhile { it == character }.length
            if (length >= 3 && (character != '`' || '`' !in remainder.drop(length))) {
                fenceCharacter = character
                fenceLength = length
            }
        } else {
            val length = remainder.takeWhile { it == activeFence }.length
            if (length >= fenceLength && remainder.drop(length).all { it == ' ' || it == '\t' }) {
                fenceCharacter = null
                fenceLength = 0
            }
        }
    }
}
