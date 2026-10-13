export interface QueueRecoveryBarrier {
  turnId: string | null
  status: 'unverified' | 'running' | 'interrupted'
}

export type QueueRecoveryBarriers = Record<string, QueueRecoveryBarrier>

export interface QueueTurnState {
  running: boolean
  hasTurn: boolean
  turnId: string | null
  status?: string | null
}

export function restoreQueueRecoveryBarriers(value: unknown, queuedThreadIds: string[]): QueueRecoveryBarriers {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const barriers: QueueRecoveryBarriers = {}
  for (const threadId of queuedThreadIds) {
    const candidate = parsed[threadId]
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const barrier = candidate as Record<string, unknown>
      const status = barrier.status
      barriers[threadId] = {
        turnId: typeof barrier.turnId === 'string' ? barrier.turnId : null,
        status: status === 'running' || status === 'interrupted' ? status : 'unverified',
      }
    } else {
      // Queues written by older clients did not record which turn they wait for.
      barriers[threadId] = { turnId: null, status: 'unverified' }
    }
  }
  return barriers
}

export function reconcileQueueRecoveryBarrier(
  current: QueueRecoveryBarrier | undefined,
  turn: QueueTurnState,
  hasQueuedMessages: boolean,
): QueueRecoveryBarrier | null {
  if (!hasQueuedMessages) return null
  if (turn.running) {
    return { turnId: turn.turnId ?? current?.turnId ?? null, status: 'running' }
  }
  if (current?.status !== 'unverified' && current?.turnId && current.turnId !== turn.turnId) {
    return { turnId: current.turnId, status: 'interrupted' }
  }
  if (!turn.hasTurn) return null

  const status = typeof turn.status === 'string' ? turn.status.replace(/[-_]/g, '').toLowerCase() : ''
  if (status === 'completed' || status === 'complete' || status === 'success') return null
  return { turnId: turn.turnId ?? current?.turnId ?? null, status: 'interrupted' }
}

export function completionReleasesQueueBarrier(
  barrier: QueueRecoveryBarrier | undefined,
  completedTurnId: string | null,
  completedNormally: boolean,
): boolean {
  if (!completedNormally) return false
  if (!barrier) return true
  return barrier.status !== 'unverified' && Boolean(barrier.turnId && completedTurnId && barrier.turnId === completedTurnId)
}

export function canAutomaticallyAdvanceQueue(
  barrier: QueueRecoveryBarrier | undefined,
  activeTurnId: string | null,
): boolean {
  return !barrier && !activeTurnId
}
