export function streamingAssistantText(parts: ReadonlyMap<string, string>) {
  // Keep the same paragraph boundaries as restored history when a turn
  // contains multiple commentary and final-answer items.
  return [...parts.values()].filter(Boolean).join('\n\n')
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
