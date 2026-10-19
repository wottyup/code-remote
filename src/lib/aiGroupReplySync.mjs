/**
 * Track whether a group member has entered a server-confirmed turn.
 * `isRunning` may be an optimistic client state, while `runningTurnId` only
 * appears after the backend confirms that the member's turn has started.
 */
export function advanceGroupReplyWait({ pending, isRunning, runningTurnId, runningObserved, finalReplyCaptured }) {
  const confirmedRunning = Boolean(runningTurnId)
  const hasObservedRunning = runningObserved || (pending && confirmedRunning)
  const completed = pending
    && !isRunning
    && !confirmedRunning
    && (hasObservedRunning || finalReplyCaptured)

  return {
    runningObserved: completed ? false : hasObservedRunning,
    completed,
  }
}
