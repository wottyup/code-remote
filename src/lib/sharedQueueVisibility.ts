export function visibleQueuedMessages<T extends { id: string; deliveryState?: string }>(queue: T[], pendingRemovals?: ReadonlySet<string>): T[] {
  const visible = queue.filter((message) => message.deliveryState !== 'submitting'
    && message.deliveryState !== 'sending'
    && !pendingRemovals?.has(message.id))
  return visible.length === queue.length ? queue : visible
}
