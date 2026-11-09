package com.sevencnup.codexremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveReplyTextTest {
    @Test fun revealsOrdinaryStreamingTextOneCodePointAtATime() {
        val reply = LiveReplyText()
        reply.append("你好，AI")
        assertEquals("你", reply.revealNext())
        assertEquals("好", reply.revealNext())
        assertEquals("，", reply.revealNext())
        assertEquals("A", reply.revealNext())
        assertEquals("I", reply.revealNext())
        assertFalse(reply.hasPendingText)
    }

    @Test fun doesNotSplitEmojiAndCatchesUpWithLargeBursts() {
        val emoji = LiveReplyText()
        emoji.append("甲😀乙")
        assertEquals("甲", emoji.revealNext())
        assertEquals("😀", emoji.revealNext())
        assertEquals("乙", emoji.revealNext())

        val burst = LiveReplyText()
        burst.append("字".repeat(1000))
        repeat(18) { burst.revealNext() }
        assertFalse(burst.hasPendingText)
        assertEquals(1000, burst.visibleText.length)
    }

    @Test fun adjacentDeltasStayQueuedUntilTheNextDisplayFrame() {
        val reply = LiveReplyText()
        repeat(10) { reply.append("字") }
        assertEquals("", reply.visibleText)
        assertEquals("字", reply.revealNext())
        assertTrue(reply.hasPendingText)
    }

    @Test fun snapshotNeverRewindsTheLiveReplyAndCompletionUsesFinalText() {
        val reply = LiveReplyText("前缀")
        reply.append("后续")
        assertFalse(reply.acceptSnapshot("前缀后"))
        assertTrue(reply.acceptSnapshot("前缀后续完成"))
        assertEquals("后", reply.revealNext())
        reply.complete("前缀后续完成。")
        assertEquals("前缀后续完成。", reply.visibleText)
        assertFalse(reply.hasPendingText)
        assertFalse(reply.append("迟到的增量"))
    }
}
