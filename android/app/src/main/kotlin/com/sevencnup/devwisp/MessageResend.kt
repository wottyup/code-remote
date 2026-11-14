package com.sevencnup.devwisp

import org.json.JSONObject
import java.io.IOException
import java.net.URLDecoder

internal object MessageResend {
    data class Content(val text: String, val files: List<JSONObject>)

    private val originalFile = Regex(
        """\[\[CODEX_REMOTE_(FILE|PDF)_BEGIN id=([A-Za-z0-9_-]{24,64}) name=([^\]\r\n]+)\]\][\s\S]*?\[\[CODEX_REMOTE_\1_END id=\2\]\]""",
    )
    private val textDocument = Regex("""\[附件文档：([^\r\n]+)\]\r?\n([\s\S]*?)\r?\n\[/附件文档\]""")
    private val dataImage = Regex("""^data:(image/[A-Za-z0-9.+-]+);base64,([\s\S]+)$""")

    /** Never silently resend just the text if one of the original images is unavailable. */
    fun restore(rawText: String, item: JSONObject, loadLocalImage: (String) -> JSONObject): Content {
        val files = mutableListOf<JSONObject>()
        val withoutOriginalFiles = originalFile.replace(rawText) { match ->
            val name = runCatching {
                URLDecoder.decode(match.groupValues[3].replace("+", "%2B"), "UTF-8")
            }.getOrDefault(match.groupValues[3])
            files += JSONObject().put("kind", "document").put("name", name)
                .put("content", "").put("sourceFileId", match.groupValues[2])
            ""
        }
        val text = textDocument.replace(withoutOriginalFiles) { match ->
            files += JSONObject().put("kind", "document").put("name", match.groupValues[1])
                .put("content", match.groupValues[2])
            ""
        }.trim()
        val parts = item.optJSONArray("content")
        for (index in 0 until (parts?.length() ?: 0)) {
            val part = parts?.optJSONObject(index) ?: continue
            val type = part.optString("type").replace("_", "").replace("-", "").lowercase()
            if (type != "image" && type != "localimage") continue
            val inline = if (type == "image") (part.opt("image_url") as? String).orEmpty()
                else (part.opt("data") as? String).orEmpty()
            val dataUrl = dataImage.matchEntire(inline)
            val restored = when {
                dataUrl != null -> JSONObject().put("mediaType", dataUrl.groupValues[1]).put("data", dataUrl.groupValues[2])
                type == "localimage" && inline.isNotBlank() -> JSONObject()
                    .put("mediaType", (part.opt("mediaType") as? String)
                        ?: (part.opt("media_type") as? String) ?: "image/png")
                    .put("data", inline)
                else -> {
                    val path = (part.opt("path") as? String)?.takeIf { it.isNotBlank() }
                        ?: throw IOException("原消息图片无法读取，未重新发送。")
                    loadLocalImage(path)
                }
            }
            if (restored.optString("data").isBlank() || !restored.optString("mediaType").startsWith("image/")) {
                throw IOException("原消息图片无法读取，未重新发送。")
            }
            files += JSONObject().put("kind", "image")
                .put("name", (part.opt("name") as? String)?.takeIf { it.isNotBlank() } ?: "image-${index + 1}")
                .put("mediaType", restored.getString("mediaType")).put("data", restored.getString("data"))
        }
        return Content(text, files)
    }
}
