export interface ThreadHistoryMetadata {
  updatedAt?: number | string
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
  return thread.status?.type === 'inProgress' || thread.status?.type === 'running'
}

export function canUseCachedThreadHistory(
  cached: CachedThreadHistoryMetadata,
  latestThread: ThreadHistoryMetadata | undefined,
  metadataLoaded: boolean,
  hasQueuedMessages: boolean,
) {
  if (!cached.complete || !metadataLoaded || hasQueuedMessages || cached.running || !latestThread || threadIsRunning(latestThread)) return false
  if (latestThread.updatedAt === undefined || cached.updatedAt === undefined) return false
  const latestUpdatedAt = timestamp(latestThread.updatedAt)
  const cachedUpdatedAt = timestamp(cached.updatedAt)
  return latestUpdatedAt > 0 && cachedUpdatedAt >= latestUpdatedAt
}
