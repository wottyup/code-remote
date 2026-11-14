package com.sevencnup.devwisp

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ClaudePermissionsTest {
    private fun request(thread: String = "claude:one", id: String = "permission-1") =
        ClaudePermissionRequest(ClaudePermissionKey(thread, id), "Bash", "git status", "", "/workspace", "Read status")

    @Test fun parsesTheBackendEventAndRejectsMissingOrNonStringIdentifiers() {
        val params = JSONObject().put("threadId", "claude:one").put("permissionId", "permission-1")
            .put("toolName", "Bash").put("command", "git status").put("cwd", "/workspace").put("reason", "Read status")
        assertEquals(request(), ClaudePermissionRequest.fromJson(params))
        params.put("reason", JSONObject.NULL)
        assertEquals("", ClaudePermissionRequest.fromJson(params)?.reason)
        params.put("threadId", 123)
        assertNull(ClaudePermissionRequest.fromJson(params))
        assertNull(ClaudePermissionRequest.fromJson(JSONObject()))
    }

    @Test fun scopesRequestsAndDecisionsToTheirThreadEvenWithTheSamePermissionId() {
        val inbox = ClaudePermissionInbox()
        val one = request()
        val two = request("claude:two")
        inbox.receive(one)
        inbox.receive(two)
        assertEquals(listOf(one), inbox.forThread(one.key.threadId))
        assertEquals(listOf(two), inbox.forThread(two.key.threadId))
        inbox.resolve(one.key)
        assertTrue(inbox.forThread(one.key.threadId).isEmpty())
        assertEquals(listOf(two), inbox.forThread(two.key.threadId))
    }

    @Test fun replayDoesNotDuplicateCardsAndDoubleTapDoesNotSendTwoDecisions() {
        val inbox = ClaudePermissionInbox()
        val request = request()
        assertTrue(inbox.receive(request))
        assertFalse(inbox.receive(request))
        assertTrue(inbox.beginDecision(request.key))
        assertFalse(inbox.beginDecision(request.key))
        inbox.receive(request)
        assertTrue(inbox.isSubmitting(request.key))
        assertEquals(listOf(request), inbox.forThread(request.key.threadId))
    }

    @Test fun aFailedDecisionKeepsTheRequestAvailableForRetry() {
        val inbox = ClaudePermissionInbox()
        val request = request()
        inbox.receive(request)
        inbox.beginDecision(request.key)
        inbox.finishDecision(request.key, resolved = false)
        assertEquals(listOf(request), inbox.forThread(request.key.threadId))
        assertFalse(inbox.isSubmitting(request.key))
        assertTrue(inbox.beginDecision(request.key))
    }

    @Test fun oldRecoveryCannotResurrectAnApprovalResolvedOnAnotherDevice() {
        val inbox = ClaudePermissionInbox()
        val request = request()
        inbox.receive(request)
        val revision = inbox.revision
        inbox.resolve(request.key)
        assertFalse(inbox.reconcile(listOf(request), revision))
        assertTrue(inbox.forThread(request.key.threadId).isEmpty())
    }

    @Test fun oldRecoveryCannotEraseANewLiveRequest() {
        val inbox = ClaudePermissionInbox()
        val revision = inbox.revision
        val request = request()
        inbox.receive(request)
        assertFalse(inbox.reconcile(emptyList(), revision))
        assertEquals(listOf(request), inbox.forThread(request.key.threadId))
    }

    @Test fun recoveryAddsMissedRequestsAndRemovesRequestsThatExpiredOffline() {
        val inbox = ClaudePermissionInbox()
        val expired = request()
        val missed = request(id = "permission-2")
        inbox.receive(expired)
        assertTrue(inbox.reconcile(listOf(missed), inbox.revision))
        assertEquals(listOf(missed), inbox.forThread(missed.key.threadId))
        assertFalse(inbox.beginDecision(expired.key))
    }

    @Test fun aLateFailedHttpResponseDoesNotRestoreAnAlreadyResolvedCard() {
        val inbox = ClaudePermissionInbox()
        val request = request()
        inbox.receive(request)
        inbox.beginDecision(request.key)
        inbox.resolve(request.key)
        inbox.finishDecision(request.key, resolved = false)
        assertTrue(inbox.forThread(request.key.threadId).isEmpty())
        assertFalse(inbox.beginDecision(request.key))
    }

    @Test fun resettingTheConnectionInvalidatesItsOldSnapshotAndPendingDecision() {
        val inbox = ClaudePermissionInbox()
        val request = request()
        inbox.receive(request)
        inbox.beginDecision(request.key)
        val revision = inbox.revision
        inbox.clear()
        assertFalse(inbox.reconcile(listOf(request), revision))
        assertFalse(inbox.isSubmitting(request.key))
        assertFalse(inbox.beginDecision(request.key))
    }
}
