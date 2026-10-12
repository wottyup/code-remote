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
