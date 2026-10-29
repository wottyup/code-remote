import type { CodexMessage } from './codexRemoteClient'

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
    if (earlierItemIds.has(item.id)) continue
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

function mergeStreamingText(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  // A thread/read snapshot can overlap with the deltas already received on
  // the socket. Reuse that overlap instead of rendering the shared prefix as
  // a second assistant bubble.
  const maxOverlap = Math.min(current.length, incoming.length)
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (current.endsWith(incoming.slice(0, length))) return current + incoming.slice(length)
  }
  return current + incoming
}

function assistantMessagesForStreamSegment(messages: CodexMessage[], turnId: string | null, messageId: string) {
  let latestUserIndex = -1
  messages.forEach((message, index) => {
    // Accepted sends can appear before their turn receipt. They still close
    // the preceding reply, even while their turn ID is unknown.
    if (message.role === 'user') latestUserIndex = index
  })
  const exactIndex = messages.findIndex((message) => message.role === 'assistant' && message.id === messageId)
  // A queued render from before the user's answer belongs to a closed segment.
  if (exactIndex >= 0) return exactIndex > latestUserIndex ? [messages[exactIndex]] : null
  if (!turnId) return []
  return messages.filter((message, index) => message.role === 'assistant'
    && message.turnId === turnId
    && index > latestUserIndex)
}

export function collapseAssistantMessagesForTurn(
  messages: CodexMessage[],
  turnId: string | null,
  messageId: string,
  incomingText: string,
  replyStartedAt?: string,
  completedText = '',
) {
  // The normal streaming path only changes the last assistant bubble. Avoid
  // searching/merging the whole history for every rendered text chunk.
  const tail = messages.at(-1)
  if (tail?.role === 'assistant' && tail.id === messageId && tail.streaming && (!turnId || tail.turnId === turnId)) {
    const text = mergeStreamingText(tail.text, incomingText)
    const completedTextLength = completedAssistantTextLength(text, completedText, tail.completedTextLength)
    if (text === tail.text && completedTextLength === tail.completedTextLength && (tail.replyStartedAt || !replyStartedAt)) return messages
    return [
      ...messages.slice(0, -1),
      { ...tail, text, completedTextLength, ...(tail.replyStartedAt || !replyStartedAt ? {} : { replyStartedAt }) },
    ]
  }
  const matching = assistantMessagesForStreamSegment(messages, turnId, messageId)
  if (!matching) return messages
  const text = mergeStreamingText(matching.reduce((text, message) => mergeStreamingText(text, message.text), ''), incomingText)
  if (matching.length === 0 && !text) return messages

  const source = matching.find((message) => message.id === messageId) ?? matching.at(-1)
  const matchingIds = new Set(matching.map((message) => message.id))
  const merged: CodexMessage = {
    ...(source ?? {}),
    id: messageId,
    role: 'assistant',
    text,
    createdAt: source?.createdAt ?? new Date().toISOString(),
    ...((source?.replyStartedAt ?? replyStartedAt) ? { replyStartedAt: source?.replyStartedAt ?? replyStartedAt } : {}),
    streaming: true,
    completedTextLength: completedAssistantTextLength(text, completedText, source?.completedTextLength),
    ...(turnId ? { turnId } : {}),
  }
  let inserted = false
  const next = messages.flatMap((message) => {
    if (!matchingIds.has(message.id)) return [message]
    if (inserted) return []
    inserted = true
    return [merged]
  })
  return inserted ? next : [...next, merged]
}
