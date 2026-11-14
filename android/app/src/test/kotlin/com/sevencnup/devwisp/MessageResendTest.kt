package com.sevencnup.devwisp

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class MessageResendTest {
    private fun item(vararg parts: JSONObject) = JSONObject().put("content", JSONArray(parts.toList()))
    private fun restore(text: String, item: JSONObject = JSONObject()) = MessageResend.restore(text, item) {
        error("No remote image should be read")
    }

    @Test fun keepsOrdinaryMessageWhitespaceAndDoesNotTranslateOrConsumeTheDraft() {
        val text = "First line\n\n  indented line\n第三行"
        val result = restore(text)
        assertEquals(text, result.text)
        assertTrue(result.files.isEmpty())
    }

    @Test fun extractsTextDocumentsWithoutDuplicatingTheirBlocksInTheBody() {
        val result = restore("Please review\n\n[附件文档：说明.md]\n# Title\n\nBody\n[/附件文档]")
        assertEquals("Please review", result.text)
        assertEquals(1, result.files.size)
        assertEquals("说明.md", result.files.single().getString("name"))
        assertEquals("# Title\n\nBody", result.files.single().getString("content"))
        assertEquals("document", result.files.single().getString("kind"))
    }

    @Test fun restoresOriginalPdfAndFileIdsAndDecodesNamesWithoutLosingPlusSigns() {
        val id = "12345678901234567890123456789012"
        for (kind in listOf("FILE", "PDF")) {
            val result = restore("Read\n[[CODEX_REMOTE_${kind}_BEGIN id=$id name=%E6%B5%8B%E8%AF%95+C%2B%2B.pdf]]\nold extracted preview\n[[CODEX_REMOTE_${kind}_END id=$id]]")
            assertEquals("Read", result.text)
            assertEquals(id, result.files.single().getString("sourceFileId"))
            assertEquals("测试+C++.pdf", result.files.single().getString("name"))
            assertEquals("", result.files.single().getString("content"))
        }
    }

    @Test fun retainsBothTextAndInlineImagesWithoutMutatingTheHistoricalMessage() {
        val message = item(JSONObject().put("type", "image").put("name", "shot.png")
            .put("image_url", "data:image/png;base64,aGVsbG8="))
        val original = message.toString()
        val result = restore("Explain this", message)
        assertEquals("Explain this", result.text)
        assertEquals("image", result.files.single().getString("kind"))
        assertEquals("image/png", result.files.single().getString("mediaType"))
        assertEquals("aGVsbG8=", result.files.single().getString("data"))
        assertEquals(original, message.toString())
    }

    @Test fun supportsImageOnlyMessagesAndSnakeCaseMediaTypes() {
        val result = restore("", item(JSONObject().put("type", "local_image")
            .put("data", "aGVsbG8=").put("media_type", "image/jpeg")))
        assertEquals("", result.text)
        assertEquals("image/jpeg", result.files.single().getString("mediaType"))
        assertEquals("aGVsbG8=", result.files.single().getString("data"))
    }

    @Test fun reloadsPathBasedImagesUsingTheCapturedConnection() {
        val paths = mutableListOf<String>()
        val result = MessageResend.restore("Image", item(JSONObject().put("type", "localImage")
            .put("path", "/workspace/image.webp"))) { path ->
            paths += path
            JSONObject().put("mediaType", "image/webp").put("data", "aGVsbG8=")
        }
        assertEquals(listOf("/workspace/image.webp"), paths)
        assertEquals("image/webp", result.files.single().getString("mediaType"))
    }

    @Test fun aMissingImageAbortsTheWholeResendInsteadOfSilentlySendingJustTheText() {
        val message = item(JSONObject().put("type", "localImage").put("path", "/expired.png"))
        assertThrows(IOException::class.java) {
            MessageResend.restore("Must keep its picture", message) { throw IOException("Expired") }
        }
        assertThrows(IOException::class.java) {
            MessageResend.restore("Must keep its picture", message) { JSONObject() }
        }
    }

    @Test fun malformedOriginalFileMarkersAreRetainedRatherThanDroppingContent() {
        val text = "[[CODEX_REMOTE_FILE_BEGIN id=short name=notes.md]]keep this text"
        assertEquals(text, restore(text).text)
    }
}
