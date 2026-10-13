export function eventTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    const normalized = value > 10_000_000_000 ? value : value * 1000
    return Number.isNaN(new Date(normalized).getTime()) ? null : normalized
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function latestTurnState(thread: { turns?: unknown[] }) {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const latest = turns.at(-1) as Record<string, unknown> | undefined
  const status = typeof latest?.status === 'string' ? latest.status : null
  const normalizedStatus = status?.replace(/[-_]/g, '').toLowerCase()
  const running = normalizedStatus === 'inprogress' || normalizedStatus === 'running' || normalizedStatus === 'started'
  const turnId = typeof latest?.id === 'string' ? latest.id : null
  return { running, hasTurn: Boolean(latest), turnId, status, startedAt: eventTimestamp(latest?.startedAt) }
}

export function resolveTurnStartedAt(historyStartedAt: number | null, savedStartedAt: number | undefined, fallback = Date.now()) {
  return historyStartedAt ?? savedStartedAt ?? fallback
}
