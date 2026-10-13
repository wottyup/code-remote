export function visibleQueuedMessages<T extends { id: string }>(queue: T[], pendingRemovals?: ReadonlySet<string>): T[] {
  if (!pendingRemovals?.size) return queue
  return queue.filter((message) => !pendingRemovals.has(message.id))
}
