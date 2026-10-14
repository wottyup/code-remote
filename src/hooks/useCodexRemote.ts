import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import {
  codexRemoteClient,
  isAmbiguousNetworkFailure,
  messagesFromThread,
  RemoteApiError,
  threadContainsNewPayload,
  userMessageFromEventItem,
  type CodexDocumentAttachment,
  type CodexImageAttachment,
  type CodexMessage,
  type CodexModel,
  type CodexApprovalPolicy,
  type CodexRuntime,
  type CodexThread,
  type CodexThreadDetails,
  type RemoteEvent,
} from '../lib/codexRemoteClient'
import { deliveredQueuedMessageIdsFromHistory, insertRemoteUserMessage, legacyDuplicateQueuedMessageId, mightBeLegacyDuplicateQueuedMessage, preserveLocalQueuedMessages, queuedRequestText, reconcileDeliveredLocalMessage, sameMessageDocuments, sameMessageImages, sameQueuedMessageHistoryContent } from '../lib/threadMessageMerge'
import { canUseCachedThreadHistory } from '../lib/threadHistoryPolicy'
import { readThreadHistoryCache, serializedCacheSizeBytes, threadHistoryCacheMaxBytes, threadHistoryCacheMaxEntries, writeThreadHistoryCache } from '../lib/threadHistoryStorage'
import { eventTimestamp, latestTurnState, resolveTurnStartedAt } from '../lib/turnTiming'
import { canAutomaticallyAdvanceQueue, completionReleasesQueueBarrier, reconcileQueueRecoveryBarrier, restoreQueueRecoveryBarriers, type QueueRecoveryBarrier, type QueueRecoveryBarriers } from '../lib/queueRecovery'
import { visibleQueuedMessages } from '../lib/sharedQueueVisibility'

interface ApprovalRequest {
  requestId: string | number
  method: string
  params: Record<string, unknown>
}

export interface CodexActivity {
  label: string
  detail?: string
}

export type CodexOperationStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface CodexOperation {
  id: string
  kind: 'command' | 'file' | 'search' | 'tool'
  label: string
  detail?: string
  status: CodexOperationStatus
}

export interface CodexThreadCompletion {
  threadId: string
  completedAt: number
}

export interface CodexFileChangeEntry {
  path: string
  kind?: string
  diff?: string
  additions: number
  deletions: number
}

export interface CodexFileChange {
  id: string
  status: 'inProgress' | 'completed'
  changes: CodexFileChangeEntry[]
}

export interface QueuedTurnMessage {
  id: string
  text: string
  images: CodexImageAttachment[]
  documents?: CodexDocumentAttachment[]
  createdAt: string
  editing?: boolean
  deliveryState?: 'submitting' | 'pending' | 'sending' | 'unverified'
  blockedReason?: string
  sendAttempt?: {
    at: string
    afterTurnId?: string
    afterMessageId?: string
    inTurnId?: string
  }
}

interface QueuedTurnPayload extends QueuedTurnMessage {
  requestText: string
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
}

interface SendMessageInput {
  prompt: string
  images: CodexImageAttachment[]
  documents?: CodexDocumentAttachment[]
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
  onThreadCreated?: (thread: CodexThread) => void
}

interface PendingTurnDelivery {
  threadId: string
  turnId: string | null
  acknowledged: boolean
  completedTurnIds: Set<string>
  previousMessageIds: ReadonlySet<string>
  resolveReceipt?: (result: { turn_id: string | null; completed: boolean }) => void
}

type FileChangesByTurn = Record<string, CodexFileChange[]>
type OperationsByTurn = Record<string, CodexOperation[]>
type QueuedMessagesByThread = Record<string, QueuedTurnPayload[]>

const emptyQueuedMessages: QueuedTurnMessage[] = []

const emptyRuntime: CodexRuntime = { available: false, connected: false, workspace: '', handedOff: false, runtimeMode: 'direct', runtimeMessage: null, fallbackReason: null, error: null }
const activeWriterError = '这条对话正被另一个 Codex 实例使用。可查看历史，待原实例结束后再发送。'
const activeThreadStorageKey = 'codex-remote.active-thread-id'
const activeThreadCacheStorageKey = 'codex-remote.active-thread-cache'
const queuedMessagesStorageKey = 'codex-remote.queued-messages'
const queuedRecoveryStorageKey = 'codex-remote.queued-message-recovery'
const queuedThreadStateChangedEvent = 'codex-remote.queued-thread-state-changed'
const sharedQueueAuthoritative = true
const activeQueueControllers = new Map<string, Set<string>>()

function threadHasAnotherActiveController(threadId: string, controllerId: string) {
  return [...(activeQueueControllers.get(threadId) ?? [])].some((owner) => owner !== controllerId)
}
const maxCachedHistoryCharacters = 600_000
const maxCachedMessageCharacters = 120_000
const maxInMemoryThreadCacheEntries = 6
const maxInMemoryThreadCacheCharacters = 1_200_000
const maxBackgroundPrefetchThreads = 3
const backgroundPrefetchDelayMs = 120
const cachedActiveThreadRefreshDelayMs = 180
const persistentThreadCacheWriteDelayMs = 600
const persistentThreadCacheVersion = 1
const threadMetadataFreshnessMs = 30_000
const streamingRenderIntervalMs = 48
const maxPersistedQueuedStorageCharacters = 3_500_000
const maxPersistedQueuedThreads = 24
const maxPersistedQueuedMessagesPerThread = 30
const maxPersistedQueuedTextCharacters = 240_000

interface PersistedActiveThread {
  threadId: string
  thread: CodexThread
  messages: CodexMessage[]
}

interface ThreadCacheEntry {
  thread: CodexThread
  messages: CodexMessage[]
  fileChangesByTurn: FileChangesByTurn
  operationsByTurn: OperationsByTurn
  running: boolean
  turnId: string | null
  characters: number
  complete: boolean
}

interface PersistedThreadCacheSnapshot {
  version: typeof persistentThreadCacheVersion
  entry: ThreadCacheEntry
}

export interface UseCodexRemoteOptions {
  /** Keep the existing single-pane conversation in localStorage. */
  persistActiveThread?: boolean
  /** Keep the socket and background requests closed while a pane is hidden. */
  enabled?: boolean
  /** Keep list/model/history warm-up work in the primary controller only. */
  loadThreads?: boolean
  loadModels?: boolean
  /** Explicit opt-in; each prefetch downloads the entire conversation history. */
  prefetchHistory?: boolean
}

function readPersistedActiveThreadId() {
  try {
    const threadId = window.localStorage.getItem(activeThreadStorageKey)?.trim()
    return threadId || null
  } catch {
    return null
  }
}

function persistActiveThreadId(threadId: string) {
  try {
    window.localStorage.setItem(activeThreadStorageKey, threadId)
  } catch {
    // The current conversation remains available until the page is closed.
  }
}

function readPersistedActiveThreadCache(threadId: string | null): PersistedActiveThread | null {
  if (!threadId) return null
  try {
    const value = window.localStorage.getItem(activeThreadCacheStorageKey)
    if (!value) return null
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (parsed.threadId !== threadId || !parsed.thread || typeof parsed.thread !== 'object' || !Array.isArray(parsed.messages)) return null
    const thread = parsed.thread as Record<string, unknown>
    if (thread.id !== threadId) return null
    const messages = parsed.messages.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const message = value as Record<string, unknown>
      if (typeof message.id !== 'string' || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string' || typeof message.createdAt !== 'string') return []
      return [{
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(typeof message.sentAt === 'string' ? { sentAt: message.sentAt } : {}),
        ...(typeof message.replyStartedAt === 'string' ? { replyStartedAt: message.replyStartedAt } : {}),
        ...(typeof message.replyDurationMs === 'number' && Number.isFinite(message.replyDurationMs) && message.replyDurationMs >= 0
          ? { replyDurationMs: message.replyDurationMs }
          : {}),
        ...(typeof message.turnId === 'string' ? { turnId: message.turnId } : {}),
      } as CodexMessage]
    })
    return { threadId, thread: thread as unknown as CodexThread, messages }
  } catch {
    return null
  }
}

function compactThread(thread: CodexThread): CodexThread {
  return {
    id: thread.id,
    ...(thread.name !== undefined ? { name: thread.name } : {}),
    ...(thread.preview !== undefined ? { preview: thread.preview } : {}),
    ...(thread.cwd !== undefined ? { cwd: thread.cwd } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.status !== undefined ? { status: thread.status } : {}),
  }
}

function persistActiveThreadCache(thread: CodexThread, messages: CodexMessage[]) {
  try {
    const cachedMessages: CodexMessage[] = []
    let cachedCharacters = 0
    for (const message of [...messages].reverse()) {
      const text = message.text.length > maxCachedMessageCharacters
        ? `${message.text.slice(0, maxCachedMessageCharacters - 1)}…`
        : message.text
      const compactMessage = {
        id: message.id,
        role: message.role,
        text,
        createdAt: message.createdAt,
        ...(message.sentAt ? { sentAt: message.sentAt } : {}),
        ...(message.replyStartedAt ? { replyStartedAt: message.replyStartedAt } : {}),
        ...(message.replyDurationMs !== undefined ? { replyDurationMs: message.replyDurationMs } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
      } as CodexMessage
      const messageCharacters = text.length + 128
      if (cachedMessages.length > 0 && cachedCharacters + messageCharacters > maxCachedHistoryCharacters) break
      cachedMessages.unshift(compactMessage)
      cachedCharacters += messageCharacters
    }
    window.localStorage.setItem(activeThreadCacheStorageKey, JSON.stringify({
      threadId: thread.id,
      thread: compactThread(thread),
      messages: cachedMessages,
    }))
  } catch {
    // Cached history is an optimization; the server remains the source of truth.
  }
}

function cachedMessageCharacters(message: CodexMessage) {
  const imageCharacters = message.images?.reduce((total, image) => total + image.name.length + image.previewUrl.length, 0) ?? 0
  const documentCharacters = message.documents?.reduce((total, document) => total + document.name.length + document.content.length, 0) ?? 0
  return message.text.length + imageCharacters + documentCharacters + 128
}

function cachedHistoryCharacters(messages: CodexMessage[]) {
  return messages.reduce((total, message) => total + cachedMessageCharacters(message), 0)
}

function isThreadCacheEntry(value: unknown, threadId: string): value is ThreadCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  const thread = entry.thread
  const messagesValid = Array.isArray(entry.messages) && entry.messages.every((value) => {
    if (!value || typeof value !== 'object') return false
    const message = value as Record<string, unknown>
    const imagesValid = message.images === undefined || (Array.isArray(message.images) && message.images.every((image) => {
      if (!image || typeof image !== 'object') return false
      const record = image as Record<string, unknown>
      return typeof record.name === 'string' && typeof record.previewUrl === 'string'
    }))
    const documentsValid = message.documents === undefined || (Array.isArray(message.documents) && message.documents.every((document) => {
      if (!document || typeof document !== 'object') return false
      const record = document as Record<string, unknown>
      return typeof record.name === 'string' && typeof record.content === 'string'
    }))
    return typeof message.id === 'string'
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.text === 'string'
      && typeof message.createdAt === 'string'
      && imagesValid
      && documentsValid
  })
  return Boolean(
    thread && typeof thread === 'object' && (thread as Record<string, unknown>).id === threadId
    && messagesValid
    && entry.fileChangesByTurn && typeof entry.fileChangesByTurn === 'object' && !Array.isArray(entry.fileChangesByTurn)
    && entry.operationsByTurn && typeof entry.operationsByTurn === 'object' && !Array.isArray(entry.operationsByTurn)
    && typeof entry.running === 'boolean'
    && (entry.turnId === null || typeof entry.turnId === 'string')
    && typeof entry.characters === 'number' && Number.isFinite(entry.characters) && entry.characters >= 0
    && entry.complete === true,
  )
}

function threadTimestamp(thread: CodexThread) {
  const value = thread.updatedAt ?? thread.createdAt
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') return Date.parse(value) || 0
  return 0
}

function threadIsRunning(thread: CodexThread) {
  return thread.status?.type === 'inProgress' || thread.status?.type === 'running'
}

function cachedHistoryMatchesThreadMetadata(entry: ThreadCacheEntry, latestThread: CodexThread | undefined, metadataLoaded: boolean, hasQueuedMessages: boolean) {
  return canUseCachedThreadHistory({
    complete: entry.complete,
    running: entry.running,
    updatedAt: entry.thread.updatedAt,
  }, latestThread, metadataLoaded, hasQueuedMessages)
}

function sendFailureMessage(reason: unknown) {
  if (isAmbiguousNetworkFailure(reason)) {
    return '连接中断，无法确认消息是否送达。草稿已保留；恢复后先检查对话记录，再决定是否重试。'
  }
  return reason instanceof Error ? reason.message : '发送消息失败'
}

function isActiveWriterError(reason: unknown) {
  return reason instanceof Error && /active writer/i.test(reason.message)
}

function queuedMessageId() {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function streamingMessageId(turnId: string | null) {
  return `streaming-assistant-${turnId ?? 'turn'}-${queuedMessageId()}`
}

function queuedPayloadFromInput(input: SendMessageInput): QueuedTurnPayload {
  const text = input.prompt.trim()
  const documents = input.documents ?? []
  return {
    id: queuedMessageId(),
    text,
    requestText: queuedRequestText(text, documents),
    images: input.images,
    ...(documents.length > 0 ? { documents } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    createdAt: new Date().toISOString(),
  }
}

function persistedQueuedImage(value: unknown): CodexImageAttachment | null {
  if (!value || typeof value !== 'object') return null
  const image = value as Record<string, unknown>
  const name = typeof image.name === 'string' ? image.name.slice(0, 512) : ''
  const mediaType = image.mediaType
  const data = image.data
  if (!name || (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif')) return null
  if (typeof data !== 'string' || data.length === 0 || data.length > maxPersistedQueuedStorageCharacters) return null
  return { name, mediaType, data }
}

function persistedQueuedDocument(value: unknown): CodexDocumentAttachment | undefined {
  if (!value || typeof value !== 'object') return undefined
  const document = value as Record<string, unknown>
  if (typeof document.name !== 'string' || typeof document.content !== 'string') return undefined
  if (typeof document.sourceFileId === 'string') {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(document.sourceFileId) || !document.name || document.name.length > 512) return undefined
    return { name: document.name, content: '', sourceFileId: document.sourceFileId }
  }
  if (!document.name || document.name.length > 512 || document.content.length > maxPersistedQueuedTextCharacters) return undefined
  return { name: document.name, content: document.content }
}

function persistedQueuedDocuments(value: unknown): CodexDocumentAttachment[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.flatMap((item) => {
    const document = persistedQueuedDocument(item)
    return document ? [document] : []
  }).slice(0, 8)
}

function persistedQueuedPayload(value: unknown): QueuedTurnPayload | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  const id = typeof payload.id === 'string' ? payload.id : ''
  const text = typeof payload.text === 'string' ? payload.text : ''
  const createdAt = typeof payload.createdAt === 'string' ? payload.createdAt : ''
  if (!id || id.length > 256 || text.length > maxPersistedQueuedTextCharacters || !createdAt || createdAt.length > 128) return null
  const images = Array.isArray(payload.images)
    ? payload.images.flatMap((image) => {
      const parsed = persistedQueuedImage(image)
      return parsed ? [parsed] : []
    }).slice(0, 4)
    : []
  const documents = persistedQueuedDocuments(payload.documents ?? payload.document)
  if (!text && images.length === 0 && documents.length === 0) return null
  const model = typeof payload.model === 'string' && payload.model.length <= 256 ? payload.model : undefined
  const effort = typeof payload.effort === 'string' && payload.effort.length <= 64 ? payload.effort : undefined
  const approvalPolicy = payload.approvalPolicy === 'on-request' || payload.approvalPolicy === 'untrusted' || payload.approvalPolicy === 'never'
    ? payload.approvalPolicy
    : undefined
  const attempt = payload.sendAttempt && typeof payload.sendAttempt === 'object'
    ? payload.sendAttempt as Record<string, unknown>
    : null
  const sendAttempt = attempt && typeof attempt.at === 'string' && Number.isFinite(Date.parse(attempt.at))
    ? {
      at: attempt.at,
      ...(typeof attempt.afterTurnId === 'string' ? { afterTurnId: attempt.afterTurnId } : {}),
      ...(typeof attempt.afterMessageId === 'string' ? { afterMessageId: attempt.afterMessageId } : {}),
      ...(typeof attempt.inTurnId === 'string' ? { inTurnId: attempt.inTurnId } : {}),
    }
    : undefined
  return {
    id,
    text,
    requestText: queuedRequestText(text, documents),
    images,
    ...(documents.length > 0 ? { documents } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sendAttempt ? { sendAttempt } : {}),
    createdAt,
  }
}

function readPersistedQueuedMessages(): QueuedMessagesByThread {
  if (typeof window === 'undefined') return {}
  try {
    const value = window.localStorage.getItem(queuedMessagesStorageKey)
    if (!value || value.length > maxPersistedQueuedStorageCharacters) return {}
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const queues: QueuedMessagesByThread = {}
    for (const [threadId, entries] of Object.entries(parsed as Record<string, unknown>).slice(0, maxPersistedQueuedThreads)) {
      if (!threadId || threadId.length > 512 || !Array.isArray(entries)) continue
      const messages = entries.flatMap((entry) => {
        const payload = persistedQueuedPayload(entry)
        return payload ? [payload] : []
      }).slice(0, maxPersistedQueuedMessagesPerThread)
      if (messages.length > 0) queues[threadId] = messages
    }
    return queues
  } catch {
    return {}
  }
}

function persistQueuedMessages(queues: QueuedMessagesByThread) {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(queues).length === 0) {
      window.localStorage.removeItem(queuedMessagesStorageKey)
      return
    }
    const value = JSON.stringify(queues)
    if (value.length > maxPersistedQueuedStorageCharacters) return
    window.localStorage.setItem(queuedMessagesStorageKey, value)
  } catch {
    // Queues remain usable in the current page if browser storage is blocked.
  }
}

function readPersistedQueueRecoveryBarriers(queues: QueuedMessagesByThread): QueueRecoveryBarriers {
  if (typeof window === 'undefined') return restoreQueueRecoveryBarriers(null, Object.keys(queues))
  try {
    const value = window.localStorage.getItem(queuedRecoveryStorageKey)
    const parsed = value ? JSON.parse(value) : null
    return restoreQueueRecoveryBarriers(parsed, Object.keys(queues))
  } catch {
    return restoreQueueRecoveryBarriers(null, Object.keys(queues))
  }
}

function persistQueueRecoveryBarriers(barriers: QueueRecoveryBarriers, queues: QueuedMessagesByThread) {
  if (typeof window === 'undefined') return
  try {
    const queuedThreadIds = new Set(Object.keys(queues))
    const persisted = Object.fromEntries(Object.entries(barriers).filter(([threadId]) => queuedThreadIds.has(threadId)))
    if (Object.keys(persisted).length === 0) {
      window.localStorage.removeItem(queuedRecoveryStorageKey)
      return
    }
    window.localStorage.setItem(queuedRecoveryStorageKey, JSON.stringify(persisted))
  } catch {
    // Recovery metadata is an additional safety net; in-memory queue behavior remains available.
  }
}

interface QueuedThreadStateChange {
  origin: string
  threadId: string
  messages: QueuedTurnPayload[]
  barrier: QueueRecoveryBarrier | null
}

function persistQueuedThreadState(change: QueuedThreadStateChange) {
  if (typeof window === 'undefined') return
  // Legacy browser queues are imported once by the primary pane. The old
  // reconciliation code must not erase them before that import succeeds.
  if (sharedQueueAuthoritative) return
  // Each pane updates only its thread. Replacing a whole pane's old snapshot
  // would restore queues another pane has already confirmed and removed.
  const queues = readPersistedQueuedMessages()
  if (change.messages.length > 0) queues[change.threadId] = change.messages
  else delete queues[change.threadId]
  persistQueuedMessages(queues)
  const barriers = readPersistedQueueRecoveryBarriers(queues)
  if (change.messages.length > 0 && change.barrier) barriers[change.threadId] = change.barrier
  else delete barriers[change.threadId]
  persistQueueRecoveryBarriers(barriers, queues)
  window.dispatchEvent(new CustomEvent<QueuedThreadStateChange>(queuedThreadStateChangedEvent, { detail: change }))
}

function localMessageFromQueuedPayload(payload: QueuedTurnPayload, turnId?: string | null): CodexMessage {
  return {
    id: payload.id,
    role: 'user',
    text: payload.text,
    images: payload.images.map((image) => ({ name: image.name, previewUrl: `data:${image.mediaType};base64,${image.data}` })),
    ...(payload.documents?.length ? { documents: payload.documents.map((document) => ({ ...document, charCount: document.content.length })) } : {}),
    createdAt: payload.createdAt,
    sentAt: payload.createdAt,
    ...(turnId ? { turnId } : {}),
  }
}

function preserveCurrentImages(next: CodexMessage[], current: CodexMessage[]) {
  const previousImageMessages = current.filter((message) => message.role === 'user' && message.images?.length)
  const used = new Set<string>()
  return next.map((message) => {
    const previous = current.find((candidate) => candidate.id === message.id)
      ?? (message.turnId ? current.find((candidate) => candidate.role === message.role
        && candidate.turnId === message.turnId
        && (candidate.text === message.text || (message.role === 'user' && sameQueuedMessageHistoryContent(message, candidate)))) : undefined)
    let nextMessage = message
    if (previous) {
      nextMessage = {
        ...message,
        ...(!message.sentAt && previous.sentAt ? { sentAt: previous.sentAt } : {}),
        ...(!message.replyStartedAt && previous.replyStartedAt ? { replyStartedAt: previous.replyStartedAt } : {}),
        ...(message.replyDurationMs === undefined && previous.replyDurationMs !== undefined
          ? { replyDurationMs: previous.replyDurationMs }
          : {}),
      }
    }
    if (message.role !== 'user' || message.images?.length) return nextMessage
    const previousImageMessage = previousImageMessages.find((candidate) => !used.has(candidate.id) && candidate.text === message.text)
    if (!previousImageMessage) return nextMessage
    used.add(previousImageMessage.id)
    return { ...nextMessage, images: previousImageMessage.images }
  })
}

function sameMessages(left: CodexMessage[], right: CodexMessage[]) {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index]
    if (!candidate) return false
    return message.id === candidate.id
      && message.sourceItemId === candidate.sourceItemId
      && message.role === candidate.role
      && message.text === candidate.text
      && message.turnId === candidate.turnId
      && message.sentAt === candidate.sentAt
      && message.replyStartedAt === candidate.replyStartedAt
      && message.replyDurationMs === candidate.replyDurationMs
      && Boolean(message.streaming) === Boolean(candidate.streaming)
      && sameMessageImages(message.images, candidate.images)
      && sameMessageDocuments(message.documents, candidate.documents)
  })
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
  const exactMatches = messages.filter((message) => message.role === 'assistant' && message.id === messageId)
  if (exactMatches.length > 0 || !turnId) return exactMatches
  let latestUserIndex = -1
  messages.forEach((message, index) => {
    if (message.role === 'user' && message.turnId === turnId) latestUserIndex = index
  })
  return messages.filter((message, index) => message.role === 'assistant'
    && message.turnId === turnId
    && index > latestUserIndex)
}

function assistantTextForTurn(messages: CodexMessage[], turnId: string | null, messageId: string) {
  return assistantMessagesForStreamSegment(messages, turnId, messageId)
    .reduce((text, message) => mergeStreamingText(text, message.text), '')
}

function collapseAssistantMessagesForTurn(
  messages: CodexMessage[],
  turnId: string | null,
  messageId: string,
  incomingText: string,
  replyStartedAt?: string,
) {
  // The normal streaming path only changes the last assistant bubble. Avoid
  // searching/merging the whole history for every rendered text chunk.
  const tail = messages.at(-1)
  if (tail?.role === 'assistant' && tail.id === messageId && tail.streaming && (!turnId || tail.turnId === turnId)) {
    const text = mergeStreamingText(tail.text, incomingText)
    if (text === tail.text && (tail.replyStartedAt || !replyStartedAt)) return messages
    return [
      ...messages.slice(0, -1),
      { ...tail, text, ...(tail.replyStartedAt || !replyStartedAt ? {} : { replyStartedAt }) },
    ]
  }
  const matching = assistantMessagesForStreamSegment(messages, turnId, messageId)
  const text = mergeStreamingText(assistantTextForTurn(messages, turnId, messageId), incomingText)
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

function streamingAssistantText(parts: Map<string, string>) {
  // Codex can emit commentary and a final answer as separate agentMessage
  // items in one turn. Match the restored-history presentation by preserving
  // a paragraph boundary between those items.
  return [...parts.values()].filter(Boolean).join('\n\n')
}

function sameActiveThread(left: CodexThread | null, right: CodexThread) {
  return left?.id === right.id
    && left.name === right.name
    && left.preview === right.preview
    && left.cwd === right.cwd
    && left.updatedAt === right.updatedAt
    && left.createdAt === right.createdAt
    && left.status?.type === right.status?.type
}

function sameActivity(left: CodexActivity | null, right: CodexActivity | null) {
  return left?.label === right?.label && left?.detail === right?.detail
}

function fileChangeForItem(value: unknown): CodexFileChange | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const itemType = typeof item.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
  if (itemType !== 'filechange') return null
  const rawChanges = item.changes
  const changes = Array.isArray(rawChanges)
    ? rawChanges
    : rawChanges && typeof rawChanges === 'object'
      ? Object.entries(rawChanges).map(([path, change]) => ({ path, ...(change && typeof change === 'object' ? change : {}) }))
      : []
  const explicitLineCount = (count: unknown) => (
    typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : undefined
  )
  const entries = changes.flatMap((value) => {
    if (typeof value === 'string') return [{ path: value, additions: 0, deletions: 0 }]
    if (!value || typeof value !== 'object') return []
    const change = value as Record<string, unknown>
    const path = [change.path, change.filePath, change.filename, change.move_path, change.movePath]
      .find((part): part is string => typeof part === 'string' && part.length > 0)
    if (!path) return []
    const diff = [change.diff, change.patch, change.unified_diff, change.unifiedDiff]
      .find((part): part is string => typeof part === 'string')
    const diffLines = diff?.split('\n') ?? []
    const additions = explicitLineCount(change.additions)
      ?? diffLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    const deletions = explicitLineCount(change.deletions)
      ?? diffLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
    return [{
      path,
      kind: typeof change.kind === 'string' ? change.kind : typeof change.type === 'string' ? change.type : undefined,
      diff,
      additions,
      deletions,
    }]
  })
  if (entries.length === 0) return null
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : ''
  return {
    id: typeof item.id === 'string' ? item.id : `file-change-${Date.now()}`,
    status: status === 'completed' || status === 'complete' ? 'completed' : 'inProgress',
    changes: entries,
  }
}

function upsertFileChange(current: CodexFileChange[], next: CodexFileChange) {
  const index = current.findIndex((change) => change.id === next.id)
  if (index < 0) return [...current, next]
  return current.map((change, currentIndex) => currentIndex === index ? next : change)
}

function mergeWorkspaceFileChange(current: CodexFileChange[], next: CodexFileChange) {
  const withoutPreviousWorkspaceChange = current.filter((change) => change.id !== next.id)
  const mergedChanges = [...withoutPreviousWorkspaceChange]
  const missingWorkspaceEntries: CodexFileChange['changes'] = []
  for (const workspaceEntry of next.changes) {
    const previousLocation = mergedChanges.findIndex((change) => change.changes.some((entry) => entry.path === workspaceEntry.path))
    if (previousLocation < 0) {
      missingWorkspaceEntries.push(workspaceEntry)
      continue
    }
    const previousChange = mergedChanges[previousLocation]
    const previousEntries = previousChange.changes.map((entry) => {
      if (entry.path !== workspaceEntry.path) return entry
      const nativeHasLineStats = Boolean(entry.diff) || entry.additions > 0 || entry.deletions > 0
      return {
        ...entry,
        kind: entry.kind ?? workspaceEntry.kind,
        diff: entry.diff || workspaceEntry.diff,
        additions: nativeHasLineStats ? entry.additions : workspaceEntry.additions,
        deletions: nativeHasLineStats ? entry.deletions : workspaceEntry.deletions,
      }
    })
    mergedChanges[previousLocation] = { ...previousChange, changes: previousEntries }
  }
  if (missingWorkspaceEntries.length > 0) {
    mergedChanges.push({ ...next, changes: missingWorkspaceEntries })
  }
  return mergedChanges
}

function isWorkspaceFileChange(change: CodexFileChange) {
  return change.id.startsWith('workspace-change-')
}

function mergeTurnFileChanges(current: CodexFileChange[], incoming: CodexFileChange[]) {
  let nativeChanges: CodexFileChange[] = []
  const workspaceChanges: CodexFileChange[] = []
  for (const change of [...current, ...incoming]) {
    if (isWorkspaceFileChange(change)) workspaceChanges.push(change)
    else nativeChanges = upsertFileChange(nativeChanges, change)
  }
  return workspaceChanges.reduce(
    (merged, change) => mergeWorkspaceFileChange(merged, change),
    nativeChanges,
  )
}

function mergeFileChangesByTurn(current: FileChangesByTurn, incoming: FileChangesByTurn) {
  let merged = current
  for (const [turnId, changes] of Object.entries(incoming)) {
    const nextChanges = mergeTurnFileChanges(current[turnId] ?? [], changes)
    if (nextChanges === current[turnId]) continue
    if (merged === current) merged = { ...current }
    if (nextChanges.length > 0) merged[turnId] = nextChanges
    else delete merged[turnId]
  }
  return merged
}

function workspaceFileChange(turnId: string, changes: unknown): CodexFileChange | null {
  if (!Array.isArray(changes) || changes.length === 0) return null
  return fileChangeForItem({
    type: 'fileChange',
    id: `workspace-change-${turnId}`,
    status: 'completed',
    changes,
  })
}

function nativeFileChangesFromItems(items: unknown[]): CodexFileChange[] {
  return items.reduce<CodexFileChange[]>((changes, item) => {
    const fileChange = fileChangeForItem(item)
    return fileChange ? upsertFileChange(changes, fileChange) : changes
  }, [])
}

function workspaceChangesForTurn(value: unknown, turnId: string): CodexFileChange | null {
  if (!value || typeof value !== 'object') return null
  const workspaceChanges = value as Record<string, unknown>
  if (Array.isArray(workspaceChanges.changes)) {
    return workspaceChanges.turnId === turnId ? workspaceFileChange(turnId, workspaceChanges.changes) : null
  }
  return workspaceFileChange(turnId, workspaceChanges[turnId])
}

function fileChangesFromThread(thread: { turns?: unknown[] }) {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const workspaceChanges = (thread as Record<string, unknown>).codexRemoteWorkspaceChanges
  return turns.reduce<FileChangesByTurn>((groups, turnValue, index) => {
    if (!turnValue || typeof turnValue !== 'object') return groups
    const turn = turnValue as Record<string, unknown>
    const turnId = typeof turn.id === 'string' ? turn.id : `history-turn-${index}`
    const items = Array.isArray(turn.items) ? turn.items : []
    const nativeChanges = nativeFileChangesFromItems(items)
    const workspaceChange = workspaceChangesForTurn(workspaceChanges, turnId)
    const changes = workspaceChange ? mergeTurnFileChanges(nativeChanges, [workspaceChange]) : nativeChanges
    if (changes.length > 0) groups[turnId] = changes
    return groups
  }, {})
}

function activityForItem(value: unknown): CodexActivity {
  if (!value || typeof value !== 'object') return { label: '正在处理' }
  const item = value as Record<string, unknown>
  const toolName = [item.namespace, item.tool]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('.')

  switch (item.type) {
    case 'reasoning': return { label: '正在思考' }
    case 'plan': return { label: '正在整理执行计划' }
    case 'agentMessage': return { label: '正在生成回复' }
    case 'commandExecution': {
      const command = typeof item.command === 'string' ? item.command.replace(/\s+/g, ' ').trim() : ''
      return { label: '正在执行命令', detail: command ? safeOperationDetail(command) : undefined }
    }
    case 'fileChange': {
      const count = Array.isArray(item.changes) ? item.changes.length : 0
      return { label: '正在修改文件', detail: count > 0 ? `${count} 个文件` : undefined }
    }
    case 'mcpToolCall': {
      const server = typeof item.server === 'string' ? item.server : ''
      const tool = typeof item.tool === 'string' ? item.tool : ''
      return { label: '正在调用 MCP 工具', detail: safeOperationDetail([server, tool].filter(Boolean).join(' · ')) }
    }
    case 'dynamicToolCall': return { label: '正在调用工具', detail: safeOperationDetail(toolName) }
    case 'webSearch': return { label: '正在搜索资料', detail: typeof item.query === 'string' ? safeOperationDetail(item.query) : undefined }
    case 'imageView': return { label: '正在查看图片' }
    case 'imageGeneration': return { label: '正在生成图片' }
    case 'collabAgentToolCall': return { label: '正在协调子任务', detail: typeof item.tool === 'string' ? item.tool : undefined }
    case 'subAgentActivity': return { label: '正在运行子任务' }
    default: return { label: '正在处理' }
  }
}

const maxOperationsPerTurn = 80
const maxOperationHistoryTurns = 30
const maxOperationDetailCharacters = 220

function normalizedOperationStatus(value: unknown, fallback: CodexOperationStatus = 'completed'): CodexOperationStatus {
  if (typeof value !== 'string') return fallback
  const status = value.replace(/[-_]/g, '').toLowerCase()
  if (status === 'inprogress' || status === 'running' || status === 'started') return 'running'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled' || status === 'declined') return 'stopped'
  if (status === 'completed' || status === 'complete' || status === 'success') return 'completed'
  return fallback
}

function safeOperationDetail(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(--?(?:token|password|passwd|api[-_]?key|secret|authorization|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[已隐藏]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1=[已隐藏]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/([a-z][\w+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1[已隐藏]@')
  return sanitized.length > maxOperationDetailCharacters
    ? `${sanitized.slice(0, maxOperationDetailCharacters - 1)}…`
    : sanitized || undefined
}

function operationPaths(value: unknown, depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== 'object') return []
  const paths: string[] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:path|filepath|file_path|filename|target_path|source_path)$/i.test(key) && typeof entry === 'string' && entry.trim()) {
      paths.push(entry.trim())
    } else if (entry && typeof entry === 'object') {
      paths.push(...operationPaths(entry, depth + 1))
    }
  }
  return [...new Set(paths)].slice(0, 8)
}

function operationForItem(value: unknown, statusOverride?: CodexOperationStatus): CodexOperation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const itemType = typeof item.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
  const id = typeof item.id === 'string' ? item.id : ''
  if (!id || itemType === 'reasoning' || itemType === 'agentmessage' || itemType === 'usermessage' || itemType === 'plan') return null
  const status = statusOverride ?? normalizedOperationStatus(item.status)

  if (itemType === 'commandexecution') {
    const command = typeof item.command === 'string' ? item.command.replace(/\s+/g, ' ').trim() : ''
    const knownCommand = command.match(/(?:^|[\s"'|;&])(?:\/[\w.\/-]+\/)?(rg|grep|find|fd|ag|ack|cat|less|more|head|tail|sed|awk|bat|xxd|file)(?=$|[\s"';&|])/i)?.[1]?.toLowerCase() ?? ''
    const isSearch = /^(?:rg|grep|find|fd|ag|ack)$/.test(knownCommand)
    const isRead = /^(?:cat|less|more|head|tail|sed|awk|bat|xxd|file)$/.test(knownCommand)
    const detail = safeOperationDetail(command)
    return {
      id,
      kind: isSearch ? 'search' : isRead ? 'file' : 'command',
      label: isSearch ? '搜索文件' : isRead ? '查看文件' : '执行命令',
      ...(detail ? { detail } : {}),
      status,
    }
  }

  if (itemType === 'filechange') {
    const fileChange = fileChangeForItem(item)
    if (!fileChange) return null
    const paths = fileChange.changes.map((change) => change.path)
    const shownPaths = paths.slice(0, 3)
    const suffix = paths.length > shownPaths.length ? ` 等 ${paths.length} 个文件` : ''
    const detail = safeOperationDetail(`${shownPaths.join('、')}${suffix}`)
    return { id, kind: 'file', label: '修改文件', ...(detail ? { detail } : {}), status }
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall' || itemType === 'collabAgentToolCall') {
    const tool = [item.server, item.tool, item.name]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' · ')
    const args = item.arguments ?? item.args ?? item.input
    let parsedArgs = args
    if (typeof args === 'string' && args.length < 20_000) {
      try { parsedArgs = JSON.parse(args) } catch { parsedArgs = null }
    }
    const paths = operationPaths(parsedArgs)
    const toolType = tool.toLowerCase()
    const isSearch = /search|find|grep|query/.test(toolType)
    const isFile = /read|file|directory|folder|list/.test(toolType)
    const label = isSearch ? '搜索文件' : isFile ? '查看文件' : '调用工具'
    const pathSummary = paths.length > 0
      ? `${paths.slice(0, 3).join('、')}${paths.length > 3 ? ` 等 ${paths.length} 个路径` : ''}`
      : ''
    const detail = safeOperationDetail([tool, pathSummary].filter(Boolean).join(' · '))
    return { id, kind: isSearch ? 'search' : isFile ? 'file' : 'tool', label, ...(detail ? { detail } : {}), status }
  }

  if (itemType === 'websearch') {
    const query = typeof item.query === 'string' ? item.query : ''
    const detail = safeOperationDetail(query)
    return { id, kind: 'search', label: '搜索资料', ...(detail ? { detail } : {}), status }
  }

  if (itemType === 'imageview') return { id, kind: 'tool', label: '查看图片', status }
  if (itemType === 'imagegeneration') return { id, kind: 'tool', label: '生成图片', status }
  if (itemType === 'subagentactivity') return { id, kind: 'tool', label: '运行子任务', status }
  return null
}

function upsertTurnOperation(current: CodexOperation[], operation: CodexOperation[]) {
  let next = current
  for (const item of operation) {
    const index = next.findIndex((entry) => entry.id === item.id)
    if (index < 0) next = [...next, item]
    else if (next[index] !== item) next = next.map((entry, entryIndex) => entryIndex === index ? item : entry)
  }
  return next.length > maxOperationsPerTurn ? next.slice(-maxOperationsPerTurn) : next
}

function withTurnOperation(current: OperationsByTurn, turnId: string, operation: CodexOperation) {
  const next = {
    ...current,
    [turnId]: upsertTurnOperation(current[turnId] ?? [], [operation]),
  }
  const turnIds = Object.keys(next)
  if (turnIds.length <= maxOperationHistoryTurns) return next
  return Object.fromEntries(turnIds.slice(-maxOperationHistoryTurns).map((id) => [id, next[id]]))
}

function mergeOperationsByTurn(current: OperationsByTurn, incoming: OperationsByTurn): OperationsByTurn {
  let merged = incoming
  for (const [turnId, operations] of Object.entries(current)) {
    const next = upsertTurnOperation(merged[turnId] ?? [], operations)
    if (merged === incoming) merged = { ...incoming }
    merged[turnId] = next
  }
  const turnIds = Object.keys(merged)
  return turnIds.length > maxOperationHistoryTurns
    ? Object.fromEntries(turnIds.slice(-maxOperationHistoryTurns).map((id) => [id, merged[id]]))
    : merged
}

function operationsFromThread(thread: { turns?: unknown[] }): OperationsByTurn {
  const turns = Array.isArray(thread.turns) ? thread.turns.slice(-maxOperationHistoryTurns) : []
  return turns.reduce<OperationsByTurn>((groups, turnValue, index) => {
    if (!turnValue || typeof turnValue !== 'object') return groups
    const turn = turnValue as Record<string, unknown>
    const turnId = typeof turn.id === 'string' ? turn.id : `history-turn-${index}`
    const items = Array.isArray(turn.items) ? turn.items : []
    const operations = items.flatMap((item) => {
      const operation = operationForItem(item)
      return operation ? [operation] : []
    })
    if (operations.length > 0) groups[turnId] = upsertTurnOperation([], operations)
    return groups
  }, {})
}

function finishTurnOperations(current: OperationsByTurn, turnId: string, status: CodexOperationStatus): OperationsByTurn {
  const operations = current[turnId]
  if (!operations?.some((operation) => operation.status === 'running')) return current
  return {
    ...current,
    [turnId]: operations.map((operation) => operation.status === 'running' ? { ...operation, status } : operation),
  }
}

export function useCodexRemote(token: string, onUnauthorized: () => void, options: UseCodexRemoteOptions = {}) {
  const persistActiveThread = options.persistActiveThread ?? true
  const enabled = options.enabled ?? true
  const loadThreads = options.loadThreads ?? true
  const loadModels = options.loadModels ?? true
  const prefetchHistory = options.prefetchHistory ?? false
  const [initialActiveThreadId] = useState(() => persistActiveThread ? readPersistedActiveThreadId() : null)
  const [initialCachedThread] = useState(() => persistActiveThread ? readPersistedActiveThreadCache(initialActiveThreadId) : null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected' | 'unavailable'>('connecting')
  const [runtime, setRuntime] = useState(emptyRuntime)
  const [handedOff, setHandedOff] = useState(false)
  const [handoffInProgress, setHandoffInProgress] = useState(false)
  const [threads, setThreads] = useState<CodexThread[]>([])
  const [models, setModels] = useState<CodexModel[]>([])
  // Keep the saved thread ID available before its history has finished
  // loading. This gives the composer a stable draft scope and lets a new turn
  // start without waiting for a large thread/read response.
  const [activeThread, setActiveThread] = useState<CodexThread | null>(() =>
    initialCachedThread?.thread ?? (initialActiveThreadId ? { id: initialActiveThreadId } : null),
  )
  const [messages, setMessages] = useState<CodexMessage[]>(() => initialCachedThread?.messages ?? [])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [isRunning, setIsRunning] = useState(false)
  // This is intentionally state as well as a ref: the ref lets socket events
  // make immediate decisions, while the state tells the UI which turn is not
  // finished yet so in-progress file changes can be shown beside its reply.
  const [runningTurnId, setRunningTurnId] = useState<string | null>(null)
  const [isInterrupting, setIsInterrupting] = useState(false)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const turnStartedAtRef = useRef<number | null>(null)
  const [activity, setActivity] = useState<CodexActivity | null>(null)
  const [fileChangesByTurn, setFileChangesByTurn] = useState<FileChangesByTurn>({})
  const [operationsByTurn, setOperationsByTurn] = useState<OperationsByTurn>({})
  const [writerConflict, setWriterConflict] = useState(false)
  const [updatingApprovalPolicy, setUpdatingApprovalPolicy] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(() => initialActiveThreadId !== null)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [completedThreadIds, setCompletedThreadIds] = useState<string[]>([])
  const [latestThreadCompletion, setLatestThreadCompletion] = useState<CodexThreadCompletion | null>(null)
  const [queuedMessagesByThread, setQueuedMessagesByThread] = useState<QueuedMessagesByThread>({})
  const [serverQueuedMessagesByThread, setServerQueuedMessagesByThread] = useState<QueuedMessagesByThread>({})
  const serverQueuedMessagesByThreadRef = useRef<QueuedMessagesByThread>({})
  const serverQueueFetchVersion = useRef(new Map<string, number>())
  const pendingServerQueueRemovals = useRef(new Map<string, Set<string>>())
  const [pinRevision, setPinRevision] = useState(0)
  // A restored queue may start only after a fresh thread/read confirms that
  // the matching Codex turn is idle. Cached UI alone is not authoritative.
  const [queueRecoveryReadyThreadId, setQueueRecoveryReadyThreadId] = useState<string | null>(null)
  const [queueEditRevision, setQueueEditRevision] = useState(0)
  const socketRef = useRef<ReturnType<typeof codexRemoteClient.connect> | null>(null)
  const connectionRef = useRef<'connecting' | 'connected' | 'disconnected' | 'unavailable'>('connecting')
  const reconnectRef = useRef<(force?: boolean) => void>(() => {})
  const handedOffRef = useRef(false)
  const activeThreadId = useRef<string | null>(initialActiveThreadId)
  const activeTurnId = useRef<string | null>(null)
  const interruptRequestedThreadId = useRef<string | null>(null)
  const interruptRequestedTurnId = useRef<string | null>(null)
  const interruptInFlightThreadId = useRef<string | null>(null)
  const resumedThreadId = useRef<string | null>(null)
  const loadRequest = useRef(0)
  const historyRevision = useRef(0)
  const historyReadSequence = useRef(0)
  const activityItemId = useRef<string | null>(null)
  const operationsByTurnRef = useRef<OperationsByTurn>({})
  const streamingAssistantMessageId = useRef<string | null>(null)
  const streamingAssistantTurnId = useRef<string | null>(null)
  const streamingAssistantParts = useRef(new Map<string, string>())
  const streamingRenderTimer = useRef<number | undefined>(undefined)
  const streamingRenderGeneration = useRef(0)
  const turnStartedAtById = useRef(new Map<string, number>())
  const writerConflictRef = useRef(false)
  const writerRefreshTimer = useRef<number | undefined>(undefined)
  const restoringThreadId = useRef<string | null>(null)
  const threadHistoryCache = useRef(new Map<string, ThreadCacheEntry>())
  const pendingPersistentThreadCache = useRef(new Map<string, ThreadCacheEntry>())
  const persistentThreadCacheTimers = useRef(new Map<string, number>())
  const persistentThreadCacheKnown = useRef(new Map<string, { lastAccessedAt: number; sizeBytes: number }>())
  const threadListRef = useRef<CodexThread[]>([])
  const threadListLoadedRef = useRef(false)
  const threadListFetchedAtRef = useRef(0)
  const threadListRequest = useRef<Promise<CodexThread[] | null> | null>(null)
  const prefetchingThreadIds = useRef(new Set<string>())
  const forcedPrefetchThreadIds = useRef(new Set<string>())
  const threadPrefetchTimer = useRef<number | undefined>(undefined)
  const cachedActiveThreadRefreshTimer = useRef<number | undefined>(undefined)
  const queuedMessagesByThreadRef = useRef<QueuedMessagesByThread>(queuedMessagesByThread)
  const queueControllerId = useRef(queuedMessageId())
  const queueRecoveryBarriers = useRef<QueueRecoveryBarriers | null>(null)
  if (queueRecoveryBarriers.current === null) {
    queueRecoveryBarriers.current = readPersistedQueueRecoveryBarriers(queuedMessagesByThread)
  }
  const queuedTurnStartsInFlight = useRef(new Set<string>())
  const queuedTurnSteersInFlight = useRef(new Set<string>())
  const pendingTurnDeliveries = useRef(new Map<string, PendingTurnDelivery>())
  const editingQueuedMessageByThread = useRef<Record<string, string>>({})
  const editingQueuedMessageThreadById = useRef(new Map<string, string>())
  const deferredQueueAdvanceAfterEdit = useRef(new Set<string>())

  const publishServerQueue = useCallback((threadId: string, queue: QueuedTurnPayload[]) => {
    serverQueuedMessagesByThreadRef.current = { ...serverQueuedMessagesByThreadRef.current, [threadId]: queue }
    const pendingRemovals = pendingServerQueueRemovals.current.get(threadId)
    const visibleQueue = visibleQueuedMessages(queue, pendingRemovals)
    setServerQueuedMessagesByThread((current) => ({ ...current, [threadId]: visibleQueue }))
  }, [])

  const applyServerQueueResponse = useCallback((threadId: string, queue: QueuedTurnPayload[]) => {
    serverQueueFetchVersion.current.set(threadId, (serverQueueFetchVersion.current.get(threadId) ?? 0) + 1)
    publishServerQueue(threadId, queue)
  }, [publishServerQueue])

  const refreshServerQueue = useCallback(async (threadId: string) => {
    const revision = (serverQueueFetchVersion.current.get(threadId) ?? 0) + 1
    serverQueueFetchVersion.current.set(threadId, revision)
    try {
      const result = await codexRemoteClient.queuedMessages(token, threadId)
      if (serverQueueFetchVersion.current.get(threadId) !== revision) return
      publishServerQueue(threadId, result.queue)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (reason instanceof RemoteApiError && reason.status === 404) {
        setError('电脑端服务尚未加载共享排队接口，请重启 Codex Remote 后端。')
      }
    }
  }, [onUnauthorized, publishServerQueue, token])

  useEffect(() => {
    if (!enabled || !activeThread?.id) return
    void refreshServerQueue(activeThread.id)
  }, [activeThread?.id, enabled, refreshServerQueue])

  useEffect(() => {
    if (!enabled || !persistActiveThread) return
    let disposed = false
    void (async () => {
      const legacy = readPersistedQueuedMessages()
      const barriers = readPersistedQueueRecoveryBarriers(legacy)
      try {
        for (const [threadId, entries] of Object.entries(legacy)) {
          for (const [index, entry] of entries.entries()) {
            const unsafeRecovery = index === 0 && barriers[threadId]?.status !== 'running'
            const migrated = unsafeRecovery && !entry.sendAttempt
              ? { ...entry, sendAttempt: { at: entry.createdAt } }
              : entry
            await codexRemoteClient.enqueueMessage(token, threadId, migrated)
          }
          if (!disposed) void refreshServerQueue(threadId)
        }
        window.localStorage.removeItem(queuedMessagesStorageKey)
        window.localStorage.removeItem(queuedRecoveryStorageKey)
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? `旧排队消息迁移失败：${reason.message}` : '旧排队消息迁移失败')
      }
    })()
    return () => { disposed = true }
  }, [enabled, onUnauthorized, persistActiveThread, refreshServerQueue, token])

  useEffect(() => {
    const threadId = activeThread?.id
    if (!enabled || !threadId) return
    const owners = activeQueueControllers.get(threadId) ?? new Set<string>()
    owners.add(queueControllerId.current)
    activeQueueControllers.set(threadId, owners)
    return () => {
      owners.delete(queueControllerId.current)
      if (owners.size === 0) activeQueueControllers.delete(threadId)
    }
  }, [activeThread?.id, enabled])

  useEffect(() => {
    const syncQueue = (event: Event) => {
      const change = (event as CustomEvent<QueuedThreadStateChange>).detail
      if (!change || change.origin === queueControllerId.current) return
      const next = { ...queuedMessagesByThreadRef.current }
      if (change.messages.length > 0) next[change.threadId] = change.messages
      else delete next[change.threadId]
      queuedMessagesByThreadRef.current = next
      setQueuedMessagesByThread(next)
      const barriers = { ...(queueRecoveryBarriers.current ?? {}) }
      if (change.messages.length > 0 && change.barrier) barriers[change.threadId] = change.barrier
      else delete barriers[change.threadId]
      queueRecoveryBarriers.current = barriers
    }
    window.addEventListener(queuedThreadStateChangedEvent, syncQueue)
    return () => window.removeEventListener(queuedThreadStateChangedEvent, syncQueue)
  }, [])

  const setActiveTurnId = useCallback((turnId: string | null) => {
    activeTurnId.current = turnId
    setRunningTurnId((current) => current === turnId ? current : turnId)
  }, [])

  const setHandoffState = useCallback((next: boolean) => {
    handedOffRef.current = next
    setHandedOff(next)
  }, [])

  const setConnectionState = useCallback((next: 'connecting' | 'connected' | 'disconnected' | 'unavailable') => {
    connectionRef.current = next
    setConnection(next)
  }, [])

  const setQueueRecoveryBarrier = useCallback((threadId: string, barrier: QueueRecoveryBarrier | null) => {
    const next = { ...(queueRecoveryBarriers.current ?? {}) }
    if (barrier) next[threadId] = barrier
    else delete next[threadId]
    queueRecoveryBarriers.current = next
    persistQueuedThreadState({
      origin: queueControllerId.current,
      threadId,
      messages: queuedMessagesByThreadRef.current[threadId] ?? [],
      barrier,
    })
  }, [])

  const updateQueuedMessages = useCallback((threadId: string, update: (current: QueuedTurnPayload[]) => QueuedTurnPayload[]) => {
    const current = queuedMessagesByThreadRef.current[threadId] ?? []
    const next = update(current)
    if (next === current) return current
    const nextByThread = { ...queuedMessagesByThreadRef.current }
    if (next.length > 0) nextByThread[threadId] = next
    else {
      delete nextByThread[threadId]
      deferredQueueAdvanceAfterEdit.current.delete(threadId)
      const nextBarriers = { ...(queueRecoveryBarriers.current ?? {}) }
      delete nextBarriers[threadId]
      queueRecoveryBarriers.current = nextBarriers
    }
    queuedMessagesByThreadRef.current = nextByThread
    setQueuedMessagesByThread(nextByThread)
    persistQueuedThreadState({
      origin: queueControllerId.current,
      threadId,
      messages: next,
      barrier: queueRecoveryBarriers.current?.[threadId] ?? null,
    })
    return next
  }, [])

  const recordQueuedSendAttempt = useCallback((threadId: string, messageId: string, inTurnId?: string | null) => {
    const history = activeThreadId.current === threadId
      ? messagesRef.current
      : threadHistoryCache.current.get(threadId)?.messages ?? []
    const previous = [...history].reverse().find((message) => message.turnId && !message.id.startsWith('queued-'))
    const anchor = [...history].reverse().find((message) => !message.id.startsWith('queued-') && !message.id.startsWith('streaming-'))
    const attempt = {
      at: new Date().toISOString(),
      ...(inTurnId ? { inTurnId } : previous?.turnId ? { afterTurnId: previous.turnId } : {}),
      ...(anchor ? { afterMessageId: anchor.id } : {}),
    }
    updateQueuedMessages(threadId, (current) => current.map((message) => message.id === messageId
      ? { ...message, sendAttempt: message.sendAttempt ?? attempt }
      : message))
  }, [updateQueuedMessages])

  const reconcileQueuedHistory = useCallback((threadId: string, historyMessages: CodexMessage[]) => {
    const deliveredIds = deliveredQueuedMessageIdsFromHistory(queuedMessagesByThreadRef.current[threadId] ?? [], historyMessages)
    if (deliveredIds.size > 0) {
      updateQueuedMessages(threadId, (current) => current.filter((message) => !deliveredIds.has(message.id)))
    }
    return deliveredIds
  }, [updateQueuedMessages])

  const beginTurnTimer = useCallback((startedAt: number) => {
    turnStartedAtRef.current = startedAt
    setTurnStartedAt(startedAt)
  }, [])

  const finishTurnTimer = useCallback(() => {
    turnStartedAtRef.current = null
    setTurnStartedAt(null)
  }, [])

  const clearTurnTimer = useCallback(() => {
    turnStartedAtRef.current = null
    setTurnStartedAt(null)
  }, [])

  const startTurnTimerForTurn = useCallback((turnId: string | null, historyStartedAt: number | null = null) => {
    const savedStartedAt = turnId
      ? turnStartedAtById.current.get(turnId)
      : turnStartedAtRef.current ?? undefined
    const startedAt = resolveTurnStartedAt(historyStartedAt, savedStartedAt)
    if (turnId) turnStartedAtById.current.set(turnId, startedAt)
    beginTurnTimer(startedAt)
  }, [beginTurnTimer])

  const resetStreamingAssistant = useCallback(() => {
    streamingRenderGeneration.current += 1
    if (streamingRenderTimer.current !== undefined) {
      window.clearTimeout(streamingRenderTimer.current)
      streamingRenderTimer.current = undefined
    }
    streamingAssistantMessageId.current = null
    streamingAssistantTurnId.current = null
    streamingAssistantParts.current.clear()
  }, [])

  const addFileChangeToTurn = useCallback((turnId: string | null, fileChange: CodexFileChange) => {
    if (!turnId) return
    setFileChangesByTurn((current) => {
      return mergeFileChangesByTurn(current, { [turnId]: [fileChange] })
    })
  }, [])

  const flushStreamingAssistant = useCallback((synchronous = false, turnId = activeTurnId.current) => {
    if (streamingRenderTimer.current !== undefined) {
      window.clearTimeout(streamingRenderTimer.current)
      streamingRenderTimer.current = undefined
    }
    const messageId = streamingAssistantMessageId.current
    const text = streamingAssistantText(streamingAssistantParts.current)
    if (!messageId || !text) return
    const startedAt = turnId ? turnStartedAtById.current.get(turnId) : undefined
    const replyStartedAt = new Date(startedAt ?? Date.now()).toISOString()
    const renderGeneration = streamingRenderGeneration.current
    const update = () => {
      setMessages((current) => {
        // A delayed transition from a previous turn must never recreate an
        // assistant bubble after the active thread has already changed.
        if (!synchronous && renderGeneration !== streamingRenderGeneration.current) return current
        const next = collapseAssistantMessagesForTurn(current, turnId, messageId, text, replyStartedAt)
        const tail = current.at(-1)
        if (tail?.role === 'assistant' && tail.id === messageId && tail.streaming && (!turnId || tail.turnId === turnId)) return next
        return sameMessages(current, next) ? current : next
      })
    }
    if (synchronous) update()
    else startTransition(update)
  }, [])

  const finalizeVisibleStreamingTurn = useCallback((turnId: string | null, completedAt = Date.now()) => {
    const streamTurnId = streamingAssistantTurnId.current
    const targetTurnId = turnId ?? streamTurnId
    if (!targetTurnId
      || (streamTurnId && streamTurnId !== targetTurnId)
      || (!streamTurnId && activeTurnId.current && activeTurnId.current !== targetTurnId)) return
    const messageId = streamingAssistantMessageId.current
    flushStreamingAssistant(true, targetTurnId)
    const recordedStart = turnStartedAtById.current.get(targetTurnId)
    setMessages((current) => {
      const next = current.map((message) => {
        const matches = message.streaming
          && message.role === 'assistant'
          && (message.id === messageId || message.turnId === targetTurnId)
        if (!matches) return message
        const messageStart = message.replyStartedAt ? Date.parse(message.replyStartedAt) : Number.NaN
        const startedAt = recordedStart ?? (Number.isNaN(messageStart) ? undefined : messageStart)
        return {
          ...message,
          streaming: false,
          ...(startedAt !== undefined ? {
            replyStartedAt: message.replyStartedAt ?? new Date(startedAt).toISOString(),
            replyDurationMs: Math.max(0, completedAt - startedAt),
          } : {}),
          ...(message.turnId || !targetTurnId ? {} : { turnId: targetTurnId }),
        }
      })
      return sameMessages(current, next) ? current : next
    })
    turnStartedAtById.current.delete(targetTurnId)
    resetStreamingAssistant()
  }, [flushStreamingAssistant, resetStreamingAssistant])

  const scheduleStreamingAssistantRender = useCallback(() => {
    if (streamingRenderTimer.current !== undefined) return
    streamingRenderTimer.current = window.setTimeout(() => {
      streamingRenderTimer.current = undefined
      flushStreamingAssistant()
    }, streamingRenderIntervalMs)
  }, [flushStreamingAssistant])

  const rememberPersistentThreadCache = useCallback((threadId: string, sizeBytes: number) => {
    const known = persistentThreadCacheKnown.current
    known.delete(threadId)
    known.set(threadId, { lastAccessedAt: Date.now(), sizeBytes })
    const recent = [...known.entries()].sort((left, right) => right[1].lastAccessedAt - left[1].lastAccessedAt)
    let totalBytes = 0
    let retainedCount = 0
    for (const [id, record] of recent) {
      if (retainedCount >= threadHistoryCacheMaxEntries || totalBytes + record.sizeBytes > threadHistoryCacheMaxBytes) {
        known.delete(id)
      } else {
        retainedCount += 1
        totalBytes += record.sizeBytes
      }
    }
  }, [])

  const writePersistentThreadCacheEntry = useCallback((threadId: string, entry: ThreadCacheEntry) => {
    const snapshot: PersistedThreadCacheSnapshot = { version: persistentThreadCacheVersion, entry }
    const sizeBytes = serializedCacheSizeBytes(snapshot)
    if (sizeBytes <= 0) {
      if (pendingPersistentThreadCache.current.get(threadId) === entry) pendingPersistentThreadCache.current.delete(threadId)
      return
    }
    if (sizeBytes > threadHistoryCacheMaxBytes) {
      if (pendingPersistentThreadCache.current.get(threadId) === entry) pendingPersistentThreadCache.current.delete(threadId)
      return
    }
    void writeThreadHistoryCache(threadId, snapshot, sizeBytes).then((stored) => {
      if (stored) {
        rememberPersistentThreadCache(threadId, sizeBytes)
        if (pendingPersistentThreadCache.current.get(threadId) === entry) {
          pendingPersistentThreadCache.current.delete(threadId)
        }
      }
    })
  }, [rememberPersistentThreadCache])

  const schedulePersistentThreadCacheWrite = useCallback((threadId: string, entry: ThreadCacheEntry) => {
    if (!entry.complete || typeof window === 'undefined') return
    pendingPersistentThreadCache.current.set(threadId, entry)
    const pendingCharacters = () => [...pendingPersistentThreadCache.current.values()].reduce((total, candidate) => total + candidate.characters, 0)
    while (pendingPersistentThreadCache.current.size > threadHistoryCacheMaxEntries
      || pendingCharacters() * 2 > threadHistoryCacheMaxBytes) {
      const oldest = [...pendingPersistentThreadCache.current.keys()].find((candidate) => candidate !== activeThreadId.current)
        ?? pendingPersistentThreadCache.current.keys().next().value
      if (!oldest) break
      pendingPersistentThreadCache.current.delete(oldest)
      const oldTimer = persistentThreadCacheTimers.current.get(oldest)
      if (oldTimer !== undefined) window.clearTimeout(oldTimer)
      persistentThreadCacheTimers.current.delete(oldest)
    }
    const previousTimer = persistentThreadCacheTimers.current.get(threadId)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    const timer = window.setTimeout(() => {
      persistentThreadCacheTimers.current.delete(threadId)
      const latest = pendingPersistentThreadCache.current.get(threadId)
      if (latest) writePersistentThreadCacheEntry(threadId, latest)
    }, persistentThreadCacheWriteDelayMs)
    persistentThreadCacheTimers.current.set(threadId, timer)
  }, [writePersistentThreadCacheEntry])

  useEffect(() => {
    const flushPendingThreadCacheWrites = () => {
      for (const [threadId, entry] of pendingPersistentThreadCache.current) {
        const timer = persistentThreadCacheTimers.current.get(threadId)
        if (timer !== undefined) window.clearTimeout(timer)
        persistentThreadCacheTimers.current.delete(threadId)
        writePersistentThreadCacheEntry(threadId, entry)
      }
    }
    window.addEventListener('pagehide', flushPendingThreadCacheWrites)
    document.addEventListener('visibilitychange', flushPendingThreadCacheWrites)
    return () => {
      window.removeEventListener('pagehide', flushPendingThreadCacheWrites)
      document.removeEventListener('visibilitychange', flushPendingThreadCacheWrites)
    }
  }, [writePersistentThreadCacheEntry])

  const cacheThreadSnapshot = useCallback((thread: CodexThread, nextMessages: CodexMessage[], state?: Partial<Pick<ThreadCacheEntry, 'running' | 'turnId' | 'fileChangesByTurn' | 'operationsByTurn' | 'complete'>>) => {
    const characters = cachedHistoryCharacters(nextMessages)
    const cache = threadHistoryCache.current
    const previous = cache.get(thread.id) ?? pendingPersistentThreadCache.current.get(thread.id)
    const entry: ThreadCacheEntry = {
      thread: compactThread(thread),
      messages: nextMessages,
      fileChangesByTurn: state?.fileChangesByTurn ?? previous?.fileChangesByTurn ?? {},
      operationsByTurn: state?.operationsByTurn ?? previous?.operationsByTurn ?? {},
      running: state?.running ?? previous?.running ?? threadIsRunning(thread),
      turnId: state?.turnId ?? previous?.turnId ?? null,
      characters,
      complete: state?.complete ?? previous?.complete ?? persistentThreadCacheKnown.current.has(thread.id),
    }
    schedulePersistentThreadCacheWrite(thread.id, entry)
    if (characters > maxInMemoryThreadCacheCharacters) return
    cache.delete(thread.id)
    cache.set(thread.id, entry)

    let totalCharacters = [...cache.values()].reduce((total, entry) => total + entry.characters, 0)
    while (cache.size > maxInMemoryThreadCacheEntries || totalCharacters > maxInMemoryThreadCacheCharacters) {
      const entries = [...cache.entries()]
      const oldest = entries.find(([threadId]) => threadId !== activeThreadId.current) ?? entries[0]
      if (!oldest) break
      cache.delete(oldest[0])
      totalCharacters -= oldest[1].characters
    }
  }, [schedulePersistentThreadCacheWrite])

  const restorePersistentThreadCache = useCallback(async (threadId: string) => {
    const snapshot = await readThreadHistoryCache<PersistedThreadCacheSnapshot>(threadId)
    if (!snapshot || snapshot.version !== persistentThreadCacheVersion || !isThreadCacheEntry(snapshot.entry, threadId)) return null
    const entry = snapshot.entry
    const restored: ThreadCacheEntry = {
      ...entry,
      thread: compactThread(entry.thread),
      characters: cachedHistoryCharacters(entry.messages),
      complete: true,
    }
    const sizeBytes = serializedCacheSizeBytes(snapshot)
    if (sizeBytes > 0) rememberPersistentThreadCache(threadId, sizeBytes)
    cacheThreadSnapshot(restored.thread, restored.messages, {
      running: restored.running,
      turnId: restored.turnId,
      fileChangesByTurn: restored.fileChangesByTurn,
      operationsByTurn: restored.operationsByTurn,
      complete: true,
    })
    return threadHistoryCache.current.get(threadId) ?? restored
  }, [cacheThreadSnapshot, rememberPersistentThreadCache])

  const commitTurnOperation = useCallback((threadId: string | null, turnId: string | null, operation: CodexOperation) => {
    if (!threadId || !turnId) return
    if (threadId === activeThreadId.current) {
      const next = withTurnOperation(operationsByTurnRef.current, turnId, operation)
      operationsByTurnRef.current = next
      setOperationsByTurn(next)
      const cached = threadHistoryCache.current.get(threadId)
      if (cached) cacheThreadSnapshot(cached.thread, cached.messages, {
        running: cached.running,
        turnId: cached.turnId,
        fileChangesByTurn: cached.fileChangesByTurn,
        operationsByTurn: next,
      })
      return
    }
    const cached = threadHistoryCache.current.get(threadId)
    if (!cached) return
    const next = withTurnOperation(cached.operationsByTurn, turnId, operation)
    cacheThreadSnapshot(cached.thread, cached.messages, {
      running: cached.running,
      turnId: cached.turnId,
      fileChangesByTurn: cached.fileChangesByTurn,
      operationsByTurn: next,
    })
  }, [cacheThreadSnapshot])

  const finalizeTurnOperations = useCallback((threadId: string | null, turnId: string | null, status: CodexOperationStatus) => {
    if (!threadId || !turnId) return
    if (threadId === activeThreadId.current) {
      const next = finishTurnOperations(operationsByTurnRef.current, turnId, status)
      if (next === operationsByTurnRef.current) return
      operationsByTurnRef.current = next
      setOperationsByTurn(next)
      const cached = threadHistoryCache.current.get(threadId)
      if (cached) cacheThreadSnapshot(cached.thread, cached.messages, {
        running: false,
        turnId: null,
        fileChangesByTurn: cached.fileChangesByTurn,
        operationsByTurn: next,
      })
      return
    }
    const cached = threadHistoryCache.current.get(threadId)
    if (!cached) return
    const next = finishTurnOperations(cached.operationsByTurn, turnId, status)
    if (next === cached.operationsByTurn) return
    cacheThreadSnapshot(cached.thread, cached.messages, {
      running: false,
      turnId: null,
      fileChangesByTurn: cached.fileChangesByTurn,
      operationsByTurn: next,
    })
  }, [cacheThreadSnapshot])

  const updateCachedThreadRunState = useCallback((threadId: string, running: boolean, turnId: string | null) => {
    const cache = threadHistoryCache.current
    const current = cache.get(threadId)
    if (!current) return
    cache.delete(threadId)
    const updated = { ...current, running, turnId }
    cache.set(threadId, updated)
    schedulePersistentThreadCacheWrite(threadId, updated)
  }, [schedulePersistentThreadCacheWrite])

  const prefetchThread = useCallback(async (thread: CodexThread, force = false) => {
    if (!prefetchHistory || handedOffRef.current) return
    if (!thread.id || thread.id === activeThreadId.current) return
    const cache = threadHistoryCache.current
    const cached = cache.get(thread.id)
    if (!force && cached && threadTimestamp(cached.thread) >= threadTimestamp(thread)) return
    if (prefetchingThreadIds.current.has(thread.id)) {
      if (force) forcedPrefetchThreadIds.current.add(thread.id)
      return
    }
    prefetchingThreadIds.current.add(thread.id)
    try {
      const loadedThread = await codexRemoteClient.readThread(token, thread.id)
      if (thread.id === activeThreadId.current) return
      const cachedThread = cache.get(thread.id)
      const loadedMessages = preserveCurrentImages(messagesFromThread(loadedThread), cachedThread?.messages ?? [])
      cacheThreadSnapshot(loadedThread, loadedMessages, {
        ...latestTurnState(loadedThread),
        complete: true,
        fileChangesByTurn: mergeFileChangesByTurn(
          cachedThread?.fileChangesByTurn ?? {},
          fileChangesFromThread(loadedThread),
        ),
        operationsByTurn: mergeOperationsByTurn(
          operationsFromThread(loadedThread),
          cachedThread?.operationsByTurn ?? {},
        ),
      })
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
    } finally {
      prefetchingThreadIds.current.delete(thread.id)
      if (forcedPrefetchThreadIds.current.delete(thread.id) && thread.id !== activeThreadId.current) {
        void prefetchThread({ id: thread.id }, true)
      }
    }
  }, [cacheThreadSnapshot, onUnauthorized, prefetchHistory, token])

  const scheduleThreadPrefetch = useCallback((nextThreads: CodexThread[]) => {
    if (!prefetchHistory || handedOffRef.current) return
    const candidates = nextThreads
      .filter((thread) => thread.id !== activeThreadId.current)
      .slice(0, maxBackgroundPrefetchThreads)
    if (candidates.length === 0) return
    if (threadPrefetchTimer.current !== undefined) window.clearTimeout(threadPrefetchTimer.current)
    threadPrefetchTimer.current = window.setTimeout(() => {
      threadPrefetchTimer.current = undefined
      void (async () => {
        for (const thread of candidates) await prefetchThread(thread)
      })()
    }, backgroundPrefetchDelayMs)
  }, [prefetchHistory, prefetchThread])

  const clearThreadCompletion = useCallback((threadId: string) => {
    if (!threadId) return
    setCompletedThreadIds((current) => current.includes(threadId) ? current.filter((id) => id !== threadId) : current)
    setLatestThreadCompletion((current) => current?.threadId === threadId ? null : current)
  }, [])

  const markThreadCompletion = useCallback((threadId: string) => {
    if (!threadId || threadId === activeThreadId.current) return
    setCompletedThreadIds((current) => current.includes(threadId) ? current : [...current, threadId])
    setLatestThreadCompletion({ threadId, completedAt: Date.now() })
  }, [])

  const refreshThreads = useCallback(async () => {
    if (!loadThreads || handedOffRef.current) return null
    if (threadListRequest.current) return threadListRequest.current
    const request = (async () => {
      try {
        const next = await codexRemoteClient.threads(token)
        threadListRef.current = next
        threadListLoadedRef.current = true
        threadListFetchedAtRef.current = Date.now()
        setThreads(next)
        scheduleThreadPrefetch(next)
        return next
      } catch (reason) {
        if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
        setError(reason instanceof Error ? reason.message : '无法读取对话记录')
        return null
      }
    })()
    threadListRequest.current = request
    try {
      return await request
    } finally {
      if (threadListRequest.current === request) threadListRequest.current = null
    }
  }, [loadThreads, onUnauthorized, scheduleThreadPrefetch, token])

  const applyThreadName = useCallback((threadId: string, name: string | null) => {
    const updateName = (thread: CodexThread) => thread.id === threadId ? { ...thread, name } : thread
    setThreads((current) => current.map(updateName))
    setActiveThread((current) => current ? updateName(current) : current)

    const cached = threadHistoryCache.current.get(threadId)
    if (cached) {
      cacheThreadSnapshot(updateName(cached.thread), cached.messages, {
        running: cached.running,
        turnId: cached.turnId,
        fileChangesByTurn: cached.fileChangesByTurn,
        operationsByTurn: cached.operationsByTurn,
      })
    }
    if (persistActiveThread) {
      const persisted = readPersistedActiveThreadCache(threadId)
      if (persisted) persistActiveThreadCache(updateName(persisted.thread), persisted.messages)
    }
  }, [cacheThreadSnapshot, persistActiveThread])

  const renameThread = useCallback(async (threadId: string, name: string) => {
    try {
      const result = await codexRemoteClient.renameThread(token, threadId, name)
      applyThreadName(threadId, result.name)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (reason instanceof RemoteApiError && reason.status === 404) {
        throw new Error('当前运行的 Codex Remote 后端版本缺少会话重命名接口，请更新并重启后端后再试。')
      }
      throw reason
    }
  }, [applyThreadName, onUnauthorized, token])

  const refreshModels = useCallback(async () => {
    if (!loadModels || handedOffRef.current) return null
    try {
      const next = await codexRemoteClient.models(token)
      setModels(next)
      return next
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      return null
    }
  }, [loadModels, onUnauthorized, token])

  const loadThread = useCallback(async (
    threadId: string,
    revision = historyRevision.current,
    silent = false,
    preserveRunningTurnId: string | null = null,
  ) => {
    if (handedOffRef.current) return false
    const readSequence = ++historyReadSequence.current
    try {
      const thread = await codexRemoteClient.readThread(token, threadId)
      if (activeThreadId.current !== threadId || revision !== historyRevision.current || readSequence !== historyReadSequence.current) return false
      if (persistActiveThread) persistActiveThreadId(thread.id)
      setActiveThread((current) => sameActiveThread(current, thread) ? current : thread)
      const loadedMessages = messagesFromThread(thread)
      const waitingTurnId = queueRecoveryBarriers.current?.[thread.id]?.turnId ?? latestTurnState(thread).turnId
      const mightBeLegacyDuplicate = mightBeLegacyDuplicateQueuedMessage(
        queuedMessagesByThreadRef.current[thread.id] ?? [], messagesRef.current, waitingTurnId,
      )
      const legacyDuplicateId = legacyDuplicateQueuedMessageId(
        queuedMessagesByThreadRef.current[thread.id] ?? [],
        messagesRef.current,
        loadedMessages,
        waitingTurnId,
      )
      if (legacyDuplicateId) {
        updateQueuedMessages(thread.id, (current) => current.filter((message) => message.id !== legacyDuplicateId))
      }
      const deliveredQueuedIds = reconcileQueuedHistory(thread.id, loadedMessages)
      if (legacyDuplicateId) deliveredQueuedIds.add(legacyDuplicateId)
      const cachedMessages = preserveCurrentImages(loadedMessages, threadHistoryCache.current.get(thread.id)?.messages ?? [])
      const messagesWithLocalTiming = preserveCurrentImages(cachedMessages, messagesRef.current)
      const historicalFileChangesByTurn = mergeFileChangesByTurn(
        threadHistoryCache.current.get(thread.id)?.fileChangesByTurn ?? {},
        fileChangesFromThread(thread),
      )
      const currentOperations = threadHistoryCache.current.get(thread.id)?.operationsByTurn ?? {}
      const historicalOperationsByTurn = mergeOperationsByTurn(
        operationsFromThread(thread),
        thread.id === activeThreadId.current ? operationsByTurnRef.current : currentOperations,
      )
      if (persistActiveThread) persistActiveThreadCache(thread, messagesWithLocalTiming)
      const historyTurnState = latestTurnState(thread)
      const preserveStartedTurn = preserveRunningTurnId !== null && activeTurnId.current === preserveRunningTurnId
      const running = historyTurnState.running || (!historyTurnState.hasTurn && threadIsRunning(thread)) || preserveStartedTurn
      const latestTurnId = preserveStartedTurn
        ? preserveRunningTurnId
        : historyTurnState.turnId ?? (running ? activeTurnId.current : null)
      // A history read can finish while a reply is streaming (for example
      // after reconnecting). Give that partial server message the same stable
      // bubble as the socket stream instead of rendering both versions.
      const runningMessageId = running && latestTurnId
        ? streamingAssistantMessageId.current ?? streamingMessageId(latestTurnId)
        : null
      if (runningMessageId && !streamingAssistantMessageId.current) {
        streamingAssistantMessageId.current = runningMessageId
      }
      const streamedText = streamingAssistantText(streamingAssistantParts.current)
      cacheThreadSnapshot(thread, messagesWithLocalTiming, {
        running,
        turnId: latestTurnId,
        complete: true,
        fileChangesByTurn: historicalFileChangesByTurn,
        operationsByTurn: historicalOperationsByTurn,
      })
      setMessages((current) => {
        const remainingLocalMessages = deliveredQueuedIds.size > 0
          ? current.filter((message) => !deliveredQueuedIds.has(message.id))
          : current
        const loaded = preserveLocalQueuedMessages(preserveCurrentImages(messagesWithLocalTiming, remainingLocalMessages), remainingLocalMessages)
        const next = runningMessageId
          ? collapseAssistantMessagesForTurn(
            loaded,
            latestTurnId,
            runningMessageId,
            mergeStreamingText(assistantTextForTurn(current, latestTurnId, runningMessageId), streamedText),
          )
          : loaded
        return sameMessages(current, next) ? current : next
      })
      // Rebuild every turn's card from thread/read after a reconnect or hot
      // update, rather than keeping only the last global file-change state.
      setFileChangesByTurn(historicalFileChangesByTurn)
      operationsByTurnRef.current = historicalOperationsByTurn
      setOperationsByTurn(historicalOperationsByTurn)
      setActiveTurnId(running ? latestTurnId : null)
      if (running) startTurnTimerForTurn(latestTurnId, historyTurnState.startedAt)
      else {
        if (historyTurnState.turnId) turnStartedAtById.current.delete(historyTurnState.turnId)
        finishTurnTimer()
      }
      if (!running) {
        resetStreamingAssistant()
        if (interruptRequestedThreadId.current === threadId) {
          interruptRequestedThreadId.current = null
          interruptRequestedTurnId.current = null
          setIsInterrupting(false)
        }
      }
      setIsRunning(running)
      const hasQueuedMessages = Boolean(queuedMessagesByThreadRef.current[thread.id]?.length)
      const unverifiedAttempt = queuedMessagesByThreadRef.current[thread.id]?.[0]?.sendAttempt
      const recoveryBarrier = !running && (unverifiedAttempt || (mightBeLegacyDuplicate && !legacyDuplicateId))
        ? { turnId: latestTurnId, status: 'unverified' as const }
        : reconcileQueueRecoveryBarrier(
          queueRecoveryBarriers.current?.[thread.id],
          { ...historyTurnState, running, turnId: latestTurnId },
          hasQueuedMessages,
        )
      setQueueRecoveryBarrier(thread.id, recoveryBarrier)
      setQueueRecoveryReadyThreadId(!running && !recoveryBarrier ? thread.id : null)
      if (writerConflictRef.current) {
        if (running) {
          setActivity({ label: '此对话已有 Codex 任务在运行' })
        } else {
          writerConflictRef.current = false
          setWriterConflict(false)
          setActivity(null)
          setError((current) => current === activeWriterError ? null : current)
        }
      } else if (activityItemId.current === null) {
        const nextActivity = running ? { label: '正在思考' } : null
        setActivity((current) => sameActivity(current, nextActivity) ? current : nextActivity)
      }
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (activeThreadId.current !== threadId || revision !== historyRevision.current) return false
      if (isActiveWriterError(reason)) {
        writerConflictRef.current = true
        setWriterConflict(true)
        setIsRunning(true)
        setActivity({ label: '此对话已有其他 Codex 实例在运行' })
        setError(activeWriterError)
      } else if (!silent) {
        setError(reason instanceof Error ? reason.message : '无法读取对话内容')
      }
      return false
    }
  }, [cacheThreadSnapshot, finishTurnTimer, onUnauthorized, persistActiveThread, reconcileQueuedHistory, resetStreamingAssistant, setActiveTurnId, setQueueRecoveryBarrier, startTurnTimerForTurn, token, updateQueuedMessages])

  const refreshThreadForRemoteMessage = useCallback((threadId: string, turnId: string | null, messageItemId?: string) => {
    if (!threadId || threadId !== activeThreadId.current) return
    if ([...pendingTurnDeliveries.current.values()].some((delivery) => delivery.threadId === threadId)) return
    const cachedMessages = threadHistoryCache.current.get(threadId)?.messages ?? []
    if (messageItemId && (messagesRef.current.some((message) => message.id === messageItemId || message.sourceItemId === messageItemId)
      || cachedMessages.some((message) => message.id === messageItemId || message.sourceItemId === messageItemId))) return
    if (!messageItemId && turnId && messagesRef.current.some((message) => message.role === 'user' && message.turnId === turnId)) return
    const revision = ++historyRevision.current
    void loadThread(threadId, revision, true, turnId)
  }, [loadThread])

  const cacheVisibleThread = useCallback(() => {
    if (!activeThread || activeThread.id !== activeThreadId.current) return
    // An unopened thread has no history to restore yet; keep its loading state truthful.
    if (messages.length === 0 && !threadHistoryCache.current.has(activeThread.id)) return
    cacheThreadSnapshot(activeThread, messages, {
      running: isRunning,
      turnId: activeTurnId.current,
      fileChangesByTurn,
      operationsByTurn,
    })
  }, [activeThread, cacheThreadSnapshot, fileChangesByTurn, isRunning, messages, operationsByTurn])

  useEffect(() => {
    // Keep the in-memory/IndexedDB snapshot complete at idle. While a reply
    // streams, every new chunk changes messages; scanning and scheduling a
    // whole-thread snapshot for each chunk makes long conversations jank.
    // Switching threads still calls cacheVisibleThread() explicitly.
    if (!isRunning) cacheVisibleThread()
  }, [cacheVisibleThread, isRunning])

  const dispatchInterrupt = useCallback(async (threadId: string, turnId: string) => {
    if (handedOffRef.current) return false
    if (interruptRequestedThreadId.current !== threadId || interruptInFlightThreadId.current === threadId) return false
    interruptInFlightThreadId.current = threadId
    try {
      const result = await codexRemoteClient.interrupt(token, threadId, turnId)
      if (!result.interrupted) throw new Error('Codex 没有接受停止请求')
      // The server has accepted the stop even though its completed
      // notification may arrive a little later. Close the old visible bubble
      // now, while keeping the running lock until that notification confirms
      // the turn is actually over.
      if (activeTurnId.current === turnId) finalizeVisibleStreamingTurn(turnId)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (interruptRequestedThreadId.current === threadId) {
        interruptRequestedThreadId.current = null
        interruptRequestedTurnId.current = null
        setIsInterrupting(false)
        setError(reason instanceof Error ? reason.message : '停止 Codex 任务失败')
      }
      return false
    } finally {
      if (interruptInFlightThreadId.current === threadId) interruptInFlightThreadId.current = null
    }
  }, [finalizeVisibleStreamingTurn, onUnauthorized, token])

  const confirmedTurnDelivery = useCallback((requestId: string) => {
    const delivery = pendingTurnDeliveries.current.get(requestId)
    if (!delivery?.acknowledged) return null
    return {
      turn_id: delivery.turnId,
      completed: delivery.turnId !== null && delivery.completedTurnIds.has(delivery.turnId),
    }
  }, [])

  const applyTurnDelivery = useCallback((threadId: string, requestId: string, turnId: string | null) => {
    const delivery = pendingTurnDeliveries.current.get(requestId)
    if (delivery && delivery.threadId === threadId) {
      delivery.acknowledged = true
      delivery.turnId = turnId
      delivery.resolveReceipt?.({ turn_id: turnId, completed: turnId !== null && delivery.completedTurnIds.has(turnId) })
    }
    if (!turnId || activeThreadId.current !== threadId) return
    const previousMessageIds = delivery?.previousMessageIds ?? new Set<string>()
    setMessages((current) => {
      const next = reconcileDeliveredLocalMessage(current, requestId, turnId, previousMessageIds)
      return sameMessages(current, next) ? current : next
    })
  }, [])

  const requestTurnDelivery = useCallback(async (
    threadId: string,
    requestId: string,
    send: () => Promise<{ turn_id: string | null }>,
    previousMessageIds: ReadonlySet<string> = new Set(messagesRef.current.map((message) => message.id)),
  ) => {
    const delivery: PendingTurnDelivery = {
      threadId,
      turnId: null,
      acknowledged: false,
      completedTurnIds: new Set(),
      previousMessageIds,
    }
    const receipt = new Promise<{ turn_id: string | null; completed: boolean }>((resolve) => {
      delivery.resolveReceipt = resolve
    })
    // Callers keep this entry until their history verification also ends, so
    // a receipt arriving during that fallback can still confirm the send.
    pendingTurnDeliveries.current.set(requestId, delivery)
    try {
      const response = send().then((result) => {
        if (result.turn_id && pendingTurnDeliveries.current.get(requestId) === delivery) {
          applyTurnDelivery(threadId, requestId, result.turn_id)
        }
        return { ...result, completed: result.turn_id !== null && delivery.completedTurnIds.has(result.turn_id) }
      })
      // The WebSocket receipt names this exact request. It can arrive while
      // the HTTP response is still pending or has been lost on the way back.
      return await Promise.race([response, receipt])
    } catch (reason) {
      // The receipt names the exact request, so it remains authoritative if
      // the HTTP response (and a large history read) cannot reach the phone.
      const receipt = confirmedTurnDelivery(requestId)
      if (!isAmbiguousNetworkFailure(reason) || !receipt) throw reason
      return receipt
    }
  }, [applyTurnDelivery, confirmedTurnDelivery])

  const requestTurnStart = useCallback((threadId: string, payload: QueuedTurnPayload, previousMessageIds?: ReadonlySet<string>) => requestTurnDelivery(threadId, payload.id, async () => {
    const start = () => codexRemoteClient.startTurn(token, threadId, {
      prompt: payload.requestText,
      images: payload.images,
      documents: payload.documents,
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approvalPolicy,
      requestId: payload.id,
    })
    if (resumedThreadId.current !== threadId) {
      await codexRemoteClient.resumeThread(token, threadId, payload.id)
      resumedThreadId.current = threadId
    }
    try {
      return await start()
    } catch (reason) {
      if (!(reason instanceof Error) || !/thread not found/i.test(reason.message)) throw reason
      resumedThreadId.current = null
      // A cached acknowledgement from before an App Server restart cannot
      // restore its new process. Give this recovery its own stable ID.
      await codexRemoteClient.resumeThread(token, threadId, `${payload.id}:recover`)
      resumedThreadId.current = threadId
      return start()
    }
  }, previousMessageIds), [requestTurnDelivery, token])

  const appendQueuedMessageToActiveThread = useCallback((threadId: string, payload: QueuedTurnPayload, turnId?: string | null) => {
    if (activeThreadId.current !== threadId) return
    const localMessage = localMessageFromQueuedPayload(payload, turnId)
    setMessages((current) => {
      const existingIndex = current.findIndex((message) => message.id === localMessage.id)
      if (existingIndex < 0) return [...current, localMessage]
      const next = [...current]
      next[existingIndex] = { ...next[existingIndex], ...localMessage }
      return sameMessages(current, next) ? current : next
    })
  }, [])

  const removeQueuedMessageFromActiveThread = useCallback((threadId: string, messageId: string) => {
    const cachedThread = threadHistoryCache.current.get(threadId)
    if (cachedThread?.messages.some((message) => message.id === messageId)) {
      const cachedMessages = cachedThread.messages.filter((message) => message.id !== messageId)
      threadHistoryCache.current.set(threadId, {
        ...cachedThread,
        messages: cachedMessages,
        characters: cachedHistoryCharacters(cachedMessages),
      })
    }
    if (activeThreadId.current !== threadId) return
    setMessages((current) => {
      const next = current.filter((message) => message.id !== messageId)
      if (next.length === current.length) return current
      const turnId = activeTurnId.current
      const streamMessageId = streamingAssistantMessageId.current
      const streamedText = streamingAssistantText(streamingAssistantParts.current)
      if (!turnId || !streamMessageId || !streamedText) return next
      return collapseAssistantMessagesForTurn(next, turnId, streamMessageId, streamedText)
    })
  }, [])

  const beginEditQueuedMessage = useCallback((messageId: string) => {
    const threadId = activeThreadId.current
    if (!threadId || editingQueuedMessageByThread.current[threadId]) return false
    const steerPrefix = `${threadId}:`
    const steeringThreadMessage = [...queuedTurnSteersInFlight.current].some((requestKey) => requestKey.startsWith(steerPrefix))
    if (queuedTurnStartsInFlight.current.has(threadId) || steeringThreadMessage) return false
    if (!queuedMessagesByThreadRef.current[threadId]?.some((message) => message.id === messageId && !message.sendAttempt)) return false
    editingQueuedMessageByThread.current[threadId] = messageId
    editingQueuedMessageThreadById.current.set(messageId, threadId)
    if (queueRecoveryReadyThreadId === threadId) deferredQueueAdvanceAfterEdit.current.add(threadId)
    setQueueEditRevision((revision) => revision + 1)
    return true
  }, [queueRecoveryReadyThreadId])

  const updateQueuedMessage = useCallback((messageId: string, input: Pick<SendMessageInput, 'prompt' | 'images' | 'documents'>) => {
    const threadId = editingQueuedMessageThreadById.current.get(messageId)
    if (!threadId || editingQueuedMessageByThread.current[threadId] !== messageId) return false
    const text = input.prompt.trim()
    const images = [...input.images]
    const documents = [...(input.documents ?? [])]
    let updated = false
    updateQueuedMessages(threadId, (current) => {
      if (!current.some((message) => message.id === messageId)) return current
      updated = true
      return current.map((message) => message.id === messageId
        ? {
          ...message,
          text,
          requestText: queuedRequestText(text, documents),
          images,
          ...(documents.length > 0 ? { documents } : { documents: undefined }),
        }
        : message)
    })
    if (updated) setQueueRecoveryReadyThreadId((current) => current === threadId ? null : current)
    return updated
  }, [setQueueRecoveryReadyThreadId, updateQueuedMessages])

  const endEditQueuedMessage = useCallback((messageId: string) => {
    const threadId = editingQueuedMessageThreadById.current.get(messageId)
    if (!threadId || editingQueuedMessageByThread.current[threadId] !== messageId) return
    delete editingQueuedMessageByThread.current[threadId]
    editingQueuedMessageThreadById.current.delete(messageId)
    setQueueEditRevision((revision) => revision + 1)
  }, [])

  const startQueuedMessage = useCallback(async (threadId: string, messageId: string) => {
    if (handedOffRef.current) return false
    if (activeThreadId.current !== threadId
      && (!persistActiveThread || threadHasAnotherActiveController(threadId, queueControllerId.current))) return false
    if (editingQueuedMessageByThread.current[threadId]) return false
    if (queuedTurnStartsInFlight.current.has(threadId)) return false
    if ([...queuedTurnSteersInFlight.current].some((requestKey) => requestKey.startsWith(`${threadId}:`))) return false
    const payload = queuedMessagesByThreadRef.current[threadId]?.find((message) => message.id === messageId)
    if (!payload || payload.sendAttempt) return false
    if (activeThreadId.current === threadId
      && mightBeLegacyDuplicateQueuedMessage([payload], messagesRef.current, queueRecoveryBarriers.current?.[threadId]?.turnId ?? null)) {
      void loadThread(threadId, ++historyRevision.current, true)
      return false
    }
    // Every automatic start is gated here as well as in the UI effect: stale
    // completion events and hot-reload recovery must not bypass the persisted
    // turn barrier.
    const activeTurnForThread = activeThreadId.current === threadId ? activeTurnId.current : null
    if (!canAutomaticallyAdvanceQueue(queueRecoveryBarriers.current?.[threadId], activeTurnForThread)) return false
    queuedTurnStartsInFlight.current.add(threadId)
    recordQueuedSendAttempt(threadId, payload.id)
    const affectsActiveThread = activeThreadId.current === threadId
    if (affectsActiveThread) historyRevision.current += 1
    try {
      const turnResult = await requestTurnStart(threadId, payload)
      const alreadyReconciled = !queuedMessagesByThreadRef.current[threadId]?.some((message) => message.id === payload.id)
      if (alreadyReconciled) {
        if (activeThreadId.current === threadId) setError(null)
        return true
      }
      updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== payload.id))
      if (!turnResult.completed && queuedMessagesByThreadRef.current[threadId]?.length) {
        const activeOrCachedTurnId = activeThreadId.current === threadId
          ? activeTurnId.current
          : threadHistoryCache.current.get(threadId)?.turnId ?? null
        setQueueRecoveryBarrier(threadId, {
          turnId: turnResult.turn_id ?? activeOrCachedTurnId ?? queueRecoveryBarriers.current?.[threadId]?.turnId ?? null,
          status: 'running',
        })
      }
      if (activeThreadId.current === threadId) {
        if (turnResult.completed) {
          setError(null)
          void loadThread(threadId, ++historyRevision.current, true)
          return true
        }
        const turnId = turnResult.turn_id
        const previousTurnId = activeTurnId.current
        if (previousTurnId && turnId && previousTurnId !== turnId) {
          finalizeVisibleStreamingTurn(previousTurnId)
          finalizeTurnOperations(
            threadId,
            previousTurnId,
            interruptRequestedTurnId.current === previousTurnId ? 'stopped' : 'completed',
          )
        }
        if (turnId) {
          setActiveTurnId(turnId)
          startTurnTimerForTurn(turnId)
        }
        appendQueuedMessageToActiveThread(threadId, payload, turnId)
        interruptRequestedThreadId.current = null
        interruptRequestedTurnId.current = null
        interruptInFlightThreadId.current = null
        setIsInterrupting(false)
        setQueueRecoveryReadyThreadId(null)
        setIsRunning(true)
        setActivity({ label: '正在思考' })
        writerConflictRef.current = false
        setWriterConflict(false)
      }
      if (activeThreadId.current === threadId) setError(null)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (isAmbiguousNetworkFailure(reason)) reconnectRef.current(true)
      const definitelyRejected = reason instanceof RemoteApiError
        && (reason.status < 500 || isActiveWriterError(reason))
      if (definitelyRejected) {
        setQueueRecoveryBarrier(threadId, {
          turnId: activeThreadId.current === threadId ? activeTurnId.current : queueRecoveryBarriers.current?.[threadId]?.turnId ?? null,
          status: 'unverified',
        })
        if (activeThreadId.current === threadId) setQueueRecoveryReadyThreadId(null)
        updateQueuedMessages(threadId, (current) => current.map((message) => message.id === payload.id
          ? { ...message, sendAttempt: undefined }
          : message))
      } else if (activeThreadId.current === threadId) {
        // A lost response may mean Codex is already answering this request.
        // Read history before this queue item can be sent again.
        void loadThread(threadId, ++historyRevision.current, true)
      }
      if (activeThreadId.current === threadId) {
        const message = reason instanceof Error ? reason.message : '发送排队消息失败'
        if (isActiveWriterError(reason)) {
          writerConflictRef.current = true
          setWriterConflict(true)
          setIsRunning(true)
          setActivity({ label: '此对话已有其他 Codex 实例在运行' })
          setError(activeWriterError)
        } else {
          setError(/thread not found/i.test(message)
            ? '本机 Codex 已找不到这条对话。排队消息仍保留，请新建对话后重新发送。'
            : message)
        }
      }
      return false
    } finally {
      pendingTurnDeliveries.current.delete(payload.id)
      queuedTurnStartsInFlight.current.delete(threadId)
      if (activeThreadId.current === threadId && queuedMessagesByThreadRef.current[threadId]?.length) {
        setQueueEditRevision((revision) => revision + 1)
      }
    }
  }, [appendQueuedMessageToActiveThread, finalizeTurnOperations, finalizeVisibleStreamingTurn, loadThread, onUnauthorized, persistActiveThread, recordQueuedSendAttempt, requestTurnStart, setActiveTurnId, setQueueRecoveryBarrier, startTurnTimerForTurn, updateQueuedMessages])

  const startNextQueuedMessage = useCallback(async (threadId: string) => {
    if (editingQueuedMessageByThread.current[threadId]) {
      deferredQueueAdvanceAfterEdit.current.add(threadId)
      return false
    }
    const activeTurnForThread = activeThreadId.current === threadId ? activeTurnId.current : null
    if (!canAutomaticallyAdvanceQueue(queueRecoveryBarriers.current?.[threadId], activeTurnForThread)) return false
    const next = queuedMessagesByThreadRef.current[threadId]?.[0]
    if (!next) {
      deferredQueueAdvanceAfterEdit.current.delete(threadId)
      return false
    }
    return next ? startQueuedMessage(threadId, next.id) : false
  }, [startQueuedMessage])

  const sendQueuedMessageNow = useCallback(async (messageId: string) => {
    if (handedOffRef.current) {
      setError('网页端已交还给本机 Codex，请先重新接管网页端。')
      return false
    }
    const threadId = activeThreadId.current
    if (!threadId || editingQueuedMessageByThread.current[threadId] || queuedTurnStartsInFlight.current.has(threadId)) return false
    const payload = queuedMessagesByThreadRef.current[threadId]?.find((message) => message.id === messageId)
    if (!payload) return false
    if (payload.sendAttempt) {
      setError('这条排队消息的送达状态尚未确认，请先核对聊天记录；需要重发时可移除后重新输入。')
      return false
    }
    const requestKey = `${threadId}:${messageId}`
    if (queuedTurnSteersInFlight.current.has(requestKey)) return false
    queuedTurnSteersInFlight.current.add(requestKey)
    const currentTurnId = activeTurnId.current
    recordQueuedSendAttempt(threadId, payload.id, currentTurnId)
    // Close the old visible reply and place the user's prompt before awaiting
    // HTTP. App Server may accept the steer and emit its next deltas first.
    if (currentTurnId) finalizeVisibleStreamingTurn(currentTurnId)
    appendQueuedMessageToActiveThread(threadId, payload, currentTurnId)
    try {
      const result = await requestTurnDelivery(threadId, payload.id, () => codexRemoteClient.steerTurn(token, threadId, {
        prompt: payload.requestText,
        images: payload.images,
        documents: payload.documents,
        requestId: payload.id,
      }))
      updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== payload.id))
      if (activeThreadId.current === threadId) {
        if (result.completed) void loadThread(threadId, ++historyRevision.current, true)
        setError(null)
      }
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (isAmbiguousNetworkFailure(reason)) reconnectRef.current(true)
      // The active reply may have completed in the interval before the click
      // reached the server. Re-read the authoritative turn state first so a
      // stale local turn ID cannot silently block the fallback start.
      if (reason instanceof RemoteApiError && reason.status === 409 && /没有可立即发送的回复/.test(reason.message)) {
        const refreshed = await loadThread(threadId, historyRevision.current)
        if (!refreshed) {
          removeQueuedMessageFromActiveThread(threadId, payload.id)
          return false
        }
        if (!queuedMessagesByThreadRef.current[threadId]?.some((message) => message.id === payload.id)) return true
        queuedTurnSteersInFlight.current.delete(requestKey)
        updateQueuedMessages(threadId, (current) => current.map((message) => message.id === payload.id
          ? { ...message, sendAttempt: undefined }
          : message))
        setQueueRecoveryBarrier(threadId, null)
        const started = await startQueuedMessage(threadId, messageId)
        if (!started) removeQueuedMessageFromActiveThread(threadId, payload.id)
        return started
      }
      if (activeThreadId.current === threadId) {
        setError(reason instanceof Error ? reason.message : '立即发送排队消息失败')
      }
      if (reason instanceof RemoteApiError && reason.status < 500) {
        setQueueRecoveryBarrier(threadId, { turnId: activeTurnId.current, status: 'unverified' })
        setQueueRecoveryReadyThreadId(null)
        updateQueuedMessages(threadId, (current) => current.map((message) => message.id === payload.id
          ? { ...message, sendAttempt: undefined }
          : message))
      } else {
        void loadThread(threadId, ++historyRevision.current, true)
      }
      if (!isAmbiguousNetworkFailure(reason)) removeQueuedMessageFromActiveThread(threadId, payload.id)
      return false
    } finally {
      pendingTurnDeliveries.current.delete(payload.id)
      queuedTurnSteersInFlight.current.delete(requestKey)
      if (activeThreadId.current === threadId && queuedMessagesByThreadRef.current[threadId]?.length) {
        setQueueEditRevision((revision) => revision + 1)
      }
    }
  }, [appendQueuedMessageToActiveThread, finalizeVisibleStreamingTurn, loadThread, onUnauthorized, recordQueuedSendAttempt, removeQueuedMessageFromActiveThread, requestTurnDelivery, setQueueRecoveryBarrier, startQueuedMessage, token, updateQueuedMessages])

  const removeQueuedMessage = useCallback((messageId: string) => {
    const threadId = activeThreadId.current
    if (!threadId || editingQueuedMessageByThread.current[threadId]) return
    updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== messageId))
  }, [updateQueuedMessages])

  const sharedQueueAction = useCallback(async (threadId: string, action: 'edit/begin' | 'edit/end' | 'remove' | 'send-now', messageId: string) => {
    try {
      const result = await codexRemoteClient.queueAction(token, threadId, action, messageId, queueControllerId.current)
      applyServerQueueResponse(threadId, result.queue)
      if (action === 'send-now' && result.sent && activeThreadId.current === threadId) {
        void loadThread(threadId, ++historyRevision.current, true)
      }
      if (action === 'send-now' && !result.sent) {
        setError('Codex 未确认这条消息已送达；请先核对聊天记录，不要重复发送。')
      } else {
        setError(null)
      }
      return action === 'send-now' ? Boolean(result.sent) : true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '排队消息操作失败')
      void refreshServerQueue(threadId)
      return false
    }
  }, [applyServerQueueResponse, loadThread, onUnauthorized, refreshServerQueue, token])

  const sharedBeginQueuedEdit = useCallback(async (messageId: string) => {
    const threadId = activeThreadId.current
    if (!threadId) return false
    const began = await sharedQueueAction(threadId, 'edit/begin', messageId)
    if (began) editingQueuedMessageThreadById.current.set(messageId, threadId)
    return began
  }, [sharedQueueAction])

  const sharedUpdateQueuedMessage = useCallback(async (messageId: string, input: Pick<SendMessageInput, 'prompt' | 'images' | 'documents'>) => {
    const threadId = editingQueuedMessageThreadById.current.get(messageId)
    const previous = threadId ? serverQueuedMessagesByThreadRef.current[threadId]?.find((message) => message.id === messageId) : undefined
    if (!threadId || !previous) return false
    const text = input.prompt.trim()
    const documents = input.documents ?? []
    try {
      const result = await codexRemoteClient.updateQueuedMessage(token, threadId, {
        ...previous,
        text,
        requestText: queuedRequestText(text, documents),
        images: input.images,
        documents,
        sendAttempt: undefined,
        editing: undefined,
      })
      applyServerQueueResponse(threadId, result.queue)
      setError(null)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '更新排队消息失败')
      void refreshServerQueue(threadId)
      return false
    }
  }, [applyServerQueueResponse, onUnauthorized, refreshServerQueue, token])

  const sharedEndQueuedEdit = useCallback(async (messageId: string) => {
    const threadId = editingQueuedMessageThreadById.current.get(messageId) ?? activeThreadId.current
    if (!threadId) return false
    const ended = await sharedQueueAction(threadId, 'edit/end', messageId)
    if (ended) editingQueuedMessageThreadById.current.delete(messageId)
    return ended
  }, [sharedQueueAction])

  const sharedRemoveQueuedMessage = useCallback(async (messageId: string) => {
    const threadId = activeThreadId.current
    if (!threadId) return false
    const pending = pendingServerQueueRemovals.current.get(threadId) ?? new Set<string>()
    if (pending.has(messageId)) return false
    pending.add(messageId)
    pendingServerQueueRemovals.current.set(threadId, pending)
    // Invalidate older reads before hiding the item so they cannot restore it
    // while a slow mobile request is still in flight.
    serverQueueFetchVersion.current.set(threadId, (serverQueueFetchVersion.current.get(threadId) ?? 0) + 1)
    publishServerQueue(threadId, serverQueuedMessagesByThreadRef.current[threadId] ?? [])
    try {
      const result = await codexRemoteClient.queueAction(token, threadId, 'remove', messageId, queueControllerId.current)
      pending.delete(messageId)
      if (pending.size === 0) pendingServerQueueRemovals.current.delete(threadId)
      applyServerQueueResponse(threadId, result.queue)
      setError(null)
      return true
    } catch (reason) {
      pending.delete(messageId)
      if (pending.size === 0) pendingServerQueueRemovals.current.delete(threadId)
      publishServerQueue(threadId, serverQueuedMessagesByThreadRef.current[threadId] ?? [])
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '移除排队消息失败')
      void refreshServerQueue(threadId)
      return false
    }
  }, [applyServerQueueResponse, onUnauthorized, publishServerQueue, refreshServerQueue, token])

  const sharedSendQueuedMessageNow = useCallback(async (messageId: string) => {
    const threadId = activeThreadId.current
    return threadId ? sharedQueueAction(threadId, 'send-now', messageId) : false
  }, [sharedQueueAction])

  useEffect(() => {
    const threadId = activeThread?.id
    const queued = threadId ? queuedMessagesByThread[threadId] : undefined
    const deferredAdvance = threadId ? deferredQueueAdvanceAfterEdit.current.has(threadId) : false
    if (
      !threadId
      || (!deferredAdvance && queueRecoveryReadyThreadId !== threadId)
      || !queued?.length
      || loadingHistory
      || connection !== 'connected'
      || handedOff
      || isRunning
      || isInterrupting
      || writerConflict
    ) return
    if (editingQueuedMessageByThread.current[threadId]) {
      deferredQueueAdvanceAfterEdit.current.add(threadId)
      return
    }
    if (deferredAdvance) deferredQueueAdvanceAfterEdit.current.delete(threadId)
    void startNextQueuedMessage(threadId)
  }, [activeThread?.id, connection, handedOff, isInterrupting, isRunning, loadingHistory, queueEditRevision, queueRecoveryReadyThreadId, queuedMessagesByThread, startNextQueuedMessage, writerConflict])

  const restoreActiveThread = useCallback(async () => {
    if (handedOffRef.current) return
    const threadId = activeThreadId.current
    if (!threadId || restoringThreadId.current === threadId) return
    restoringThreadId.current = threadId
    if (messagesRef.current.length === 0) setLoadingHistory(true)
    try {
      if (loadThreads) await refreshThreads()
      let cached = threadHistoryCache.current.get(threadId) ?? null
      if (!cached?.complete) cached = await restorePersistentThreadCache(threadId) ?? cached
      if (activeThreadId.current !== threadId) return

      const latestThread = threadListRef.current.find((candidate) => candidate.id === threadId)
      if (cached) {
        const mergedThread = latestThread ? { ...cached.thread, ...latestThread } : cached.thread
        setActiveThread(mergedThread)
        setMessages(cached.messages)
        setFileChangesByTurn(cached.fileChangesByTurn)
        operationsByTurnRef.current = cached.operationsByTurn
        setOperationsByTurn(cached.operationsByTurn)
        setIsRunning(Boolean(cached.running || (latestThread && threadIsRunning(latestThread))))
        setActiveTurnId(cached.running ? cached.turnId : null)
        setLoadingHistory(false)
      }

      const hasQueuedMessages = Boolean(queuedMessagesByThreadRef.current[threadId]?.length)
      const metadataIsFresh = (
        (threadListLoadedRef.current && Date.now() - threadListFetchedAtRef.current <= threadMetadataFreshnessMs)
        || (connectionRef.current === 'connected' && latestThread?.updatedAt !== undefined)
      )
      if (cached && cachedHistoryMatchesThreadMetadata(
        cached,
        latestThread,
        metadataIsFresh,
        hasQueuedMessages,
      ) && !hasQueuedMessages) {
        setQueueRecoveryReadyThreadId(threadId)
        return
      }
      await loadThread(threadId)
    } finally {
      if (restoringThreadId.current !== threadId) return
      restoringThreadId.current = null
      if (activeThreadId.current === threadId) setLoadingHistory(false)
    }
  }, [loadThread, loadThreads, refreshThreads, restorePersistentThreadCache, setActiveTurnId])

  const verifyQueuedThreadAndAdvance = useCallback(async (threadId: string) => {
    if (handedOffRef.current || !queuedMessagesByThreadRef.current[threadId]?.length) return false
    if (activeThreadId.current !== threadId
      && (!persistActiveThread || threadHasAnotherActiveController(threadId, queueControllerId.current))) return false
    try {
      const thread = await codexRemoteClient.readThread(token, threadId)
      if (activeThreadId.current !== threadId
        && threadHasAnotherActiveController(threadId, queueControllerId.current)) return false
      if (!queuedMessagesByThreadRef.current[threadId]?.length) return false
      if (activeThreadId.current === threadId) {
        await loadThread(threadId, historyRevision.current, true)
        return false
      }
      const historyMessages = messagesFromThread(thread)
      const waitingTurnId = queueRecoveryBarriers.current?.[threadId]?.turnId ?? latestTurnState(thread).turnId
      const cachedMessages = threadHistoryCache.current.get(threadId)?.messages ?? []
      const mightBeLegacyDuplicate = mightBeLegacyDuplicateQueuedMessage(
        queuedMessagesByThreadRef.current[threadId] ?? [], cachedMessages, waitingTurnId,
      )
      const legacyDuplicateId = legacyDuplicateQueuedMessageId(
        queuedMessagesByThreadRef.current[threadId] ?? [], cachedMessages, historyMessages, waitingTurnId,
      )
      if (legacyDuplicateId) {
        updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== legacyDuplicateId))
      }
      reconcileQueuedHistory(threadId, historyMessages)
      const head = queuedMessagesByThreadRef.current[threadId]?.[0]
      if (!head) {
        setQueueRecoveryBarrier(threadId, null)
        return false
      }
      const historyTurnState = latestTurnState(thread)
      const running = historyTurnState.running || (!historyTurnState.hasTurn && threadIsRunning(thread))
      const turnState = { ...historyTurnState, running }
      const barrier = !running && (head.sendAttempt || (mightBeLegacyDuplicate && !legacyDuplicateId))
        ? { turnId: historyTurnState.turnId, status: 'unverified' as const }
        : reconcileQueueRecoveryBarrier(queueRecoveryBarriers.current?.[threadId], turnState, true)
      setQueueRecoveryBarrier(threadId, barrier)
      if (running || barrier) return false
      return startNextQueuedMessage(threadId)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      return false
    }
  }, [loadThread, onUnauthorized, persistActiveThread, reconcileQueuedHistory, setQueueRecoveryBarrier, startNextQueuedMessage, token, updateQueuedMessages])

  const handleEvent = useCallback((event: RemoteEvent) => {
    if (handedOffRef.current && event.type !== 'connection') return
    if (event.type === 'remote.queue.changed') {
      if (event.threadId && event.threadId === activeThreadId.current) void refreshServerQueue(event.threadId)
      return
    }
    if (event.type === 'remote.pins.changed') {
      setPinRevision((revision) => revision + 1)
      return
    }
    if (event.type === 'threads.changed') {
      void refreshThreads()
      if (activeThreadId.current && writerRefreshTimer.current === undefined) {
        writerRefreshTimer.current = window.setTimeout(() => {
          writerRefreshTimer.current = undefined
          if (activeThreadId.current) void loadThread(activeThreadId.current, historyRevision.current, true)
        }, 700)
      }
      return
    }
    if (event.type === 'connection') {
      if (!event.connected) resumedThreadId.current = null
      const eventHandedOff = event.handedOff ?? handedOffRef.current
      if (eventHandedOff) {
        setHandoffState(true)
        setConnectionState('disconnected')
      }
      setRuntime({
        available: Boolean(event.available),
        connected: Boolean(event.connected),
        workspace: event.workspace ?? '',
        handedOff: eventHandedOff,
        runtimeMode: event.runtimeMode,
        runtimeMessage: event.runtimeMessage ?? null,
        fallbackReason: event.fallbackReason ?? null,
        error: event.error ?? null,
      })
      if (eventHandedOff) setError(null)
      else if (event.error) setError(event.error)
      else if (event.connected) setError(null)
      return
    }
    if (event.type === 'error') {
      setError(event.message ?? 'Codex 请求失败')
      return
    }
    if (event.type === 'turn.delivery') {
      const requestId = typeof event.request_id === 'string' ? event.request_id : null
      const delivery = requestId ? pendingTurnDeliveries.current.get(requestId) : undefined
      if (requestId && delivery && delivery.threadId === event.params?.threadId) {
        applyTurnDelivery(
          delivery.threadId,
          requestId,
          typeof event.params.turnId === 'string' ? event.params.turnId : null,
        )
      }
      return
    }
    if (event.type === 'server_request') {
      const requestMethod = event.method ?? ''
      const supportedApproval = requestMethod === 'item/commandExecution/requestApproval'
        || requestMethod === 'item/fileChange/requestApproval'
        || requestMethod === 'execCommandApproval'
        || requestMethod === 'applyPatchApproval'
      if (supportedApproval && (typeof event.request_id === 'string' || typeof event.request_id === 'number')) {
        setApproval({ requestId: event.request_id, method: requestMethod, params: event.params ?? {} })
      }
      return
    }
    if (event.type !== 'notification' || !event.method) return

    const params = event.params ?? {}
    const eventTurn = params.turn as Record<string, unknown> | undefined
    const eventThreadId = typeof params.threadId === 'string'
      ? params.threadId
      : typeof eventTurn?.threadId === 'string' ? eventTurn.threadId : null
    const eventTurnId = typeof eventTurn?.id === 'string'
      ? eventTurn.id
      : typeof params.turnId === 'string' ? params.turnId : null
    if (event.method === 'thread/name/updated') {
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      if (threadId && (typeof params.threadName === 'string' || params.threadName === null)) {
        applyThreadName(threadId, params.threadName)
      }
      return
    }
    if (event.method === 'turn/completed') {
      const completedThreadId = eventThreadId ?? activeThreadId.current
      const completedTurnId = eventTurnId ?? activeTurnId.current
      if (completedThreadId && completedTurnId) {
        for (const delivery of pendingTurnDeliveries.current.values()) {
          if (delivery.threadId === completedThreadId) delivery.completedTurnIds.add(completedTurnId)
        }
      }
    }
    // Older app-server notifications can omit threadId on item deltas. When
    // that happens, use the active turn as the second routing key so a second
    // pane does not render another pane's stream.
    if (!eventThreadId && eventTurnId && eventTurnId !== activeTurnId.current) return
    if (eventThreadId && eventThreadId !== activeThreadId.current) {
      const manageBackgroundQueue = persistActiveThread
        && !threadHasAnotherActiveController(eventThreadId, queueControllerId.current)
      if (event.method === 'turn/started') {
        if (manageBackgroundQueue && queuedMessagesByThreadRef.current[eventThreadId]?.length) {
          setQueueRecoveryBarrier(eventThreadId, { turnId: eventTurnId, status: 'running' })
        }
        updateCachedThreadRunState(eventThreadId, true, eventTurnId)
        clearThreadCompletion(eventThreadId)
        void refreshThreads()
      } else if (event.method === 'turn/completed') {
        const cachedTurnId = threadHistoryCache.current.get(eventThreadId)?.turnId ?? null
        const completedTurnId = typeof eventTurn?.id === 'string' ? eventTurn.id : eventTurnId ?? cachedTurnId
        const turnStatus = normalizedOperationStatus(eventTurn?.status, 'completed')
        finalizeTurnOperations(eventThreadId, completedTurnId, turnStatus === 'running' ? 'completed' : turnStatus)
        if (completedTurnId) turnStartedAtById.current.delete(completedTurnId)
        updateCachedThreadRunState(eventThreadId, false, null)
        markThreadCompletion(eventThreadId)
        if (manageBackgroundQueue && queuedMessagesByThreadRef.current[eventThreadId]?.length) {
          const completedStatus = normalizedOperationStatus(eventTurn?.status, 'completed')
          if (completedStatus !== 'completed') {
            setQueueRecoveryBarrier(eventThreadId, {
              turnId: completedTurnId ?? queueRecoveryBarriers.current?.[eventThreadId]?.turnId ?? null,
              status: 'interrupted',
            })
          } else {
            void verifyQueuedThreadAndAdvance(eventThreadId)
          }
        }
        void prefetchThread({ id: eventThreadId }, true)
        void refreshThreads()
      } else if (event.method === 'item/started' || event.method === 'item/completed') {
        const item = params.item as Record<string, unknown> | undefined
        const turnId = typeof params.turnId === 'string' ? params.turnId : eventTurnId ?? threadHistoryCache.current.get(eventThreadId)?.turnId ?? null
        const operation = operationForItem(item, event.method === 'item/started'
          ? 'running'
          : normalizedOperationStatus(item?.status, 'completed') === 'running' ? 'completed' : undefined)
        if (operation) commitTurnOperation(eventThreadId, turnId, operation)
      } else if (event.method === 'item/fileChange/patchUpdated') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : null
        const turnId = typeof params.turnId === 'string' ? params.turnId : eventTurnId ?? threadHistoryCache.current.get(eventThreadId)?.turnId ?? null
        const operation = itemId ? operationForItem({
          id: itemId,
          type: 'fileChange',
          status: 'inProgress',
          changes: params.changes,
        }, 'running') : null
        if (operation) commitTurnOperation(eventThreadId, turnId, operation)
      } else if (event.method === 'turn/workspaceChanges') {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null
        const fileChange = turnId ? workspaceFileChange(turnId, params.changes) : null
        const cachedThread = threadHistoryCache.current.get(eventThreadId)
        if (turnId && fileChange && cachedThread) {
          cacheThreadSnapshot(cachedThread.thread, cachedThread.messages, {
            running: cachedThread.running,
            turnId: cachedThread.turnId,
            fileChangesByTurn: mergeFileChangesByTurn(cachedThread.fileChangesByTurn, { [turnId]: [fileChange] }),
            operationsByTurn: cachedThread.operationsByTurn,
          })
        } else if (turnId && fileChange) {
          void prefetchThread({ id: eventThreadId }, true)
        }
      }
      return
    }

    if (event.method === 'turn/started') {
      const turn = eventTurn
      const turnThreadId = eventThreadId ?? (typeof turn?.threadId === 'string' ? turn.threadId : activeThreadId.current)
      if (turnThreadId && turnThreadId !== activeThreadId.current) return
      historyRevision.current += 1
      const turnId = typeof turn?.id === 'string'
        ? turn.id
        : typeof params.turnId === 'string' ? params.turnId : null
      const startedAt = eventTimestamp(turn?.startedAt) ?? Date.now()
      if (turnThreadId && queuedMessagesByThreadRef.current[turnThreadId]?.length) {
        setQueueRecoveryBarrier(turnThreadId, { turnId, status: 'running' })
      }
      const previousTurnId = activeTurnId.current
      if (previousTurnId && turnId && previousTurnId !== turnId) {
        finalizeVisibleStreamingTurn(previousTurnId)
        finalizeTurnOperations(
          turnThreadId ?? activeThreadId.current,
          previousTurnId,
          interruptRequestedTurnId.current === previousTurnId ? 'stopped' : 'completed',
        )
      }
      if (turnId) {
        setActiveTurnId(turnId)
        const requestedTurnId = interruptRequestedTurnId.current
        if (turnThreadId && interruptRequestedThreadId.current === turnThreadId && (!requestedTurnId || requestedTurnId === turnId)) {
          void dispatchInterrupt(turnThreadId, turnId)
        } else if (turnThreadId && interruptRequestedThreadId.current === turnThreadId && requestedTurnId && requestedTurnId !== turnId) {
          // A new turn has begun after the requested stop. Do not carry the
          // old stop intent into the new turn.
          interruptRequestedThreadId.current = null
          interruptRequestedTurnId.current = null
          setIsInterrupting(false)
        }
      }
      setQueueRecoveryReadyThreadId(null)
      resetStreamingAssistant()
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(true)
      startTurnTimerForTurn(turnId, startedAt)
      setActivity({ label: interruptRequestedThreadId.current === turnThreadId ? '正在停止…' : '正在思考' })
      activityItemId.current = null
      if (turnThreadId) refreshThreadForRemoteMessage(turnThreadId, turnId)
      return
    }
    if (event.method === 'turn/completed') {
      const turn = eventTurn
      const turnThreadId = eventThreadId ?? (typeof turn?.threadId === 'string' ? turn.threadId : activeThreadId.current)
      if (turnThreadId && turnThreadId !== activeThreadId.current) return
      const completedTurnId = typeof turn?.id === 'string'
        ? turn.id
        : typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      const completedAt = eventTimestamp(turn?.completedAt) ?? Date.now()
      const completedStatus = normalizedOperationStatus(turn?.status, 'completed')
      finalizeTurnOperations(turnThreadId ?? activeThreadId.current, completedTurnId, completedStatus === 'running' ? 'completed' : completedStatus)
      const currentTurnId = activeTurnId.current
      if (completedTurnId && currentTurnId && completedTurnId !== currentTurnId) {
        // A delayed completion for the previous turn must not terminate a
        // newer turn that is already visible in this thread.
        finalizeVisibleStreamingTurn(completedTurnId, completedAt)
        if (interruptRequestedTurnId.current === completedTurnId) {
          interruptRequestedThreadId.current = null
          interruptRequestedTurnId.current = null
          setIsInterrupting(false)
        }
        return
      }
      setActiveTurnId(null)
      if (!turnThreadId || interruptRequestedThreadId.current === turnThreadId) {
        interruptRequestedThreadId.current = null
        interruptRequestedTurnId.current = null
        setIsInterrupting(false)
      }
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(false)
      const queuedThreadId = turnThreadId ?? activeThreadId.current
      const hasQueuedMessages = Boolean(queuedThreadId && queuedMessagesByThreadRef.current[queuedThreadId]?.length)
      const existingBarrier = queuedThreadId ? queueRecoveryBarriers.current?.[queuedThreadId] : undefined
      const canReleaseQueue = completionReleasesQueueBarrier(
        existingBarrier,
        completedTurnId,
        completedStatus === 'completed',
      ) && (!existingBarrier || currentTurnId === completedTurnId)
      const needsHistoryCheck = Boolean(canReleaseQueue && queuedThreadId && (
        queuedMessagesByThreadRef.current[queuedThreadId]?.[0]?.sendAttempt
        || mightBeLegacyDuplicateQueuedMessage(
          queuedMessagesByThreadRef.current[queuedThreadId] ?? [], messagesRef.current, completedTurnId,
        )
      ))
      if (queuedThreadId && hasQueuedMessages && completedStatus !== 'completed') {
        setQueueRecoveryBarrier(queuedThreadId, {
          turnId: completedTurnId ?? existingBarrier?.turnId ?? null,
          status: 'interrupted',
        })
      } else if (queuedThreadId && canReleaseQueue) {
        setQueueRecoveryBarrier(queuedThreadId, needsHistoryCheck
          ? { turnId: completedTurnId, status: 'unverified' }
          : null)
      }
      setQueueRecoveryReadyThreadId(canReleaseQueue && !needsHistoryCheck ? queuedThreadId : null)
      // Commit the accumulated text before finalizing the turn. This avoids a
      // trailing timer/transition from recreating a stale streaming message.
      finalizeVisibleStreamingTurn(completedTurnId, completedAt)
      finishTurnTimer()
      setActivity(null)
      activityItemId.current = null
      const refreshThreadId = activeThreadId.current
      const refreshRevision = ++historyRevision.current
      // Start only one queued item for each completed turn. Starting it bumps
      // the history revision, so the just-completed snapshot cannot overwrite
      // the optimistic queued user message while its new turn is starting.
      if (queuedThreadId && canReleaseQueue && !needsHistoryCheck) void startNextQueuedMessage(queuedThreadId)
      if (refreshThreadId) {
        void refreshThreads()
        void loadThread(refreshThreadId, refreshRevision)
      }
      return
    }
    if (event.method === 'turn/workspaceChanges') {
      const turnId = typeof params.turnId === 'string' ? params.turnId : null
      const fileChange = turnId ? workspaceFileChange(turnId, params.changes) : null
      if (fileChange) addFileChangeToTurn(turnId, fileChange)
      return
    }
    if (event.method === 'turn/plan/updated') {
      setActivity({ label: '正在整理执行计划' })
      return
    }
    if (event.method === 'reasoning/summaryTextDelta') {
      setActivity({ label: '正在思考' })
      return
    }
    if (event.method === 'item/started') {
      const item = params.item as Record<string, unknown> | undefined
      const fileChange = fileChangeForItem(item)
      const turnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      if (turnId && activeTurnId.current === null) setActiveTurnId(turnId)
      const itemType = typeof item?.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
      if (itemType === 'usermessage' && activeThreadId.current) {
        const itemId = typeof item?.id === 'string' ? item.id : undefined
        const pendingLocalDelivery = [...pendingTurnDeliveries.current.values()]
          .some((delivery) => delivery.threadId === activeThreadId.current)
        const remoteUserMessage = userMessageFromEventItem(item, turnId)
        const alreadyVisible = itemId ? messagesRef.current.some((message) =>
          message.id === itemId || message.sourceItemId === itemId,
        ) : false
        if (remoteUserMessage && !pendingLocalDelivery && !alreadyVisible) {
          const continuesTurn = Boolean(turnId && messagesRef.current.some((message) =>
            message.role === 'user' && message.turnId === turnId,
          ))
          if (continuesTurn && streamingAssistantTurnId.current === turnId) {
            finalizeVisibleStreamingTurn(turnId)
          }
          setMessages((current) => {
            const next = insertRemoteUserMessage(current, remoteUserMessage)
            return sameMessages(current, next) ? current : next
          })
        } else if (!remoteUserMessage) {
          refreshThreadForRemoteMessage(activeThreadId.current, turnId, itemId)
        }
      }
      if (fileChange) addFileChangeToTurn(turnId, fileChange)
      const operation = operationForItem(item, 'running')
      if (operation) commitTurnOperation(activeThreadId.current, turnId, operation)
      activityItemId.current = typeof item?.id === 'string' ? item.id : null
      setIsRunning(true)
      startTurnTimerForTurn(turnId)
      setActivity(activityForItem(item))
      return
    }
    if (event.method === 'item/fileChange/patchUpdated') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `file-change-${Date.now()}`
      const fileChange = fileChangeForItem({
        type: 'fileChange',
        id: itemId,
        status: 'inProgress',
        changes: params.changes,
      })
      const turnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      if (turnId && activeTurnId.current === null) setActiveTurnId(turnId)
      if (fileChange) addFileChangeToTurn(turnId, fileChange)
      const operation = operationForItem({
        id: itemId,
        type: 'fileChange',
        status: 'inProgress',
        changes: params.changes,
      }, 'running')
      if (operation) commitTurnOperation(activeThreadId.current, turnId, operation)
      setIsRunning(true)
      startTurnTimerForTurn(turnId)
      setActivity({ label: '正在修改文件', detail: fileChange ? `${fileChange.changes.length} 个文件` : undefined })
      return
    }
    if (event.method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `stream-${Date.now()}`
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const turnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      if (streamingAssistantTurnId.current && turnId && streamingAssistantTurnId.current !== turnId) {
        finalizeVisibleStreamingTurn(streamingAssistantTurnId.current)
      }
      if (!streamingAssistantTurnId.current) streamingAssistantTurnId.current = turnId
      const part = streamingAssistantParts.current.get(itemId) ?? ''
      streamingAssistantParts.current.set(itemId, part + delta)
      const messageId = streamingAssistantMessageId.current ?? streamingMessageId(turnId ?? activeTurnId.current)
      streamingAssistantMessageId.current = messageId
      activityItemId.current = itemId
      setActivity((current) => current?.label === '正在回复' && !current.detail ? current : { label: '正在回复' })
      scheduleStreamingAssistantRender()
      return
    }
    if (event.method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined
      const fileChange = fileChangeForItem(item)
      const turnId = typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      if (fileChange) addFileChangeToTurn(turnId, { ...fileChange, status: 'completed' })
      const operationStatus = normalizedOperationStatus(item?.status, 'completed')
      const operation = operationForItem(item, operationStatus === 'running' ? 'completed' : operationStatus)
      if (operation) commitTurnOperation(activeThreadId.current, turnId, operation)
      const itemId = typeof item?.id === 'string' ? item.id : null
      const itemType = typeof item?.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
      if (itemType !== 'agentmessage') {
        if (itemId && activityItemId.current === itemId) {
          activityItemId.current = null
          setActivity({ label: '正在思考' })
        }
        return
      }
      const text = typeof item?.text === 'string' ? item.text : ''
      if (!itemId) return
      if (streamingAssistantTurnId.current && turnId && streamingAssistantTurnId.current !== turnId) {
        finalizeVisibleStreamingTurn(streamingAssistantTurnId.current)
      }
      if (!streamingAssistantTurnId.current) streamingAssistantTurnId.current = turnId
      streamingAssistantParts.current.set(itemId, text || streamingAssistantParts.current.get(itemId) || '')
      const messageId = streamingAssistantMessageId.current ?? streamingMessageId(turnId ?? activeTurnId.current)
      streamingAssistantMessageId.current = messageId
      scheduleStreamingAssistantRender()
      return
    }
  }, [addFileChangeToTurn, applyThreadName, applyTurnDelivery, cacheThreadSnapshot, clearThreadCompletion, commitTurnOperation, dispatchInterrupt, finalizeTurnOperations, finalizeVisibleStreamingTurn, finishTurnTimer, loadThread, markThreadCompletion, persistActiveThread, prefetchThread, refreshServerQueue, refreshThreadForRemoteMessage, refreshThreads, resetStreamingAssistant, scheduleStreamingAssistantRender, setActiveTurnId, setConnectionState, setHandoffState, setQueueRecoveryBarrier, startNextQueuedMessage, startTurnTimerForTurn, updateCachedThreadRunState, verifyQueuedThreadAndAdvance])
  const handleEventRef = useRef(handleEvent)
  handleEventRef.current = handleEvent

  useEffect(() => {
    if (!enabled) {
      setConnectionState('disconnected')
      setLoadingHistory(false)
      return
    }
    let disposed = false
    let retryTimer: number | undefined
    let retryDelay = 500
    let socketGeneration = 0

    const connect = (force = false) => {
      if (disposed || handedOffRef.current) return
      if (!force && socketRef.current && connectionRef.current === 'connected') return
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        retryTimer = undefined
      }
      const currentGeneration = ++socketGeneration
      socketRef.current?.close()
      socketRef.current = codexRemoteClient.connect(token, (event) => {
        if (!disposed && currentGeneration === socketGeneration) handleEventRef.current(event)
      }, (nextState) => {
        if (disposed || currentGeneration !== socketGeneration) return
        if (handedOffRef.current) {
          setConnectionState('disconnected')
          return
        }
        setConnectionState(nextState)
        if (nextState !== 'connected') resumedThreadId.current = null
        if (nextState === 'connected') {
          retryDelay = 500
          void restoreActiveThread()
          if (loadThreads) void refreshThreads()
        } else if (nextState === 'disconnected' || nextState === 'unavailable') {
          if (retryTimer !== undefined) return
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined
            connect()
          }, retryDelay)
          retryDelay = Math.min(10_000, retryDelay * 2)
        }
      })
    }
    reconnectRef.current = connect

    let wasHidden = document.visibilityState === 'hidden'
    let lastBackgroundReconnectAt = 0
    const resumeFromBackground = (force = false) => {
      if (disposed || handedOffRef.current) return
      // Mobile browsers can fire visibilitychange and pageshow back-to-back.
      // Avoid replacing a healthy socket (and reloading the whole history)
      // merely because the page returned to the foreground.
      if (!force && connectionRef.current !== 'disconnected' && connectionRef.current !== 'unavailable') return
      const now = Date.now()
      if (now - lastBackgroundReconnectAt < 800) return
      lastBackgroundReconnectAt = now
      retryDelay = 500
      connect(force)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true
        return
      }
      if (!wasHidden) return
      wasHidden = false
      if (loadThreads) void refreshThreads()
      const threadId = activeThreadId.current
      const hasQueuedMessages = Boolean(threadId && queuedMessagesByThreadRef.current[threadId]?.length)
      // Android WebViews can leave a socket marked "connected" after the app
      // was backgrounded. Re-read only when a queue is waiting, so a missed
      // turn/completed event cannot strand its next message.
      if (connectionRef.current === 'connected') {
        if (hasQueuedMessages) void restoreActiveThread()
        return
      }
      resumeFromBackground()
    }
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resumeFromBackground(true)
    }
    const handleOnline = () => resumeFromBackground(true)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pageshow', handlePageShow)
    window.addEventListener('online', handleOnline)

    void (async () => {
      try {
        const nextRuntime = await codexRemoteClient.status(token)
        if (disposed) return
        setRuntime(nextRuntime)
        setHandoffState(nextRuntime.handedOff)
        if (nextRuntime.handedOff) {
          setConnectionState('disconnected')
          setLoadingHistory(false)
          return
        }
        connect()
        void restoreActiveThread()
        if (loadThreads) void refreshThreads()
        if (loadModels) void refreshModels()
      } catch (reason) {
        if (disposed) return
        if (reason instanceof RemoteApiError && reason.status === 401) {
          onUnauthorized()
          return
        }
        setError(reason instanceof Error ? reason.message : '无法连接本机服务')
        setConnectionState('unavailable')
        connect()
        setLoadingHistory(false)
      }
    })()

    return () => {
      disposed = true
      socketGeneration += 1
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (writerRefreshTimer.current !== undefined) window.clearTimeout(writerRefreshTimer.current)
      writerRefreshTimer.current = undefined
      if (threadPrefetchTimer.current !== undefined) window.clearTimeout(threadPrefetchTimer.current)
      if (cachedActiveThreadRefreshTimer.current !== undefined) window.clearTimeout(cachedActiveThreadRefreshTimer.current)
      if (streamingRenderTimer.current !== undefined) {
        window.clearTimeout(streamingRenderTimer.current)
        streamingRenderTimer.current = undefined
      }
      socketRef.current?.close()
      socketRef.current = null
      if (reconnectRef.current === connect) reconnectRef.current = () => {}
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pageshow', handlePageShow)
      window.removeEventListener('online', handleOnline)
    }
  }, [enabled, loadModels, loadThreads, onUnauthorized, refreshModels, refreshThreads, restoreActiveThread, setConnectionState, setHandoffState, token])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: number | undefined
    const reconcileHistory = async () => {
      try {
        const threadId = activeThreadId.current
        if (threadId && !handedOffRef.current && document.visibilityState === 'visible') {
          await loadThread(threadId, historyRevision.current, true)
        }
      } finally {
        if (!disposed) timer = window.setTimeout(reconcileHistory, 4000)
      }
    }
    timer = window.setTimeout(reconcileHistory, 4000)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [enabled, loadThread])

  const selectThread = useCallback(async (thread: CodexThread) => {
    if (handedOffRef.current) return
    if (!thread.id) return
    if (thread.id === activeThreadId.current) {
      clearThreadCompletion(thread.id)
      return
    }
    if (cachedActiveThreadRefreshTimer.current !== undefined) {
      window.clearTimeout(cachedActiveThreadRefreshTimer.current)
      cachedActiveThreadRefreshTimer.current = undefined
    }
    const previousThread = activeThread
    cacheVisibleThread()
    const requestId = ++loadRequest.current
    const threadRevision = ++historyRevision.current
    clearThreadCompletion(thread.id)
    activeThreadId.current = thread.id
    if (persistActiveThread) persistActiveThreadId(thread.id)
    setQueueRecoveryReadyThreadId(null)
    resetStreamingAssistant()
    setActiveTurnId(null)
    interruptRequestedThreadId.current = null
    interruptRequestedTurnId.current = null
    interruptInFlightThreadId.current = null
    resumedThreadId.current = null
    let cachedThread = threadHistoryCache.current.get(thread.id) ?? null
    if (cachedThread) {
      threadHistoryCache.current.delete(thread.id)
      threadHistoryCache.current.set(thread.id, cachedThread)
    } else if (persistActiveThread) {
      const persistedCache = readPersistedActiveThreadCache(thread.id)
      if (persistedCache) {
        cachedThread = {
          thread: persistedCache.thread,
          messages: persistedCache.messages,
          fileChangesByTurn: {},
          operationsByTurn: {},
          running: false,
          turnId: null,
          characters: cachedHistoryCharacters(persistedCache.messages),
          complete: false,
        }
        cacheThreadSnapshot(persistedCache.thread, persistedCache.messages, {
          fileChangesByTurn: {},
          operationsByTurn: {},
          running: false,
          turnId: null,
          complete: false,
        })
      }
    }

    const showCachedThread = (entry: ThreadCacheEntry) => {
      const latest = threadListRef.current.find((candidate) => candidate.id === thread.id) ?? thread
      const cachedRunning = Boolean(entry.running || threadIsRunning(latest))
      setActiveThread({ ...entry.thread, ...latest })
      setMessages(entry.messages)
      setFileChangesByTurn(entry.fileChangesByTurn)
      operationsByTurnRef.current = entry.operationsByTurn
      setOperationsByTurn(entry.operationsByTurn)
      setIsRunning(cachedRunning)
      setActiveTurnId(cachedRunning ? entry.turnId : null)
      setLoadingHistory(false)
    }

    if (cachedThread) showCachedThread(cachedThread)
    else {
      setActiveThread(thread)
      setMessages([])
      setFileChangesByTurn({})
      operationsByTurnRef.current = {}
      setOperationsByTurn({})
      setIsRunning(threadIsRunning(thread))
      setActiveTurnId(null)
    }
    setIsInterrupting(false)
    clearTurnTimer()
    setActivity(null)
    writerConflictRef.current = false
    setWriterConflict(false)
    activityItemId.current = null
    setApproval(null)
    setLoadingHistory(!cachedThread)
    if (previousThread && previousThread.id !== thread.id) void prefetchThread(previousThread, true)

    if (loadThreads && (connectionRef.current !== 'connected' || Date.now() - threadListFetchedAtRef.current > threadMetadataFreshnessMs)) {
      await refreshThreads()
      if (requestId !== loadRequest.current || activeThreadId.current !== thread.id) return
    }

    const hasQueuedMessages = Boolean(queuedMessagesByThreadRef.current[thread.id]?.length)
    let latestThread = threadListRef.current.find((candidate) => candidate.id === thread.id) ?? thread
    const threadMetadataIsFresh = () => (
      (threadListLoadedRef.current && Date.now() - threadListFetchedAtRef.current <= threadMetadataFreshnessMs)
      || latestThread.updatedAt !== undefined
    )
    const cachedIsFresh = () => Boolean(
      cachedThread
      && cachedHistoryMatchesThreadMetadata(
        cachedThread,
        latestThread,
        threadMetadataIsFresh(),
        hasQueuedMessages,
      ),
    )
    const scheduleBackgroundRefresh = () => {
      cachedActiveThreadRefreshTimer.current = window.setTimeout(() => {
        cachedActiveThreadRefreshTimer.current = undefined
        void (async () => {
          const loaded = await loadThread(thread.id, threadRevision, true)
          if (requestId === loadRequest.current && loaded) setError(null)
        })()
      }, cachedActiveThreadRefreshDelayMs)
    }

    if (!cachedIsFresh() && !cachedThread?.complete) {
      const restoredCache = await restorePersistentThreadCache(thread.id)
      if (requestId !== loadRequest.current || activeThreadId.current !== thread.id) return
      if (restoredCache) {
        cachedThread = restoredCache
        latestThread = threadListRef.current.find((candidate) => candidate.id === thread.id) ?? thread
        showCachedThread(restoredCache)
      }
    }

    if (cachedIsFresh() && !hasQueuedMessages) {
      setQueueRecoveryReadyThreadId(thread.id)
      setLoadingHistory(false)
      return
    }

    if (cachedThread) {
      scheduleBackgroundRefresh()
      return
    }

    try {
      const loaded = await loadThread(thread.id, threadRevision)
      if (requestId !== loadRequest.current) return
      if (loaded) setError(null)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (requestId === loadRequest.current) setError(reason instanceof Error ? reason.message : '恢复对话失败')
    } finally {
      if (requestId === loadRequest.current) setLoadingHistory(false)
    }
  }, [activeThread, cacheThreadSnapshot, cacheVisibleThread, clearThreadCompletion, clearTurnTimer, loadThread, loadThreads, onUnauthorized, persistActiveThread, prefetchThread, refreshThreads, resetStreamingAssistant, restorePersistentThreadCache, setActiveTurnId])

  const createThread = useCallback(async (
    model?: string,
    approvalPolicy?: CodexApprovalPolicy,
    requestId = queuedMessageId(),
  ) => {
    if (handedOffRef.current) {
      setError('网页端已交还给本机 Codex，请先重新接管网页端。')
      return null
    }
    if (cachedActiveThreadRefreshTimer.current !== undefined) {
      window.clearTimeout(cachedActiveThreadRefreshTimer.current)
      cachedActiveThreadRefreshTimer.current = undefined
    }
    const previousThread = activeThread
    cacheVisibleThread()
    historyRevision.current += 1
    setLoadingHistory(true)
    try {
      const thread = await codexRemoteClient.createThread(token, model, approvalPolicy, requestId)
      activeThreadId.current = thread.id
      if (persistActiveThread) persistActiveThreadId(thread.id)
      setQueueRecoveryReadyThreadId(null)
      if (previousThread && previousThread.id !== thread.id) void prefetchThread(previousThread, true)
      resetStreamingAssistant()
      setActiveTurnId(null)
      interruptRequestedThreadId.current = null
      interruptRequestedTurnId.current = null
      interruptInFlightThreadId.current = null
      resumedThreadId.current = thread.id
      setActiveThread(thread)
      setMessages([])
      setIsRunning(false)
      setIsInterrupting(false)
      clearTurnTimer()
      setActivity(null)
      setFileChangesByTurn({})
      operationsByTurnRef.current = {}
      setOperationsByTurn({})
      writerConflictRef.current = false
      setWriterConflict(false)
      activityItemId.current = null
      setApproval(null)
      setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)])
      setError(null)
      return thread
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '创建 Codex 对话失败')
      return null
    } finally {
      setLoadingHistory(false)
    }
  }, [activeThread, cacheVisibleThread, clearTurnTimer, onUnauthorized, persistActiveThread, prefetchThread, resetStreamingAssistant, setActiveTurnId, token])

  const sendMessage = useCallback(async (input: SendMessageInput) => {
    if (handedOffRef.current) {
      setError('网页端已交还给本机 Codex，请先重新接管网页端。')
      return false
    }
    const payload = queuedPayloadFromInput(input)
    if (!payload.text && payload.images.length === 0 && !payload.documents?.length) return false
    let thread = activeThread
    if (!thread) {
      thread = await createThread(input.model, input.approvalPolicy, payload.id)
      if (thread) input.onThreadCreated?.(thread)
    }
    if (!thread) return false
    if (sharedQueueAuthoritative) {
      const delivery: PendingTurnDelivery = {
        threadId: thread.id,
        turnId: null,
        acknowledged: false,
        completedTurnIds: new Set(),
        previousMessageIds: new Set(messagesRef.current.map((message) => message.id)),
      }
      pendingTurnDeliveries.current.set(payload.id, delivery)
      const optimistic = activeThreadId.current === thread.id && !isRunning && !activeTurnId.current
        && !(serverQueuedMessagesByThreadRef.current[thread.id]?.length)
      if (optimistic) {
        historyRevision.current += 1
        appendQueuedMessageToActiveThread(thread.id, payload)
        setIsRunning(true)
        setActivity({ label: '正在发送' })
      }
      const retractPendingMessage = () => {
        if (!optimistic) return
        removeQueuedMessageFromActiveThread(thread.id, payload.id)
        if (activeThreadId.current === thread.id && !activeTurnId.current) {
          setIsRunning(false)
          setActivity(null)
        }
      }
      try {
        const result = await codexRemoteClient.submitMessage(token, thread.id, payload)
        applyServerQueueResponse(thread.id, delivery.acknowledged
          ? result.queue.filter((message) => message.id !== payload.id)
          : result.queue)
        setError(null)
        if (result.sent || delivery.acknowledged) {
          appendQueuedMessageToActiveThread(thread.id, payload, delivery.turnId)
          if (delivery.turnId) applyTurnDelivery(thread.id, payload.id, delivery.turnId)
          // A receipt and streamed events are enough to show our own message.
          // Only recover history when the receipt was lost, not on every send.
          if (!delivery.turnId && activeThreadId.current === thread.id) {
            void loadThread(thread.id, ++historyRevision.current, true)
          }
        } else {
          retractPendingMessage()
        }
        return true
      } catch (reason) {
        if (delivery.acknowledged) {
          appendQueuedMessageToActiveThread(thread.id, payload, delivery.turnId)
          applyTurnDelivery(thread.id, payload.id, delivery.turnId)
          void refreshServerQueue(thread.id)
          setError(null)
          return true
        }
        retractPendingMessage()
        if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
        setError(reason instanceof RemoteApiError && reason.status === 404
          ? '电脑端服务尚未加载新的发送接口，请重启 Codex Remote 后端。'
          : isAmbiguousNetworkFailure(reason)
            ? '连接中断，发送结果尚未确认。请先核对聊天记录和排队消息，避免重复发送。'
            : reason instanceof Error ? reason.message : '消息发送失败')
        void refreshServerQueue(thread.id)
        return false
      } finally {
        pendingTurnDeliveries.current.delete(payload.id)
      }
    }
    const threadIsReplying = thread.id === activeThreadId.current && (isRunning || activeTurnId.current !== null)
    const hasQueuedMessages = (queuedMessagesByThreadRef.current[thread.id]?.length ?? 0) > 0
    if (threadIsReplying || hasQueuedMessages) {
      updateQueuedMessages(thread.id, (current) => [...current, payload])
      if (threadIsReplying) {
        setQueueRecoveryBarrier(thread.id, {
          turnId: activeTurnId.current ?? runningTurnId,
          status: 'running',
        })
        setQueueRecoveryReadyThreadId(null)
      }
      setError(null)
      // A failed automatic start leaves the queue intact. A later normal
      // submission is a useful retry that still preserves message order.
      if (!threadIsReplying) void startNextQueuedMessage(thread.id)
      return true
    }
    const localId = payload.id
    const previousMessages = messagesRef.current
    const previousMessageIds = new Set(previousMessages.map((message) => message.id))
    const previousTurnIds = new Set(previousMessages.flatMap((message) => message.turnId ? [message.turnId] : []))
    const rememberStartedTurn = (turnId: string | null) => {
      if (!turnId || activeThreadId.current !== thread.id) return
      setActiveTurnId(turnId)
      startTurnTimerForTurn(turnId)
      setMessages((current) => current.map((message) => message.id === localId && !message.turnId
        ? { ...message, turnId }
        : message))
      if (interruptRequestedThreadId.current === thread.id
        && (!interruptRequestedTurnId.current || interruptRequestedTurnId.current === turnId)) {
        void dispatchInterrupt(thread.id, turnId)
      }
    }
    historyRevision.current += 1
    setMessages((current) => [...current, localMessageFromQueuedPayload(payload)])
    setActiveTurnId(null)
    setQueueRecoveryReadyThreadId(null)
    interruptRequestedThreadId.current = null
    interruptRequestedTurnId.current = null
    interruptInFlightThreadId.current = null
    setIsRunning(true)
    setIsInterrupting(false)
    setActivity({ label: '正在思考' })
    writerConflictRef.current = false
    setWriterConflict(false)
    setError(null)
    try {
      const turnResult = await requestTurnStart(thread.id, payload, previousMessageIds)
      if (!turnResult.completed) rememberStartedTurn(turnResult.turn_id)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (isAmbiguousNetworkFailure(reason) && activeThreadId.current === thread.id) {
        try {
          const recoveryRevision = historyRevision.current
          const recoveredThread = await codexRemoteClient.readThread(token, thread.id)
          if (threadContainsNewPayload(recoveredThread, previousMessageIds, previousTurnIds, payload)) {
            if (activeThreadId.current !== thread.id) return true
            if (historyRevision.current !== recoveryRevision) {
              void loadThread(thread.id, historyRevision.current, true)
              return true
            }
            const recoveredTurnState = latestTurnState(recoveredThread)
            const running = recoveredTurnState.running || (!recoveredTurnState.hasTurn && threadIsRunning(recoveredThread))
            const turnId = recoveredTurnState.turnId
            applyTurnDelivery(thread.id, payload.id, turnId)
            setActiveThread(recoveredThread)
            setActiveTurnId(running ? turnId : null)
            setIsRunning(running)
            setIsInterrupting(false)
            setActivity(running ? { label: '正在思考' } : null)
            if (running) {
              startTurnTimerForTurn(turnId, recoveredTurnState.startedAt)
            } else {
              finishTurnTimer()
              resetStreamingAssistant()
            }
            setQueueRecoveryReadyThreadId(running ? null : thread.id)
            setError(null)
            void loadThread(thread.id, ++historyRevision.current, true)
            void refreshThreads()
            return true
          }
        } catch {
          // Keep the draft and report an uncertain delivery state if history
          // cannot be read while the mobile connection is still interrupted.
        }
      }
      const receipt = isAmbiguousNetworkFailure(reason) ? confirmedTurnDelivery(payload.id) : null
      if (receipt) {
        if (!receipt.completed) rememberStartedTurn(receipt.turn_id)
        if (activeThreadId.current === thread.id) setError(null)
        return true
      }
      if (isAmbiguousNetworkFailure(reason)) reconnectRef.current(true)
      if (activeThreadId.current !== thread.id) return false
      historyRevision.current += 1
      setMessages((current) => current.filter((message) => message.id !== localId))
      setIsRunning(false)
      setActiveTurnId(null)
      interruptRequestedThreadId.current = null
      interruptRequestedTurnId.current = null
      interruptInFlightThreadId.current = null
      setIsInterrupting(false)
      clearTurnTimer()
      setActivity(null)
      const message = sendFailureMessage(reason)
      if (isActiveWriterError(reason)) {
        writerConflictRef.current = true
        setWriterConflict(true)
        setIsRunning(true)
        setActivity({ label: '此对话已有其他 Codex 实例在运行' })
        setError(activeWriterError)
      } else {
        setError(/thread not found/i.test(message)
          ? '本机 Codex 已找不到这条对话。草稿仍保留，请新建对话后重新发送。'
          : message)
      }
      return false
    } finally {
      pendingTurnDeliveries.current.delete(payload.id)
    }
  }, [activeThread, appendQueuedMessageToActiveThread, applyServerQueueResponse, applyTurnDelivery, clearTurnTimer, confirmedTurnDelivery, createThread, dispatchInterrupt, finishTurnTimer, isRunning, loadThread, messages, onUnauthorized, refreshServerQueue, refreshThreads, removeQueuedMessageFromActiveThread, requestTurnStart, resetStreamingAssistant, runningTurnId, setActiveTurnId, setQueueRecoveryBarrier, startNextQueuedMessage, startTurnTimerForTurn, token, updateQueuedMessages])

  const interrupt = useCallback(async () => {
    if (handedOffRef.current) return false
    const threadId = activeThread?.id ?? activeThreadId.current
    if (!threadId || !isRunning || isInterrupting) return false
    interruptRequestedThreadId.current = threadId
    interruptRequestedTurnId.current = activeTurnId.current
    setIsInterrupting(true)
    setActivity({ label: '正在停止…' })
    const turnId = activeTurnId.current
    if (!turnId) return true
    return dispatchInterrupt(threadId, turnId)
  }, [activeThread, dispatchInterrupt, isInterrupting, isRunning])

  const handoffToLocalCodex = useCallback(async () => {
    if (handoffInProgress || handedOffRef.current) return false
    const hasQueuedMessages = Object.values(queuedMessagesByThreadRef.current).some((messages) => messages.length > 0)
    if (isRunning || isInterrupting || hasQueuedMessages) {
      setError('当前网页端任务或排队消息尚未结束，不能交还给本机 Codex。')
      return false
    }
    setHandoffInProgress(true)
    try {
      await codexRemoteClient.handoffToLocalCodex(token)
      resumedThreadId.current = null
      setActiveTurnId(null)
      interruptRequestedThreadId.current = null
      interruptRequestedTurnId.current = null
      interruptInFlightThreadId.current = null
      setApproval(null)
      setHandoffState(true)
      setRuntime((current) => ({ ...current, connected: false, handedOff: true, error: null }))
      setConnectionState('disconnected')
      setError(null)
      socketRef.current?.close()
      socketRef.current = null
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '交还给本机 Codex 失败')
      return false
    } finally {
      setHandoffInProgress(false)
    }
  }, [handoffInProgress, isInterrupting, isRunning, onUnauthorized, setConnectionState, setHandoffState, token])

  const reclaimForRemote = useCallback(async () => {
    if (handoffInProgress || !handedOffRef.current) return false
    setHandoffInProgress(true)
    try {
      const nextRuntime = await codexRemoteClient.reclaimForRemote(token)
      setHandoffState(false)
      setRuntime(nextRuntime)
      setConnectionState('connecting')
      setError(null)
      reconnectRef.current()
      void restoreActiveThread()
      void refreshThreads()
      void refreshModels()
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '重新接管网页端失败')
      return false
    } finally {
      setHandoffInProgress(false)
    }
  }, [handoffInProgress, onUnauthorized, refreshModels, refreshThreads, restoreActiveThread, setConnectionState, setHandoffState, token])

  const respondToApproval = useCallback((decision: 'accept' | 'decline' | 'cancel') => {
    if (!approval) return false
    const sent = socketRef.current?.respondToApproval(approval.requestId, decision) ?? false
    if (sent) setApproval(null)
    else setError('连接断开，审批没有送达')
    return sent
  }, [approval])

  const refreshActiveThread = useCallback(() => {
    if (handedOffRef.current) return
    if (activeThreadId.current) void loadThread(activeThreadId.current)
  }, [loadThread])

  const updateApprovalPolicy = useCallback(async (approvalPolicy: CodexApprovalPolicy) => {
    const threadId = activeThreadId.current
    if (!threadId || handedOffRef.current) return false
    setUpdatingApprovalPolicy(true)
    setError(null)
    try {
      await codexRemoteClient.updateThreadApprovalPolicy(token, threadId, approvalPolicy)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '更新会话权限失败')
      return false
    } finally {
      setUpdatingApprovalPolicy(false)
    }
  }, [onUnauthorized, token])

  const uploadPdfAttachment = useCallback(async (file: File) => {
    try {
      return await codexRemoteClient.uploadPdfAttachment(token, file)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      throw reason
    }
  }, [onUnauthorized, token])

  return {
    connection,
    runtime,
    threads,
    models,
    activeThread,
    messages,
    queuedMessages: activeThread ? serverQueuedMessagesByThread[activeThread.id] ?? emptyQueuedMessages : emptyQueuedMessages,
    pinRevision,
    isRunning,
    runningTurnId,
    isInterrupting,
    turnStartedAt,
    activity,
    fileChangesByTurn,
    operationsByTurn,
    writerConflict,
    handedOff,
    handoffInProgress,
    loadingHistory,
    error,
    updatingApprovalPolicy,
    approval,
    completedThreadIds,
    latestThreadCompletion,
    refreshThreads,
    renameThread,
    refreshModels,
    selectThread,
    createThread,
    sendMessage,
    uploadPdfAttachment,
    sendQueuedMessageNow: sharedQueueAuthoritative ? sharedSendQueuedMessageNow : sendQueuedMessageNow,
    beginEditQueuedMessage: sharedQueueAuthoritative ? sharedBeginQueuedEdit : beginEditQueuedMessage,
    updateQueuedMessage: sharedQueueAuthoritative ? sharedUpdateQueuedMessage : updateQueuedMessage,
    endEditQueuedMessage: sharedQueueAuthoritative ? sharedEndQueuedEdit : endEditQueuedMessage,
    removeQueuedMessage: sharedQueueAuthoritative ? sharedRemoveQueuedMessage : removeQueuedMessage,
    interrupt,
    handoffToLocalCodex,
    reclaimForRemote,
    respondToApproval,
    clearThreadCompletion,
    refreshActiveThread,
    updateApprovalPolicy,
  }
}

export type CodexRemoteController = ReturnType<typeof useCodexRemote>
