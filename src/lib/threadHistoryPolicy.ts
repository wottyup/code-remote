export interface ThreadHistoryMetadata {
  updatedAt?: number | string
  historyRevision?: string
  status?: { type?: string }
}

export interface CachedThreadHistoryMetadata extends ThreadHistoryMetadata {
  complete: boolean
  running: boolean
}

function timestamp(value: number | string | undefined) {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') return Date.parse(value) || 0
  return 0
}

function threadIsRunning(thread: ThreadHistoryMetadata) {
  return ['active', 'inProgress', 'running', 'started'].includes(thread.status?.type ?? '')
}

export function threadHistoryVersionChanged(cached: ThreadHistoryMetadata, latest: ThreadHistoryMetadata) {
  if (latest.historyRevision) return cached.historyRevision !== latest.historyRevision
  // List previews and history previews can describe different messages. They
  // must never be used as a content version for an otherwise unchanged thread.
  return timestamp(latest.updatedAt) > timestamp(cached.updatedAt)
}

export function canUseCachedThreadHistory(
  cached: CachedThreadHistoryMetadata,
  latestThread: ThreadHistoryMetadata | undefined,
  metadataLoaded: boolean,
  hasQueuedMessages: boolean,
) {
  if (!cached.complete || !metadataLoaded || hasQueuedMessages || cached.running || !latestThread || threadIsRunning(latestThread)) return false
  if (latestThread.historyRevision) return cached.historyRevision === latestThread.historyRevision
  if (latestThread.updatedAt === undefined || cached.updatedAt === undefined) return false
  const latestUpdatedAt = timestamp(latestThread.updatedAt)
  const cachedUpdatedAt = timestamp(cached.updatedAt)
  return latestUpdatedAt > 0 && cachedUpdatedAt >= latestUpdatedAt
}
