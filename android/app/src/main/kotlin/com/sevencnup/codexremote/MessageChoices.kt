package com.sevencnup.codexremote

internal data class MessageChoiceGroup(
    val question: String,
    val options: List<String>,
    val descriptions: List<String> = emptyList(),
)

/** Mirrors the web quick-choice rules for completed assistant replies. */
internal object MessageChoices {
    private val optionLine = Regex("""^\s*(?:[-*]\s+|\d{1,2}[.)、]\s+)(.+?)\s*$""")
    private val fenceLine = Regex("""^\s{0,3}(?:```|~~~)""")

    /** Compatibility for servers that flattened an async question into a call_ message. */
    fun parsePrompt(value: String): List<MessageChoiceGroup> {
        val groups = mutableListOf<MessageChoiceGroup>()
        val question = mutableListOf<String>()
        val options = mutableListOf<String>()
        fun finishGroup() {
            if (question.isNotEmpty() && options.isNotEmpty()) {
                groups += MessageChoiceGroup(question.joinToString("\n"), options.toList())
            }
            question.clear()
            options.clear()
        }
        for (line in value.replace("\r\n", "\n").replace('\r', '\n').lines()) {
            if (line.isBlank()) continue
            if (fenceLine.containsMatchIn(line)) return emptyList()
            val option = optionLine.matchEntire(line)?.groupValues?.get(1)?.trim()
            if (option != null && question.isNotEmpty()) options += option
            else {
                if (options.isNotEmpty()) finishGroup()
                question += plainQuestionLine(line)
            }
        }
        finishGroup()
        if (groups.isNotEmpty()) return groups
        // A free-text-only prompt has no option list.
        val title = value.trim()
        return if (title.isNotEmpty() && (title.endsWith('?') || title.endsWith('？')))
            listOf(MessageChoiceGroup(title, emptyList())) else emptyList()
    }

    fun parse(value: String): List<MessageChoiceGroup> {
        val lines = value.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        data class Candidate(val group: MessageChoiceGroup, val start: Int, val end: Int)
        val candidates = mutableListOf<Candidate>()
        var inCodeFence = false
        var index = 0
        while (index < lines.size) {
            val raw = lines[index].trim()
            if (fenceLine.containsMatchIn(raw)) {
                inCodeFence = !inCodeFence
                index++
                continue
            }
            val line = plainQuestionLine(raw)
            val questionEnd = line.indexOfFirst { it == '?' || it == '？' }
            val question = if (questionEnd >= 0) line.take(questionEnd + 1).trim() else ""
            if (inCodeFence || question.length < 4 || question.length > 220) {
                index++
                continue
            }
            var cursor = index + 1
            while (cursor < lines.size && lines[cursor].isBlank()) cursor++
            val options = mutableListOf<String>()
            while (cursor < lines.size) {
                val option = optionLine.matchEntire(lines[cursor])?.groupValues?.get(1)?.trim()
                if (option.isNullOrEmpty()) break
                options += option
                cursor++
            }
            if (options.size in 2..6 && options.none { it.length > 180 }) {
                candidates += Candidate(MessageChoiceGroup(question, options), index, cursor - 1)
                index = cursor
            } else index++
        }

        var lastContentLine = lines.indexOfLast { it.isNotBlank() }
        val groups = mutableListOf<MessageChoiceGroup>()
        for (candidate in candidates.asReversed()) {
            if (candidate.end != lastContentLine) break
            groups.add(0, candidate.group)
            if (groups.size > 3) return emptyList()
            lastContentLine = candidate.start - 1
            while (lastContentLine >= 0 && lines[lastContentLine].isBlank()) lastContentLine--
        }
        return groups
    }

    fun formatReply(groups: List<MessageChoiceGroup>, selected: List<Int>, customAnswers: List<String>): String =
        groups.mapIndexed { index, group ->
            val answer = if (selected[index] == -2) customAnswers[index].trim() else group.options[selected[index]]
            "${index + 1}. ${group.question}\n答：$answer"
        }.joinToString("\n\n")

    private fun plainQuestionLine(value: String): String = value.trim()
        .replace(Regex("""^(?:>\s*)+"""), "")
        .replace(Regex("""^#{1,6}\s+"""), "")
        .replace(Regex("""^\d{1,2}[.)、]\s+"""), "")
        .replace(Regex("""^\*\*(.+)\*\*$"""), "$1")
        .replace(Regex("""^__(.+)__$"""), "$1")
        .trim()
}
