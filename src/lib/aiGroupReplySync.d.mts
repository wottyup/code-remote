export function advanceGroupReplyWait(state: {
  pending: boolean
  isRunning: boolean
  runningTurnId: string | null
  runningObserved: boolean
  finalReplyCaptured: boolean
}): {
  runningObserved: boolean
  completed: boolean
}
