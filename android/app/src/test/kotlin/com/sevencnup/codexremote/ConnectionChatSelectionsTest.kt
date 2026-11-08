package com.sevencnup.codexremote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionChatSelectionsTest {
    private val preferences = mutableMapOf<String, String>()
    private val selections = ConnectionChatSelections(preferences::get) { preferences.putAll(it) }

    @Test fun returningToEachConnectionRestoresItsOwnModeAndChat() {
        selections.save("device-a", "device-a", "codex", "a-codex")
        selections.save("device-a", "device-a", "claude-code", "a-claude")
        selections.save("device-b", "device-a", "codex", "b-codex")
        assertEquals(ConnectionChatSelections.Selection("claude-code", "a-claude", false),
            selections.restore("device-a", "device-a", "codex"))
        assertEquals(ConnectionChatSelections.Selection("codex", "b-codex", false),
            selections.restore("device-b", "device-a", "claude-code"))
        assertEquals("a-codex", preferences["native_active_thread_codex"])
        assertEquals("a-claude", preferences["native_active_thread_claude-code"])
        assertEquals("b-codex", preferences["device-b_native_active_thread_codex"])
    }

    @Test fun oldPreferencesKeepWorkingWhenOnlyTheOtherModeHasAChat() {
        preferences["device-b_native_active_thread_codex"] = "old-b-chat"
        preferences["native_active_thread_claude-code"] = "old-a-chat"
        assertEquals(ConnectionChatSelections.Selection("codex", "old-b-chat", false),
            selections.restore("device-b", "device-a", "claude-code"))
        assertEquals(ConnectionChatSelections.Selection("claude-code", "old-a-chat", false),
            selections.restore("device-a", "device-a", "codex"))
        assertEquals(ConnectionChatSelections.Selection("claude-code", null, false),
            selections.restore("brand-new", "device-a", "claude-code"))
    }

    @Test fun oldPreferencesWithBothModesUseThePreviousGlobalMode() {
        preferences["device-b_native_active_thread_codex"] = "old-codex"
        preferences["device-b_native_active_thread_claude-code"] = "old-claude"
        assertEquals(ConnectionChatSelections.Selection("claude-code", "old-claude", false),
            selections.restore("device-b", "device-a", "claude-code"))
    }

    @Test fun blankSelectionStaysBlankWithoutErasingPreviousModeChat() {
        selections.save("device-a", null, "claude-code", "earlier")
        selections.save("device-a", null, "claude-code", null)
        val restored = selections.restore("device-a", null, "codex")
        assertEquals("claude-code", restored.mode)
        assertNull(restored.threadId)
        assertTrue(restored.explicitlyEmpty)
        assertEquals("earlier", preferences["device-a_native_active_thread_claude-code"])
    }

    @Test fun changingAnotherConnectionNeverChangesTheRememberedSelection() {
        selections.save("one", null, "claude-code", "one-chat")
        selections.save("two", null, "codex", "two-chat")
        selections.save("two", null, "claude-code", "other-chat")
        val restored = selections.restore("one", null, "claude-code")
        assertEquals("one-chat", restored.threadId)
        assertFalse(restored.explicitlyEmpty)
    }
}
