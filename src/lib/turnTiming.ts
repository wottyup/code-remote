export function eventTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    const normalized = value > 10_000_000_000 ? value : value * 1000
    return Number.isNaN(new Date(normalized).getTime()) ? null : normalized
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      const normalized = numeric > 10_000_000_000 ? numeric : numeric * 1000
      return Number.isNaN(new Date(normalized).getTime()) ? null : normalized
    }
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function firstEventTimestamp(...values: unknown[]) {
  for (const value of values) {
    const timestamp = eventTimestamp(value)
    if (timestamp !== null) return timestamp
  }
  return null
}

export function latestTurnState(thread: { turns?: unknown[] }) {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const latest = turns.at(-1) as Record<string, unknown> | undefined
  const items = Array.isArray(latest?.items) ? latest.items : []
  const userMessage = [...items].reverse().find((item) => {
    if (!item || typeof item !== 'object') return false
    const type = (item as Record<string, unknown>).type
    return typeof type === 'string' && type.replace(/[-_]/g, '').toLowerCase() === 'usermessage'
  }) as Record<string, unknown> | undefined
  const status = typeof latest?.status === 'string' ? latest.status : null
  const normalizedStatus = status?.replace(/[-_]/g, '').toLowerCase()
  const running = normalizedStatus === 'inprogress' || normalizedStatus === 'running' || normalizedStatus === 'started'
  const turnId = typeof latest?.id === 'string' ? latest.id : null
  const startedAt = firstEventTimestamp(
    latest?.startedAt,
    latest?.started_at,
    latest?.startedAtMs,
    latest?.started_at_ms,
    latest?.createdAt,
    latest?.created_at,
    userMessage?.createdAt,
    userMessage?.created_at,
    userMessage?.sentAt,
    userMessage?.sent_at,
    userMessage?.timestamp,
    userMessage?.timestampMs,
    userMessage?.timestamp_ms,
  )
  return { running, hasTurn: Boolean(latest), turnId, status, startedAt }
}

export function resolveTurnStartedAt(historyStartedAt: number | null, savedStartedAt: number | undefined, fallback = Date.now()) {
  return historyStartedAt ?? savedStartedAt ?? fallback
}
