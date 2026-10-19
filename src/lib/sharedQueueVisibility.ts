export function visibleQueuedMessages<T extends { id: string; deliveryState?: string }>(queue: T[], pendingRemovals?: ReadonlySet<string>): T[] {
  const visible = queue.filter((message) => message.deliveryState !== 'submitting'
    && message.deliveryState !== 'sending'
    && !pendingRemovals?.has(message.id))
  return visible.length === queue.length ? queue : visible
}

/** Keep a just-submitted message visible until the server confirms its place. */
export function mergePendingQueuedMessages<T extends { id: string; deliveryState?: string; sendAttempt?: unknown }>(
  queue: T[], pending: T[],
): T[] {
  if (pending.length === 0) return queue
  const pendingById = new Map(pending.map((message) => [message.id, message]))
  const confirmedIds = new Set(queue.map((message) => message.id))
  return [
    ...queue.map((message) => message.deliveryState === 'unverified' || message.sendAttempt
      ? message
      : pendingById.get(message.id) ?? message),
    ...pending.filter((message) => !confirmedIds.has(message.id)),
  ]
}
