/** Remember lifecycle facts so delayed snapshots/events cannot revive a finished turn. */
export class ThreadLiveHistory {
  private finished = new Map<string, { status: string; completedAt?: unknown }>()
  private started = new Map<string, string>()

  private key(threadId: string, turnId: string) { return `${threadId}:${turnId}` }

  isFinished(threadId: string, turnId: string | null) {
    return Boolean(turnId && this.finished.has(this.key(threadId, turnId)))
  }

  start(threadId: string, turnId: string) {
    if (this.isFinished(threadId, turnId)) return false
    this.started.set(threadId, turnId)
    return true
  }

  finish(threadId: string, turnId: string, status = 'completed', completedAt?: unknown) {
    this.finished.set(this.key(threadId, turnId), { status, completedAt })
    if (this.started.get(threadId) === turnId) this.started.delete(threadId)
    while (this.finished.size > 2048) this.finished.delete(this.finished.keys().next().value!)
  }

  reconcile<T extends { id: string; turns?: unknown[]; status?: { type?: string } }>(thread: T): T | null {
    const turns = (thread.turns ?? []) as Record<string, unknown>[]
    const waitingFor = this.started.get(thread.id)
    // A turn/started notification can arrive before its first disk record.
    if (waitingFor && !turns.some((turn) => turn.id === waitingFor)) return null
    if (waitingFor) this.started.delete(thread.id)
    let changed = false
    const reconciled = turns.map((turn) => {
      const turnId = typeof turn.id === 'string' ? turn.id : null
      if (!turnId) return turn
      if (['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(String(turn.status).toLowerCase())) {
        this.finish(thread.id, turnId, String(turn.status), turn.completedAt)
        return turn
      }
      const finished = this.finished.get(this.key(thread.id, turnId))
      if (!finished) return turn
      changed = true
      return { ...turn, status: finished.status, ...(finished.completedAt == null ? {} : { completedAt: finished.completedAt }) }
    })
    return changed ? { ...thread, turns: reconciled, status: { type: String(reconciled.at(-1)?.status ?? 'idle') } } : thread
  }
}
