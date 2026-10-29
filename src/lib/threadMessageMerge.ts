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

const delayedUserEchoWindowMs = 120_000

function sameUserMessagePayload(left: CodexMessage, right: CodexMessage) {
  if (left.role !== 'user' || right.role !== 'user') return false
  const leftRequestText = queuedRequestText(left.text, left.documents)
  const rightRequestText = queuedRequestText(right.text, right.documents)
  if (left.text !== right.text && left.text !== rightRequestText && right.text !== leftRequestText) return false
  const leftImages = left.images ?? []
  const rightImages = right.images ?? []
  if (leftImages.length !== rightImages.length || !leftImages.every((image, index) =>
    image.previewUrl === rightImages[index]?.previewUrl,
  )) return false
  const leftDocuments = left.documents ?? []
  const rightDocuments = right.documents ?? []
  return leftDocuments.length === rightDocuments.length && leftDocuments.every((document, index) =>
    document.name === rightDocuments[index]?.name
      && document.content === rightDocuments[index]?.content
      && document.sourceFileId === rightDocuments[index]?.sourceFileId,
  )
}

function delayedUserEchoDistance(incoming: CodexMessage, localMessage: CodexMessage) {
  if (!localMessage.id.startsWith('queued-') || localMessage.sourceItemId) return null
  if (incoming.turnId && localMessage.turnId && incoming.turnId !== localMessage.turnId) return null
  if (!sameUserMessagePayload(incoming, localMessage)) return null
  const incomingAt = Date.parse(incoming.sentAt ?? incoming.createdAt)
  const localAt = Date.parse(localMessage.sentAt ?? localMessage.createdAt)
  if (!Number.isFinite(incomingAt) || !Number.isFinite(localAt)) return null
  const distance = Math.abs(incomingAt - localAt)
  return distance <= delayedUserEchoWindowMs ? distance : null
}

export function sameQueuedMessageHistoryContent(message: CodexMessage, localMessage: CodexMessage) {
  if (message.role !== 'user' || message.turnId !== localMessage.turnId) return false
  const expectedText = queuedRequestText(localMessage.text, localMessage.documents)
  if (message.text !== localMessage.text && message.text !== expectedText) return false
  return sameMessageImages(message.images, localMessage.images)
    && sameMessageDocuments(message.documents, localMessage.documents)
}

/** Insert a user item received from the live socket without waiting for thread/read. */
export function insertRemoteUserMessage(messages: CodexMessage[], incoming: CodexMessage) {
  if (incoming.role !== 'user' || !incoming.sourceItemId) return messages
  if (messages.some((message) => message.id === incoming.sourceItemId
    || message.sourceItemId === incoming.sourceItemId)) return messages

  // Prefer replacing an optimistic steer bubble with the canonical live item
  // when both messages share a turn and payload.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message.id.startsWith('queued-') || message.sourceItemId || !sameQueuedMessageHistoryContent(incoming, message)) continue
    const next = [...messages]
    next[index] = {
      ...incoming,
      ...(!incoming.sentAt && message.sentAt ? { sentAt: message.sentAt } : {}),
      ...(!incoming.createdAt && message.createdAt ? { createdAt: message.createdAt } : {}),
    }
    return next
  }

  // A delayed socket echo may not have the same turn ID yet. Match the nearest
  // optimistic bubble by payload and timestamp, then attach the canonical ID.
  let localEchoIndex = -1
  let localEchoDistance = Number.POSITIVE_INFINITY
  messages.forEach((message, index) => {
    const distance = delayedUserEchoDistance(incoming, message)
    if (distance === null || distance >= localEchoDistance) return
    localEchoIndex = index
    localEchoDistance = distance
  })
  if (localEchoIndex >= 0) {
    return messages.map((message, index) => index === localEchoIndex
      ? {
        ...message,
        sourceItemId: incoming.sourceItemId,
        ...(message.turnId || !incoming.turnId ? {} : { turnId: incoming.turnId }),
      }
      : message)
  }

  const hasEarlierUserInTurn = Boolean(incoming.turnId && messages.some((message) =>
    message.role === 'user' && message.turnId === incoming.turnId,
  ))
  if (!hasEarlierUserInTurn) {
    const assistantIndex = messages.findIndex((message) => message.role === 'assistant'
      && (incoming.turnId ? message.turnId === incoming.turnId : message.streaming))
    if (assistantIndex >= 0) {
      return [...messages.slice(0, assistantIndex), incoming, ...messages.slice(assistantIndex)]
    }
  }
  return [...messages, incoming]
}

/** Only a new user item splits the reply; an echo of a local send does not. */
export function startsNewAssistantStreamSegment(messages: CodexMessage[], incoming: CodexMessage) {
  return Boolean(incoming.turnId
    && messages.some((message) => message.role === 'user' && message.turnId === incoming.turnId)
    && insertRemoteUserMessage(messages, incoming).length > messages.length)
}

/** Include accepted user items whose React updates have not committed yet. */
export function mergeObservedUserMessages(messages: CodexMessage[], observed: Iterable<CodexMessage>) {
  let next = messages
  const knownIds = new Set(messages.flatMap((message) => message.sourceItemId
    ? [message.id, message.sourceItemId] : [message.id]))
  for (const message of observed) {
    if (knownIds.has(message.sourceItemId ?? message.id)) continue
    if (message.sourceItemId) next = insertRemoteUserMessage(next, message)
    else next = [...next, message]
    knownIds.add(message.id)
    if (message.sourceItemId) knownIds.add(message.sourceItemId)
  }
  return next
}

export function reconcileDeliveredLocalMessage(
  messages: CodexMessage[],
  localMessageId: string,
  turnId: string | null,
  previousMessageIds: ReadonlySet<string>,
) {
  const localIndex = messages.findIndex((message) => message.id === localMessageId && message.role === 'user')
  if (localIndex < 0) return messages

  const localMessage = { ...messages[localIndex], ...(turnId ? { turnId } : {}) }
  const alreadyInHistory = messages.some((message) => message.id !== localMessageId
    && !message.id.startsWith('queued-')
    && !previousMessageIds.has(message.id)
    && !(message.sourceItemId && previousMessageIds.has(message.sourceItemId))
    && (localMessage.turnId
      ? sameQueuedMessageHistoryContent(message, localMessage)
      : delayedUserEchoDistance(message, localMessage) !== null))
  if (alreadyInHistory) return messages.filter((message) => message.id !== localMessageId)

  const next = [...messages]
  next[localIndex] = localMessage
  return next
}

/** The socket may confirm the user item before the HTTP send returns. */
export function insertDeliveredLocalMessage(
  messages: CodexMessage[],
  localMessage: CodexMessage,
  previousMessageIds: ReadonlySet<string>,
) {
  const existingIndex = messages.findIndex((message) => message.id === localMessage.id)
  const next = existingIndex < 0
    ? [...messages, localMessage]
    : messages.map((message, index) => index === existingIndex ? { ...message, ...localMessage } : message)
  return reconcileDeliveredLocalMessage(next, localMessage.id, localMessage.turnId ?? null, previousMessageIds)
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
  if (message.sourceItemId && (message.sourceItemId === candidate.id || message.sourceItemId === candidate.sourceItemId)) return true
  if (candidate.sourceItemId && (candidate.sourceItemId === message.id || candidate.sourceItemId === message.sourceItemId)) return true
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
    if (localMessage.role !== 'user' || (!localMessage.id.startsWith('queued-') && !localMessage.sourceItemId)) continue
    if (preserved.some((message) => message.id === localMessage.id)) continue
    if (localMessage.sourceItemId && preserved.some((message) => message.id === localMessage.sourceItemId
      || message.sourceItemId === localMessage.sourceItemId)) continue

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

    const duplicateIndex = preserved.findIndex((message, index) => index > previousAnchor
      && ((localMessage.turnId && sameQueuedMessageHistoryContent(message, localMessage))
        || delayedUserEchoDistance(message, localMessage) !== null))
    if (duplicateIndex >= 0) continue

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

/** A snapshot without an already visible in-turn answer must not hydrate its old reply. */
export function historyMissingCurrentUserMessages(snapshot: CodexMessage[], current: CodexMessage[], turnId: string | null) {
  if (!turnId) return false
  const snapshotIds = new Set(snapshot.map((message) => message.id))
  return preserveLocalQueuedMessages(snapshot, current).some((message) => message.role === 'user'
    && (!message.turnId || message.turnId === turnId) && !snapshotIds.has(message.id))
}
