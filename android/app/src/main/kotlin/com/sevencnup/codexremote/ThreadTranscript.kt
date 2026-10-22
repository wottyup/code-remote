package com.sevencnup.codexremote

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.OffsetDateTime

/** The same portable Markdown conversation format used by the web sidebar. */
internal object ThreadTranscript {
    private data class Message(
        val role: String,
        var text: String,
        val time: String,
        val durationMs: Long?,
        val images: List<String>,
        val documents: List<Pair<String, String>>,
        val originalFiles: List<String>,
    )

    private val documentPattern = Regex("""\[附件文档：([^\r\n]+)\]\r?\n([\s\S]*?)\r?\n\[/附件文档\]""")
    private val originalFilePatterns = listOf("FILE", "PDF").map { kind ->
        Regex("""\[\[CODEX_REMOTE_${kind}_BEGIN id=([A-Za-z0-9_-]{24,64}) name=([^\]\r\n]+)\]\][\s\S]*?\[\[CODEX_REMOTE_${kind}_END id=\1\]\]""")
    }

    fun filename(thread: JSONObject, prefix: String): String {
        val safeName = title(thread).map { character ->
            if (character.code < 32 || character in "\\/:*?\"<>|") '-' else character
        }.joinToString("")
            .replace(Regex("\\s+"), " ")
            .replace(Regex("-+"), "-")
            .trim('.', ' ', '-')
            .take(64)
            .ifBlank { "未命名对话" }
        return "$prefix-$safeName.md"
    }

    fun create(thread: JSONObject, generatedAt: String = Instant.now().toString()): String {
        val title = title(thread)
        val assistantLabel = if (thread.optString("engine") == "claude-code" || thread.optString("id").startsWith("claude:")) "Claude Code" else "Codex"
        val lines = mutableListOf(
            "# 对话记录", "", "> 来源对话：${title.replace(Regex("[\\r\\n]+"), " ").replace(Regex("^\\s*#+\\s*"), "").trim()}", "",
            "## 对话信息", "", "- 对话名称：${inlineCode(title)}", "- 对话 ID：${inlineCode(thread.optString("id"))}",
        )
        thread.optString("cwd").takeIf { it.isNotBlank() && it != "null" }?.let { lines += "- 工作目录：${inlineCode(it)}" }
        lines += listOf("- 整理时间：${inlineCode(generatedAt)}", "", "## 对话内容")

        val messages = messages(thread.optJSONArray("turns") ?: JSONArray())
        if (messages.isEmpty()) lines += listOf("", "（这条对话还没有可导出的消息。）")
        messages.forEachIndexed { index, message ->
            lines += listOf("", "---", "", "### ${index + 1}. ${if (message.role == "user") "用户" else assistantLabel}")
            if (message.time.isNotBlank()) lines += listOf("", "- 时间：${inlineCode(message.time)}")
            message.durationMs?.let { lines += "- 回复用时：${inlineCode("${it.coerceAtLeast(0L)} ms")}" }
            if (message.text.isNotBlank()) lines += listOf("", message.text)
            else if (message.images.isEmpty() && message.documents.isEmpty() && message.originalFiles.isEmpty()) lines += listOf("", "（无文字内容）")
            if (message.images.isNotEmpty()) {
                lines += listOf("", "#### 图片附件", "")
                message.images.forEach { lines += "- ${inlineCode(it)}（图片内容未嵌入本次对话记录）" }
            }
            if (message.documents.isNotEmpty()) {
                lines += listOf("", "#### 文档附件", "")
                message.documents.forEach { (name, content) ->
                    lines += listOf("#### ${inlineCode(name)}", "")
                    if (content.isBlank()) lines += listOf("（空文档）", "")
                    else {
                        val fence = "`".repeat(maxOf(3, (Regex("`+").findAll(content).maxOfOrNull { it.value.length } ?: 0) + 1))
                        lines += listOf("${fence}text", content, fence, "")
                    }
                }
            }
            if (message.originalFiles.isNotEmpty()) {
                lines += listOf("", "#### 原始 PDF 附件", "")
                message.originalFiles.forEach { lines += "- ${inlineCode(it)}（本次只保留附件名称；原始 PDF 文件不会随引用传递，需要时请重新上传。）" }
            }
        }
        return lines.joinToString("\n").trim() + "\n"
    }

    private fun messages(turns: JSONArray): List<Message> {
        val result = mutableListOf<Message>()
        for (turnIndex in 0 until turns.length()) {
            val turn = turns.optJSONObject(turnIndex) ?: continue
            val items = turn.optJSONArray("items") ?: continue
            val startedAt = instant(first(turn, "startedAt", "started_at", "startedAtMs", "started_at_ms", "createdAt", "created_at"))
            val completedAt = instant(first(turn, "completedAt", "completed_at", "completedAtMs", "completed_at_ms"))
            val duration = if (startedAt != null && completedAt != null) (completedAt.toEpochMilli() - startedAt.toEpochMilli()).coerceAtLeast(0L) else null
            var lastAssistant: Message? = null
            for (itemIndex in 0 until items.length()) {
                val item = items.optJSONObject(itemIndex) ?: continue
                val type = item.optString("type").replace("-", "").replace("_", "").lowercase()
                if (type != "usermessage" && type != "agentmessage") continue
                val user = type == "usermessage"
                var text = plainText(if (user) item.opt("content") else item.opt("text"))
                if (user && text.isBlank()) text = item.optString("text")
                val originalFiles = mutableListOf<String>()
                if (user) originalFilePatterns.forEach { pattern ->
                    text = pattern.replace(text) { match ->
                        val encoded = match.groupValues[2]
                        originalFiles += runCatching { URLDecoder.decode(encoded, StandardCharsets.UTF_8.name()) }.getOrDefault(encoded)
                        ""
                    }
                }
                val documents = mutableListOf<Pair<String, String>>()
                if (user) text = documentPattern.replace(text) { match ->
                    documents += match.groupValues[1] to match.groupValues[2]
                    ""
                }
                text = text.replace(Regex("\n{3,}"), "\n\n").trim()
                val images = if (user) imageNames(item.optJSONArray("content")) else emptyList()
                if (text.isBlank() && images.isEmpty() && documents.isEmpty() && originalFiles.isEmpty()) continue
                if (!user && lastAssistant != null) {
                    lastAssistant.text = if (lastAssistant.text.isBlank()) text else "${lastAssistant.text}\n\n$text"
                    continue
                }
                val createdAt = instant(first(item, "createdAt", "created_at", "sentAt", "sent_at", "timestamp", "timestampMs", "timestamp_ms"))
                val time = (if (user) createdAt ?: startedAt else startedAt ?: createdAt)?.toString().orEmpty()
                val message = Message(if (user) "user" else "assistant", text, time, if (user) null else duration, images, documents, originalFiles)
                result += message
                lastAssistant = if (user) null else message
            }
        }
        return result
    }

    private fun title(thread: JSONObject): String = listOf(thread.optString("name"), thread.optString("preview"))
        .firstOrNull { it.isNotBlank() && it != "null" }
        ?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotBlank() } ?: "未命名对话"

    private fun inlineCode(value: String): String = "`${value.replace("`", "\\`").replace(Regex("[\\r\\n]+"), " ")}`"

    private fun plainText(value: Any?): String = when (value) {
        is String -> value
        is JSONArray -> buildString {
            for (index in 0 until value.length()) value.optJSONObject(index)?.optString("text")?.let(::append)
        }
        else -> ""
    }

    private fun imageNames(content: JSONArray?): List<String> {
        if (content == null) return emptyList()
        return (0 until content.length()).mapNotNull { index ->
            val part = content.optJSONObject(index) ?: return@mapNotNull null
            val type = part.optString("type").replace("-", "").replace("_", "").lowercase()
            if (type != "image" && type != "localimage") return@mapNotNull null
            part.optString("name").takeIf { it.isNotBlank() && it != "null" } ?: "image-${index + 1}"
        }
    }

    private fun first(value: JSONObject, vararg keys: String): Any? = keys.firstNotNullOfOrNull { key ->
        value.opt(key)?.takeIf { it !== JSONObject.NULL && it.toString().isNotBlank() && it.toString() != "null" }
    }

    private fun instant(value: Any?): Instant? = runCatching {
        when (value) {
            is Number -> epoch(value.toLong())
            is String -> value.trim().toLongOrNull()?.let(::epoch)
                ?: runCatching { Instant.parse(value) }.getOrNull()
                ?: OffsetDateTime.parse(value).toInstant()
            else -> null
        }
    }.getOrNull()

    private fun epoch(value: Long): Instant = Instant.ofEpochMilli(if (value in -9_999_999_999L..9_999_999_999L) value * 1000L else value)
}
