export function streamingAssistantText(parts: ReadonlyMap<string, string>) {
  // Keep the same paragraph boundaries as restored history when a turn
  // contains multiple commentary and final-answer items.
  return [...parts.values()].filter(Boolean).join('\n\n')
}

export interface AssistantStreamSnapshotItem {
  id: string
  text: string
  complete: boolean
}

export function reconcileAssistantStreamSnapshot(
  snapshotItems: readonly AssistantStreamSnapshotItem[],
  liveParts: ReadonlyMap<string, string>,
  completedItems: ReadonlySet<string>,
  earlierItemIds: ReadonlySet<string>,
) {
  // A page can join mid-turn. Rebuild in history item order so a late socket
  // segment never gets appended after its own copy in the snapshot.
  const parts = new Map<string, string>()
  const completed = new Set<string>()
  for (const item of snapshotItems) {
    const live = liveParts.get(item.id)
    let text = item.text
    if (live !== undefined && (live.startsWith(item.text)
      || (!item.text.startsWith(live) && completedItems.has(item.id)))) {
      text = live
    }
    parts.set(item.id, text)
    if (completedItems.has(item.id) || (item.complete && text === item.text)) completed.add(item.id)
  }
  for (const [itemId, text] of liveParts) {
    if (!parts.has(itemId) && !earlierItemIds.has(itemId)) parts.set(itemId, text)
  }
  for (const itemId of completedItems) {
    if (parts.has(itemId)) completed.add(itemId)
  }
  return { parts, completed }
}

export function completedAssistantText(parts: ReadonlyMap<string, string>, completedItems: ReadonlySet<string>) {
  const completed: string[] = []
  for (const [itemId, text] of parts) {
    if (!text) continue
    // A later completed item must not expose an earlier partial question.
    if (!completedItems.has(itemId)) break
    completed.push(text)
  }
  return completed.join('\n\n')
}

export function completedAssistantTextLength(text: string, completedText: string, previousLength = 0) {
  const offset = completedText ? text.indexOf(completedText) : -1
  return Math.min(text.length, Math.max(previousLength, offset < 0 ? 0 : offset + completedText.length))
}
