package com.sevencnup.devwisp

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveReplyDisplayFormatterTest {
    private fun streamed(text: String, chunkSize: Int): String {
        val formatter = LiveReplyDisplayFormatter()
        return text.chunked(chunkSize).joinToString("") { formatter.append(it) }
    }

    @Test fun collapsesExtraParagraphGapsAcrossChunks() {
        val raw = "\n\n第一段\n\n \t\n\n第二段\n\n\n第三段"
        val expected = "第一段\n\n第二段\n\n第三段"
        listOf(1, 2, 3, raw.length).forEach { size ->
            assertEquals(expected, streamed(raw, size))
        }
    }

    @Test fun keepsBlankLinesAndIndentationInCodeFences() {
        val raw = "正文\n\n```kotlin\nfun a() {\n\n\n    work()\n}\n```\n\n\n结束"
        val expected = "正文\n\n```kotlin\nfun a() {\n\n\n    work()\n}\n```\n\n结束"
        listOf(1, 2, 7, raw.length).forEach { size ->
            assertEquals(expected, streamed(raw, size))
        }
    }

    @Test fun acceptsTildeFencesAndCarriageReturnsSplitAcrossDeltas() {
        val raw = "开始\r\n~~~text\r\nA\r\n\r\n\r\nB\r\n~~~\r\n\r\n\r\n结束"
        val expected = "开始\n~~~text\nA\n\n\nB\n~~~\n\n结束"
        listOf(1, 2, 5, raw.length).forEach { size ->
            assertEquals(expected, streamed(raw, size))
        }
    }

    @Test fun formattingLeavesOriginalReplyAvailableForHistoryAndCopy() {
        val raw = "甲\n\n\n\n乙"
        val reply = LiveReplyText(raw)
        assertEquals("甲\n\n乙", streamed(reply.visibleText, 1))
        assertEquals(raw, reply.targetText)
        assertEquals(raw, reply.visibleText)
    }
}
