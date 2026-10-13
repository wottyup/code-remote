import type { CodexDocumentAttachment, CodexMessage } from './codexRemoteClient'

export function queuedRequestText(text: string, documents: CodexDocumentAttachment[] = []) {
  const documentText = documents
    .filter((document) => !document.sourceFileId)
    .map((document) => `\n\n[附件文档：${document.name}]\n${document.content}\n[/附件文档]`)
    .join('')
  return `${text}${documentText}`.trim()
}

export function sameMessageImages(left: CodexMessage['images'], right: CodexMessage['images']) {
  const leftItems = left ?? []
  const rightItems = right ?? []
  return leftItems.length === rightItems.length && leftItems.every((image, index) =>
    image.name === rightItems[index]?.name && image.previewUrl === rightItems[index]?.previewUrl,
  )
}

export function sameMessageDocuments(left: CodexMessage['documents'], right: CodexMessage['documents']) {
  const leftItems = left ?? []
  const rightItems = right ?? []
  return leftItems.length === rightItems.length && leftItems.every((document, index) =>
    document.name === rightItems[index]?.name
      && document.content === rightItems[index]?.content
      && document.charCount === rightItems[index]?.charCount
      && document.sourceFileId === rightItems[index]?.sourceFileId,
  )
}

export function sameQueuedMessageHistoryContent(message: CodexMessage, localMessage: CodexMessage) {
  if (message.role !== 'user' || message.turnId !== localMessage.turnId) return false
  const expectedText = queuedRequestText(localMessage.text, localMessage.documents)
  if (message.text !== localMessage.text && message.text !== expectedText) return false
  return sameMessageImages(message.images, localMessage.images)
    && sameMessageDocuments(message.documents, localMessage.documents)
}

export function reconcileDeliveredLocalMessage(
  messages: CodexMessage[],
  localMessageId: string,
  turnId: string,
  previousMessageIds: ReadonlySet<string>,
) {
  const localIndex = messages.findIndex((message) => message.id === localMessageId && message.role === 'user')
  if (localIndex < 0) return messages

  const localMessage = { ...messages[localIndex], turnId }
  const alreadyInHistory = messages.some((message) => message.id !== localMessageId
    && !message.id.startsWith('queued-')
    && !previousMessageIds.has(message.id)
    && sameQueuedMessageHistoryContent(message, localMessage))
  if (alreadyInHistory) return messages.filter((message) => message.id !== localMessageId)

  const next = [...messages]
  next[localIndex] = localMessage
  return next
}

export interface AttemptedQueuedMessage {
  id: string
  text: string
  images: { name: string; mediaType: string; data: string }[]
  documents?: CodexDocumentAttachment[]
  createdAt?: string
  sendAttempt?: {
    at: string
    afterTurnId?: string
    afterMessageId?: string
    inTurnId?: string
  }
}

function matchesAttemptedQueuedMessage(message: CodexMessage, queued: AttemptedQueuedMessage) {
  if (message.role !== 'user' || message.text !== queued.text) return false
  const expectedDocuments = queued.documents ?? []
  const actualDocuments = message.documents ?? []
  if (expectedDocuments.length !== actualDocuments.length || !expectedDocuments.every((document, index) =>
    document.name === actualDocuments[index]?.name
      && document.content === actualDocuments[index]?.content
      && document.sourceFileId === actualDocuments[index]?.sourceFileId,
  )) return false
  const actualImages = message.images ?? []
  return queued.images.length === actualImages.length && queued.images.every((image, index) =>
    image.name === actualImages[index]?.name
      && actualImages[index]?.previewUrl === `data:${image.mediaType};base64,${image.data}`,
  )
}

/** Confirm attempted queue items against authoritative history, never against an optimistic bubble. */
export function deliveredQueuedMessageIdsFromHistory(
  queuedMessages: readonly AttemptedQueuedMessage[],
  historyMessages: readonly CodexMessage[],
) {
  const delivered = new Set<string>()
  const claimedHistoryIndexes = new Set<number>()
  for (const queued of queuedMessages) {
    const attempt = queued.sendAttempt
    if (!attempt) continue
    const afterMessageIndex = attempt.afterMessageId
      ? historyMessages.findIndex((message) => message.id === attempt.afterMessageId)
      : -1
    let afterTurnIndex = -1
    if (attempt.afterTurnId) {
      for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
        if (historyMessages[index].turnId === attempt.afterTurnId) {
          afterTurnIndex = index
          break
        }
      }
    }
    const anchorIndex = afterMessageIndex >= 0 ? afterMessageIndex : afterTurnIndex
    const attemptedAt = Date.parse(attempt.at)
    for (let index = anchorIndex + 1; index < historyMessages.length; index += 1) {
      const message = historyMessages[index]
      if (claimedHistoryIndexes.has(index) || !matchesAttemptedQueuedMessage(message, queued)) continue
      if (attempt.inTurnId && message.turnId !== attempt.inTurnId) continue
      if (!attempt.inTurnId && attempt.afterTurnId && message.turnId === attempt.afterTurnId) continue
      if (anchorIndex < 0) {
        const messageTime = Date.parse(message.sentAt ?? message.createdAt)
        if (!Number.isFinite(attemptedAt) || !Number.isFinite(messageTime) || messageTime < attemptedAt - 2_000) continue
      }
      delivered.add(queued.id)
      claimedHistoryIndexes.add(index)
      break
    }
  }
  return delivered
}

/** Repair a queue entry produced by two submits of the same draft in one brief UI event. */
export function mightBeLegacyDuplicateQueuedMessage(
  queuedMessages: readonly AttemptedQueuedMessage[],
  visibleMessages: readonly CodexMessage[],
  waitingTurnId: string | null,
) {
  const head = queuedMessages[0]
  if (!head || head.sendAttempt || !head.createdAt) return false
  const queuedAt = Date.parse(head.createdAt)
  if (!Number.isFinite(queuedAt)) return false
  return visibleMessages.some((message) => (!waitingTurnId || !message.turnId || message.turnId === waitingTurnId)
    && message.role === 'user'
    && message.id !== head.id
    && matchesAttemptedQueuedMessage(message, head)
    && queuedAt - Date.parse(message.sentAt ?? message.createdAt) >= 0
    && queuedAt - Date.parse(message.sentAt ?? message.createdAt) <= 150)
}

export function legacyDuplicateQueuedMessageId(
  queuedMessages: readonly AttemptedQueuedMessage[],
  visibleMessages: readonly CodexMessage[],
  historyMessages: readonly CodexMessage[],
  waitingTurnId: string | null,
) {
  const head = queuedMessages[0]
  if (!head || !waitingTurnId || !mightBeLegacyDuplicateQueuedMessage(queuedMessages, visibleMessages, waitingTurnId)) return null
  return historyMessages.some((message) => message.turnId === waitingTurnId
    && matchesAttemptedQueuedMessage(message, head)) ? head.id : null
}

function sameHistoryAnchor(message: CodexMessage, candidate: CodexMessage) {
  if (message.id === candidate.id) return true
  if (message.role !== candidate.role || message.turnId !== candidate.turnId) return false
  if (message.text === candidate.text) return true
  if (message.role === 'assistant' && message.text && candidate.text) {
    return message.text.startsWith(candidate.text) || candidate.text.startsWith(message.text)
  }
  return message.role === 'user' && sameMessageImages(message.images, candidate.images)
}

export function preserveLocalQueuedMessages(next: CodexMessage[], current: CodexMessage[]) {
  const preserved = [...next]
  for (const localMessage of current) {
    if (localMessage.role !== 'user' || !localMessage.id.startsWith('queued-')) continue
    if (preserved.some((message) => message.id === localMessage.id)) continue

    const currentIndex = current.findIndex((message) => message.id === localMessage.id)
    let previousAnchor = -1
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = current[index]
      const anchorIndex = preserved.findIndex((message) => sameHistoryAnchor(message, candidate))
      if (anchorIndex >= 0) {
        previousAnchor = anchorIndex
        break
      }
    }

    if (localMessage.turnId) {
      const duplicateIndex = preserved.findIndex((message, index) => index > previousAnchor
        && sameQueuedMessageHistoryContent(message, localMessage))
      if (duplicateIndex >= 0) continue
    }

    let insertionIndex = -1
    for (let index = currentIndex + 1; index < current.length; index += 1) {
      const candidate = current[index]
      const anchorIndex = preserved.findIndex((message) => sameHistoryAnchor(message, candidate))
      if (anchorIndex >= 0) {
        insertionIndex = anchorIndex
        break
      }
    }
    if (insertionIndex < 0) insertionIndex = previousAnchor >= 0 ? previousAnchor + 1 : preserved.length
    preserved.splice(insertionIndex, 0, localMessage)
  }
  return preserved
}
