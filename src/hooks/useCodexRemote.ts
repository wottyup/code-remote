import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import {
  codexRemoteClient,
  messagesFromThread,
  RemoteApiError,
  type CodexDocumentAttachment,
  type CodexImageAttachment,
  type CodexMessage,
  type CodexModel,
  type CodexApprovalPolicy,
  type CodexRuntime,
  type CodexThread,
  type RemoteEvent,
} from '../lib/codexRemoteClient'

interface ApprovalRequest {
  requestId: string | number
  method: string
  params: Record<string, unknown>
}

export interface CodexActivity {
  label: string
  detail?: string
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
  document?: CodexDocumentAttachment
  createdAt: string
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
  document?: CodexDocumentAttachment
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
  onThreadCreated?: (thread: CodexThread) => void
}

type FileChangesByTurn = Record<string, CodexFileChange[]>
type QueuedMessagesByThread = Record<string, QueuedTurnPayload[]>

const emptyQueuedMessages: QueuedTurnMessage[] = []

const emptyRuntime: CodexRuntime = { available: false, connected: false, workspace: '', handedOff: false, error: null }
const activeWriterError = '这条对话正被另一个 Codex 实例使用。可查看历史，待原实例结束后再发送。'
const activeThreadStorageKey = 'codex-remote.active-thread-id'
const activeThreadCacheStorageKey = 'codex-remote.active-thread-cache'
const queuedMessagesStorageKey = 'codex-remote.queued-messages'
const maxCachedHistoryCharacters = 600_000
const maxCachedMessageCharacters = 120_000
const maxInMemoryThreadCacheEntries = 6
const maxInMemoryThreadCacheCharacters = 1_200_000
const maxBackgroundPrefetchThreads = 3
const backgroundPrefetchDelayMs = 120
const cachedActiveThreadRefreshDelayMs = 180
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
  running: boolean
  turnId: string | null
  characters: number
}

export interface UseCodexRemoteOptions {
  /** Keep the existing single-pane conversation in localStorage. */
  persistActiveThread?: boolean
  /** Keep the socket and background requests closed while a pane is hidden. */
  enabled?: boolean
  /** Keep list/model/history warm-up work in the primary controller only. */
  loadThreads?: boolean
  loadModels?: boolean
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

function threadTimestamp(thread: CodexThread) {
  const value = thread.updatedAt ?? thread.createdAt
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') return Date.parse(value) || 0
  return 0
}

function threadIsRunning(thread: CodexThread) {
  return thread.status?.type === 'inProgress' || thread.status?.type === 'running'
}

function latestTurnState(thread: { turns?: unknown[] }) {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const latest = turns.at(-1) as Record<string, unknown> | undefined
  const running = latest?.status === 'inProgress' || latest?.status === 'running'
  const turnId = typeof latest?.id === 'string' ? latest.id : null
  return { running, turnId }
}

function isActiveWriterError(reason: unknown) {
  return reason instanceof Error && /active writer/i.test(reason.message)
}

function queuedMessageId() {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function queuedRequestText(text: string, document?: CodexDocumentAttachment) {
  const documentText = document
    ? `\n\n[附件文档：${document.name}]\n${document.content}\n[/附件文档]`
    : ''
  return `${text}${documentText}`.trim()
}

function queuedPayloadFromInput(input: SendMessageInput): QueuedTurnPayload {
  const text = input.prompt.trim()
  return {
    id: queuedMessageId(),
    text,
    requestText: queuedRequestText(text, input.document),
    images: input.images,
    ...(input.document ? { document: input.document } : {}),
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
  if (!document.name || document.name.length > 512 || document.content.length > maxPersistedQueuedTextCharacters) return undefined
  return { name: document.name, content: document.content }
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
  const document = persistedQueuedDocument(payload.document)
  if (!text && images.length === 0 && !document) return null
  const model = typeof payload.model === 'string' && payload.model.length <= 256 ? payload.model : undefined
  const effort = typeof payload.effort === 'string' && payload.effort.length <= 64 ? payload.effort : undefined
  const approvalPolicy = payload.approvalPolicy === 'on-request' || payload.approvalPolicy === 'untrusted' || payload.approvalPolicy === 'never'
    ? payload.approvalPolicy
    : undefined
  return {
    id,
    text,
    requestText: queuedRequestText(text, document),
    images,
    ...(document ? { document } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
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

function localMessageFromQueuedPayload(payload: QueuedTurnPayload, turnId?: string | null): CodexMessage {
  return {
    id: payload.id,
    role: 'user',
    text: payload.text,
    images: payload.images.map((image) => ({ name: image.name, previewUrl: `data:${image.mediaType};base64,${image.data}` })),
    ...(payload.document ? { documents: [{ ...payload.document, charCount: payload.document.content.length }] } : {}),
    createdAt: payload.createdAt,
    ...(turnId ? { turnId } : {}),
  }
}

function preserveCurrentImages(next: CodexMessage[], current: CodexMessage[]) {
  const previousImageMessages = current.filter((message) => message.role === 'user' && message.images?.length)
  const used = new Set<string>()
  return next.map((message) => {
    if (message.role !== 'user' || message.images?.length) return message
    const previous = previousImageMessages.find((candidate) => !used.has(candidate.id) && candidate.text === message.text)
    if (!previous) return message
    used.add(previous.id)
    return { ...message, images: previous.images }
  })
}

function sameMessageImages(left: CodexMessage['images'], right: CodexMessage['images']) {
  const leftItems = left ?? []
  const rightItems = right ?? []
  return leftItems.length === rightItems.length && leftItems.every((image, index) =>
    image.name === rightItems[index]?.name && image.previewUrl === rightItems[index]?.previewUrl,
  )
}

function sameMessageDocuments(left: CodexMessage['documents'], right: CodexMessage['documents']) {
  const leftItems = left ?? []
  const rightItems = right ?? []
  return leftItems.length === rightItems.length && leftItems.every((document, index) =>
    document.name === rightItems[index]?.name
      && document.content === rightItems[index]?.content
      && document.charCount === rightItems[index]?.charCount,
  )
}

function sameMessages(left: CodexMessage[], right: CodexMessage[]) {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index]
    if (!candidate) return false
    return message.id === candidate.id
      && message.role === candidate.role
      && message.text === candidate.text
      && message.turnId === candidate.turnId
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

function isAssistantMessageForTurn(message: CodexMessage, turnId: string | null, messageId: string) {
  return message.role === 'assistant' && (message.id === messageId || (turnId !== null && message.turnId === turnId))
}

function assistantTextForTurn(messages: CodexMessage[], turnId: string | null, messageId: string) {
  return messages.reduce((text, message) => isAssistantMessageForTurn(message, turnId, messageId)
    ? mergeStreamingText(text, message.text)
    : text, '')
}

function collapseAssistantMessagesForTurn(messages: CodexMessage[], turnId: string | null, messageId: string, incomingText: string) {
  const matching = messages.filter((message) => isAssistantMessageForTurn(message, turnId, messageId))
  const text = mergeStreamingText(assistantTextForTurn(messages, turnId, messageId), incomingText)
  if (matching.length === 0 && !text) return messages

  const source = matching.find((message) => message.id === messageId) ?? matching.at(-1)
  const merged: CodexMessage = {
    ...(source ?? {}),
    id: messageId,
    role: 'assistant',
    text,
    createdAt: source?.createdAt ?? new Date().toISOString(),
    streaming: true,
    ...(turnId ? { turnId } : {}),
  }
  let inserted = false
  const next = messages.flatMap((message) => {
    if (!isAssistantMessageForTurn(message, turnId, messageId)) return [message]
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
    return [{
      path,
      kind: typeof change.kind === 'string' ? change.kind : typeof change.type === 'string' ? change.type : undefined,
      diff,
      additions: diffLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: diffLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
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
  const knownPaths = new Set(withoutPreviousWorkspaceChange.flatMap((change) => change.changes.map((entry) => entry.path)))
  const missingChanges = next.changes.filter((entry) => !knownPaths.has(entry.path))
  return missingChanges.length > 0
    ? [...withoutPreviousWorkspaceChange, { ...next, changes: missingChanges }]
    : withoutPreviousWorkspaceChange
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
      return { label: '正在执行命令', detail: command ? command.slice(0, 100) : undefined }
    }
    case 'fileChange': {
      const count = Array.isArray(item.changes) ? item.changes.length : 0
      return { label: '正在修改文件', detail: count > 0 ? `${count} 个文件` : undefined }
    }
    case 'mcpToolCall': {
      const server = typeof item.server === 'string' ? item.server : ''
      const tool = typeof item.tool === 'string' ? item.tool : ''
      return { label: '正在调用 MCP 工具', detail: [server, tool].filter(Boolean).join(' · ') || undefined }
    }
    case 'dynamicToolCall': return { label: '正在调用工具', detail: toolName || undefined }
    case 'webSearch': return { label: '正在搜索资料', detail: typeof item.query === 'string' ? item.query : undefined }
    case 'imageView': return { label: '正在查看图片' }
    case 'imageGeneration': return { label: '正在生成图片' }
    case 'collabAgentToolCall': return { label: '正在协调子任务', detail: typeof item.tool === 'string' ? item.tool : undefined }
    case 'subAgentActivity': return { label: '正在运行子任务' }
    default: return { label: '正在处理' }
  }
}

export function useCodexRemote(token: string, onUnauthorized: () => void, options: UseCodexRemoteOptions = {}) {
  const persistActiveThread = options.persistActiveThread ?? true
  const enabled = options.enabled ?? true
  const loadThreads = options.loadThreads ?? true
  const loadModels = options.loadModels ?? true
  const prefetchHistory = options.prefetchHistory ?? true
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
  const [isRunning, setIsRunning] = useState(false)
  // This is intentionally state as well as a ref: the ref lets socket events
  // make immediate decisions, while the state tells the UI which turn is not
  // finished yet. File-change cards must wait for turn/completed.
  const [runningTurnId, setRunningTurnId] = useState<string | null>(null)
  const [isInterrupting, setIsInterrupting] = useState(false)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const [lastTurnDurationMs, setLastTurnDurationMs] = useState<number | null>(null)
  const [activity, setActivity] = useState<CodexActivity | null>(null)
  const [fileChangesByTurn, setFileChangesByTurn] = useState<FileChangesByTurn>({})
  const [writerConflict, setWriterConflict] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(() => initialActiveThreadId !== null)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [completedThreadIds, setCompletedThreadIds] = useState<string[]>([])
  const [latestThreadCompletion, setLatestThreadCompletion] = useState<CodexThreadCompletion | null>(null)
  const [queuedMessagesByThread, setQueuedMessagesByThread] = useState<QueuedMessagesByThread>(readPersistedQueuedMessages)
  // A restored queue may start only after a fresh thread/read confirms that
  // the matching Codex turn is idle. Cached UI alone is not authoritative.
  const [queueRecoveryReadyThreadId, setQueueRecoveryReadyThreadId] = useState<string | null>(null)
  const socketRef = useRef<ReturnType<typeof codexRemoteClient.connect> | null>(null)
  const connectionRef = useRef<'connecting' | 'connected' | 'disconnected' | 'unavailable'>('connecting')
  const reconnectRef = useRef<() => void>(() => {})
  const handedOffRef = useRef(false)
  const activeThreadId = useRef<string | null>(initialActiveThreadId)
  const activeTurnId = useRef<string | null>(null)
  const interruptRequestedThreadId = useRef<string | null>(null)
  const interruptInFlightThreadId = useRef<string | null>(null)
  const resumedThreadId = useRef<string | null>(null)
  const loadRequest = useRef(0)
  const historyRevision = useRef(0)
  const activityItemId = useRef<string | null>(null)
  const streamingAssistantMessageId = useRef<string | null>(null)
  const streamingAssistantParts = useRef(new Map<string, string>())
  const streamingRenderTimer = useRef<number | undefined>(undefined)
  const streamingRenderGeneration = useRef(0)
  const turnStartedAtRef = useRef<number | null>(null)
  const writerConflictRef = useRef(false)
  const writerRefreshTimer = useRef<number | undefined>(undefined)
  const restoringThreadId = useRef<string | null>(null)
  const threadHistoryCache = useRef(new Map<string, ThreadCacheEntry>())
  const prefetchingThreadIds = useRef(new Set<string>())
  const forcedPrefetchThreadIds = useRef(new Set<string>())
  const threadPrefetchTimer = useRef<number | undefined>(undefined)
  const cachedActiveThreadRefreshTimer = useRef<number | undefined>(undefined)
  const queuedMessagesByThreadRef = useRef<QueuedMessagesByThread>(queuedMessagesByThread)
  const queuedTurnStartsInFlight = useRef(new Set<string>())
  const queuedTurnSteersInFlight = useRef(new Set<string>())

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

  const updateQueuedMessages = useCallback((threadId: string, update: (current: QueuedTurnPayload[]) => QueuedTurnPayload[]) => {
    const current = queuedMessagesByThreadRef.current[threadId] ?? []
    const next = update(current)
    if (next === current) return current
    const nextByThread = { ...queuedMessagesByThreadRef.current }
    if (next.length > 0) nextByThread[threadId] = next
    else delete nextByThread[threadId]
    queuedMessagesByThreadRef.current = nextByThread
    setQueuedMessagesByThread(nextByThread)
    // Secondary panes are short-lived views. Let the primary controller own
    // the durable queue snapshot so three controllers cannot overwrite each
    // other's localStorage copy while different threads are active.
    if (persistActiveThread) persistQueuedMessages(nextByThread)
    return next
  }, [persistActiveThread])

  const beginTurnTimer = useCallback(() => {
    if (turnStartedAtRef.current !== null) return
    const startedAt = Date.now()
    turnStartedAtRef.current = startedAt
    setTurnStartedAt(startedAt)
    setLastTurnDurationMs(null)
  }, [])

  const finishTurnTimer = useCallback(() => {
    const startedAt = turnStartedAtRef.current
    turnStartedAtRef.current = null
    setTurnStartedAt(null)
    if (startedAt !== null) setLastTurnDurationMs(Math.max(0, Date.now() - startedAt))
  }, [])

  const clearTurnTimer = useCallback(() => {
    turnStartedAtRef.current = null
    setTurnStartedAt(null)
    setLastTurnDurationMs(null)
  }, [])

  const resetStreamingAssistant = useCallback(() => {
    streamingRenderGeneration.current += 1
    if (streamingRenderTimer.current !== undefined) {
      window.clearTimeout(streamingRenderTimer.current)
      streamingRenderTimer.current = undefined
    }
    streamingAssistantMessageId.current = null
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
    const renderGeneration = streamingRenderGeneration.current
    const update = () => {
      setMessages((current) => {
        // A delayed transition from a previous turn must never recreate an
        // assistant bubble after the active thread has already changed.
        if (!synchronous && renderGeneration !== streamingRenderGeneration.current) return current
        const next = collapseAssistantMessagesForTurn(current, turnId, messageId, text)
        return sameMessages(current, next) ? current : next
      })
    }
    if (synchronous) update()
    else startTransition(update)
  }, [])

  const scheduleStreamingAssistantRender = useCallback(() => {
    if (streamingRenderTimer.current !== undefined) return
    streamingRenderTimer.current = window.setTimeout(() => {
      streamingRenderTimer.current = undefined
      flushStreamingAssistant()
    }, streamingRenderIntervalMs)
  }, [flushStreamingAssistant])

  const cacheThreadSnapshot = useCallback((thread: CodexThread, nextMessages: CodexMessage[], state?: Pick<ThreadCacheEntry, 'running' | 'turnId' | 'fileChangesByTurn'>) => {
    const characters = cachedHistoryCharacters(nextMessages)
    const cache = threadHistoryCache.current
    const previous = cache.get(thread.id)
    if (characters > maxInMemoryThreadCacheCharacters) return
    cache.delete(thread.id)
    cache.set(thread.id, {
      thread: compactThread(thread),
      messages: nextMessages,
      fileChangesByTurn: state?.fileChangesByTurn ?? previous?.fileChangesByTurn ?? {},
      running: state?.running ?? previous?.running ?? threadIsRunning(thread),
      turnId: state?.turnId ?? previous?.turnId ?? null,
      characters,
    })

    let totalCharacters = [...cache.values()].reduce((total, entry) => total + entry.characters, 0)
    while (cache.size > maxInMemoryThreadCacheEntries || totalCharacters > maxInMemoryThreadCacheCharacters) {
      const entries = [...cache.entries()]
      const oldest = entries.find(([threadId]) => threadId !== activeThreadId.current) ?? entries[0]
      if (!oldest) break
      cache.delete(oldest[0])
      totalCharacters -= oldest[1].characters
    }
  }, [])

  const updateCachedThreadRunState = useCallback((threadId: string, running: boolean, turnId: string | null) => {
    const cache = threadHistoryCache.current
    const current = cache.get(threadId)
    if (!current) return
    cache.delete(threadId)
    cache.set(threadId, { ...current, running, turnId })
  }, [])

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
        fileChangesByTurn: mergeFileChangesByTurn(
          cachedThread?.fileChangesByTurn ?? {},
          fileChangesFromThread(loadedThread),
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
    try {
      const next = await codexRemoteClient.threads(token)
      setThreads(next)
      scheduleThreadPrefetch(next)
      return next
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '无法读取对话记录')
      return null
    }
  }, [loadThreads, onUnauthorized, scheduleThreadPrefetch, token])

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

  const loadThread = useCallback(async (threadId: string, revision = historyRevision.current, silent = false) => {
    if (handedOffRef.current) return false
    try {
      const thread = await codexRemoteClient.readThread(token, threadId)
      if (activeThreadId.current !== threadId || revision !== historyRevision.current) return false
      if (persistActiveThread) persistActiveThreadId(thread.id)
      setActiveThread((current) => sameActiveThread(current, thread) ? current : thread)
      const loadedMessages = messagesFromThread(thread)
      const cachedMessages = preserveCurrentImages(loadedMessages, threadHistoryCache.current.get(thread.id)?.messages ?? [])
      const historicalFileChangesByTurn = mergeFileChangesByTurn(
        threadHistoryCache.current.get(thread.id)?.fileChangesByTurn ?? {},
        fileChangesFromThread(thread),
      )
      if (persistActiveThread) persistActiveThreadCache(thread, cachedMessages)
      const { running, turnId: latestTurnId } = latestTurnState(thread)
      // A history read can finish while a reply is streaming (for example
      // after reconnecting). Give that partial server message the same stable
      // bubble as the socket stream instead of rendering both versions.
      const runningMessageId = running && latestTurnId
        ? streamingAssistantMessageId.current ?? `streaming-assistant-${latestTurnId}`
        : null
      if (runningMessageId && !streamingAssistantMessageId.current) {
        streamingAssistantMessageId.current = runningMessageId
      }
      const streamedText = streamingAssistantText(streamingAssistantParts.current)
      cacheThreadSnapshot(thread, cachedMessages, {
        running,
        turnId: latestTurnId,
        fileChangesByTurn: historicalFileChangesByTurn,
      })
      setMessages((current) => {
        const loaded = preserveCurrentImages(cachedMessages, current)
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
      setActiveTurnId(running ? latestTurnId : null)
      if (!running) {
        resetStreamingAssistant()
        if (interruptRequestedThreadId.current === threadId) {
          interruptRequestedThreadId.current = null
          setIsInterrupting(false)
        }
      }
      setIsRunning(running)
      setQueueRecoveryReadyThreadId(running ? null : thread.id)
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
  }, [cacheThreadSnapshot, onUnauthorized, persistActiveThread, resetStreamingAssistant, setActiveTurnId, token])

  const cacheVisibleThread = useCallback(() => {
    if (!activeThread || activeThread.id !== activeThreadId.current) return
    // An unopened thread has no history to restore yet; keep its loading state truthful.
    if (messages.length === 0 && !threadHistoryCache.current.has(activeThread.id)) return
    cacheThreadSnapshot(activeThread, messages, {
      running: isRunning,
      turnId: activeTurnId.current,
      fileChangesByTurn,
    })
  }, [activeThread, cacheThreadSnapshot, fileChangesByTurn, isRunning, messages])

  const dispatchInterrupt = useCallback(async (threadId: string, turnId: string) => {
    if (handedOffRef.current) return false
    if (interruptRequestedThreadId.current !== threadId || interruptInFlightThreadId.current === threadId) return false
    interruptInFlightThreadId.current = threadId
    try {
      const result = await codexRemoteClient.interrupt(token, threadId, turnId)
      if (!result.interrupted) throw new Error('Codex 没有接受停止请求')
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (interruptRequestedThreadId.current === threadId) {
        interruptRequestedThreadId.current = null
        setIsInterrupting(false)
        setError(reason instanceof Error ? reason.message : '停止 Codex 任务失败')
      }
      return false
    } finally {
      if (interruptInFlightThreadId.current === threadId) interruptInFlightThreadId.current = null
    }
  }, [onUnauthorized, token])

  const requestTurnStart = useCallback(async (threadId: string, payload: QueuedTurnPayload) => {
    const start = () => codexRemoteClient.startTurn(token, threadId, {
      prompt: payload.requestText,
      images: payload.images,
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approvalPolicy,
    })
    if (resumedThreadId.current !== threadId) {
      await codexRemoteClient.resumeThread(token, threadId)
      resumedThreadId.current = threadId
    }
    try {
      return await start()
    } catch (reason) {
      if (!(reason instanceof Error) || !/thread not found/i.test(reason.message)) throw reason
      resumedThreadId.current = null
      await codexRemoteClient.resumeThread(token, threadId)
      resumedThreadId.current = threadId
      return start()
    }
  }, [token])

  const appendQueuedMessageToActiveThread = useCallback((threadId: string, payload: QueuedTurnPayload, turnId?: string | null) => {
    if (activeThreadId.current !== threadId) return
    const localMessage = localMessageFromQueuedPayload(payload, turnId)
    setMessages((current) => current.some((message) => message.id === localMessage.id)
      ? current
      : [...current, localMessage])
  }, [])

  const startQueuedMessage = useCallback(async (threadId: string, messageId: string) => {
    if (handedOffRef.current) return false
    if (queuedTurnStartsInFlight.current.has(threadId)) return false
    const payload = queuedMessagesByThreadRef.current[threadId]?.find((message) => message.id === messageId)
    if (!payload) return false
    // A current active turn must only receive a steer request. This guard also
    // prevents a late completion event from opening a concurrent turn.
    if (activeThreadId.current === threadId && activeTurnId.current) return false
    queuedTurnStartsInFlight.current.add(threadId)
    const affectsActiveThread = activeThreadId.current === threadId
    if (affectsActiveThread) historyRevision.current += 1
    try {
      const turnResult = await requestTurnStart(threadId, payload)
      updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== payload.id))
      if (activeThreadId.current === threadId) {
        const turnId = turnResult.turn_id
        if (turnId) setActiveTurnId(turnId)
        appendQueuedMessageToActiveThread(threadId, payload, turnId)
        interruptRequestedThreadId.current = null
        interruptInFlightThreadId.current = null
        setIsInterrupting(false)
        setQueueRecoveryReadyThreadId(null)
        setIsRunning(true)
        beginTurnTimer()
        setActivity({ label: '正在思考' })
        writerConflictRef.current = false
        setWriterConflict(false)
      }
      if (activeThreadId.current === threadId) setError(null)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
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
      queuedTurnStartsInFlight.current.delete(threadId)
    }
  }, [appendQueuedMessageToActiveThread, beginTurnTimer, onUnauthorized, requestTurnStart, setActiveTurnId, updateQueuedMessages])

  const startNextQueuedMessage = useCallback(async (threadId: string) => {
    const next = queuedMessagesByThreadRef.current[threadId]?.[0]
    return next ? startQueuedMessage(threadId, next.id) : false
  }, [startQueuedMessage])

  const sendQueuedMessageNow = useCallback(async (messageId: string) => {
    if (handedOffRef.current) {
      setError('网页端已交还给本机 Codex，请先重新接管网页端。')
      return false
    }
    const threadId = activeThreadId.current
    if (!threadId || queuedTurnStartsInFlight.current.has(threadId)) return false
    const payload = queuedMessagesByThreadRef.current[threadId]?.find((message) => message.id === messageId)
    if (!payload) return false
    const requestKey = `${threadId}:${messageId}`
    if (queuedTurnSteersInFlight.current.has(requestKey)) return false
    queuedTurnSteersInFlight.current.add(requestKey)
    try {
      const result = await codexRemoteClient.steerTurn(token, threadId, {
        prompt: payload.requestText,
        images: payload.images,
      })
      updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== payload.id))
      appendQueuedMessageToActiveThread(threadId, payload, result.turn_id ?? activeTurnId.current)
      setError(null)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      // The active reply may have completed in the interval before the click
      // reached the server. Preserve the item and start it as the next turn.
      if (reason instanceof RemoteApiError && reason.status === 409) return startQueuedMessage(threadId, messageId)
      if (activeThreadId.current === threadId) {
        setError(reason instanceof Error ? reason.message : '立即发送排队消息失败')
      }
      return false
    } finally {
      queuedTurnSteersInFlight.current.delete(requestKey)
    }
  }, [appendQueuedMessageToActiveThread, onUnauthorized, startQueuedMessage, token, updateQueuedMessages])

  const removeQueuedMessage = useCallback((messageId: string) => {
    const threadId = activeThreadId.current
    if (!threadId) return
    updateQueuedMessages(threadId, (current) => current.filter((message) => message.id !== messageId))
  }, [updateQueuedMessages])

  useEffect(() => {
    const threadId = activeThread?.id
    const queued = threadId ? queuedMessagesByThread[threadId] : undefined
    if (
      !threadId
      || queueRecoveryReadyThreadId !== threadId
      || !queued?.length
      || loadingHistory
      || connection !== 'connected'
      || handedOff
      || isRunning
      || isInterrupting
      || writerConflict
    ) return
    void startNextQueuedMessage(threadId)
  }, [activeThread?.id, connection, handedOff, isInterrupting, isRunning, loadingHistory, queueRecoveryReadyThreadId, queuedMessagesByThread, startNextQueuedMessage, writerConflict])

  const restoreActiveThread = useCallback(async () => {
    if (handedOffRef.current) return
    const threadId = activeThreadId.current
    if (!threadId || restoringThreadId.current === threadId) return
    restoringThreadId.current = threadId
    setLoadingHistory(true)
    try {
      await loadThread(threadId)
    } finally {
      if (restoringThreadId.current !== threadId) return
      restoringThreadId.current = null
      if (activeThreadId.current === threadId) setLoadingHistory(false)
    }
  }, [loadThread])

  const handleEvent = useCallback((event: RemoteEvent) => {
    if (handedOffRef.current && event.type !== 'connection') return
    if (event.type === 'threads.changed') {
      void refreshThreads()
      if (writerConflictRef.current && activeThreadId.current) {
        if (writerRefreshTimer.current !== undefined) window.clearTimeout(writerRefreshTimer.current)
        writerRefreshTimer.current = window.setTimeout(() => {
          writerRefreshTimer.current = undefined
          if (writerConflictRef.current && activeThreadId.current) void loadThread(activeThreadId.current)
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
    // Older app-server notifications can omit threadId on item deltas. When
    // that happens, use the active turn as the second routing key so a second
    // pane does not render another pane's stream.
    if (!eventThreadId && eventTurnId && eventTurnId !== activeTurnId.current) return
    if (eventThreadId && eventThreadId !== activeThreadId.current) {
      if (event.method === 'turn/started') {
        updateCachedThreadRunState(eventThreadId, true, eventTurnId)
        clearThreadCompletion(eventThreadId)
        void refreshThreads()
      } else if (event.method === 'turn/completed') {
        updateCachedThreadRunState(eventThreadId, false, null)
        markThreadCompletion(eventThreadId)
        void startNextQueuedMessage(eventThreadId)
        void prefetchThread({ id: eventThreadId }, true)
        void refreshThreads()
      } else if (event.method === 'turn/workspaceChanges') {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null
        const fileChange = turnId ? workspaceFileChange(turnId, params.changes) : null
        const cachedThread = threadHistoryCache.current.get(eventThreadId)
        if (turnId && fileChange && cachedThread) {
          cacheThreadSnapshot(cachedThread.thread, cachedThread.messages, {
            running: cachedThread.running,
            turnId: cachedThread.turnId,
            fileChangesByTurn: mergeFileChangesByTurn(cachedThread.fileChangesByTurn, { [turnId]: [fileChange] }),
          })
        } else if (turnId && fileChange) {
          void prefetchThread({ id: eventThreadId }, true)
        }
      } else if (event.method === 'thread/name/updated') {
        void refreshThreads()
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
      if (turnId) {
        setActiveTurnId(turnId)
        if (turnThreadId && interruptRequestedThreadId.current === turnThreadId) void dispatchInterrupt(turnThreadId, turnId)
      }
      setQueueRecoveryReadyThreadId(null)
      resetStreamingAssistant()
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(true)
      beginTurnTimer()
      setActivity({ label: interruptRequestedThreadId.current === turnThreadId ? '正在停止…' : '正在思考' })
      activityItemId.current = null
      return
    }
    if (event.method === 'turn/completed') {
      const turn = eventTurn
      const turnThreadId = eventThreadId ?? (typeof turn?.threadId === 'string' ? turn.threadId : activeThreadId.current)
      if (turnThreadId && turnThreadId !== activeThreadId.current) return
      const completedTurnId = typeof turn?.id === 'string'
        ? turn.id
        : typeof params.turnId === 'string' ? params.turnId : activeTurnId.current
      setActiveTurnId(null)
      if (!turnThreadId || interruptRequestedThreadId.current === turnThreadId) {
        interruptRequestedThreadId.current = null
        setIsInterrupting(false)
      }
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(false)
      setQueueRecoveryReadyThreadId(turnThreadId ?? activeThreadId.current)
      // Commit the accumulated text before finalizing the turn. This avoids a
      // trailing timer/transition from recreating a stale streaming message.
      flushStreamingAssistant(true, completedTurnId)
      setMessages((current) => current.map((message) => message.streaming ? {
        ...message,
        streaming: false,
        ...(!message.turnId && completedTurnId ? { turnId: completedTurnId } : {}),
      } : message))
      resetStreamingAssistant()
      finishTurnTimer()
      setActivity(null)
      activityItemId.current = null
      const refreshThreadId = activeThreadId.current
      const refreshRevision = ++historyRevision.current
      const queuedThreadId = turnThreadId ?? refreshThreadId
      // Start only one queued item for each completed turn. Starting it bumps
      // the history revision, so the just-completed snapshot cannot overwrite
      // the optimistic queued user message while its new turn is starting.
      if (queuedThreadId) void startNextQueuedMessage(queuedThreadId)
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
      if (fileChange) addFileChangeToTurn(turnId, fileChange)
      activityItemId.current = typeof item?.id === 'string' ? item.id : null
      setIsRunning(true)
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
      if (fileChange) addFileChangeToTurn(turnId, fileChange)
      setIsRunning(true)
      setActivity({ label: '正在修改文件', detail: fileChange ? `${fileChange.changes.length} 个文件` : undefined })
      return
    }
    if (event.method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `stream-${Date.now()}`
      const delta = typeof params.delta === 'string' ? params.delta : ''
      const part = streamingAssistantParts.current.get(itemId) ?? ''
      streamingAssistantParts.current.set(itemId, part + delta)
      const messageId = streamingAssistantMessageId.current ?? `streaming-assistant-${activeTurnId.current ?? Date.now()}`
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
      streamingAssistantParts.current.set(itemId, text || streamingAssistantParts.current.get(itemId) || '')
      const messageId = streamingAssistantMessageId.current ?? `streaming-assistant-${activeTurnId.current ?? itemId}`
      streamingAssistantMessageId.current = messageId
      scheduleStreamingAssistantRender()
      return
    }
    if (event.method === 'thread/name/updated') void refreshThreads()
  }, [addFileChangeToTurn, beginTurnTimer, cacheThreadSnapshot, clearThreadCompletion, dispatchInterrupt, finishTurnTimer, flushStreamingAssistant, loadThread, markThreadCompletion, prefetchThread, refreshThreads, resetStreamingAssistant, scheduleStreamingAssistantRender, setActiveTurnId, setConnectionState, setHandoffState, startNextQueuedMessage, updateCachedThreadRunState])

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
        if (!disposed && currentGeneration === socketGeneration) handleEvent(event)
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
      resumeFromBackground()
    }
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resumeFromBackground(true)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pageshow', handlePageShow)

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
    }
  }, [enabled, handleEvent, loadModels, loadThreads, onUnauthorized, refreshModels, refreshThreads, restoreActiveThread, setConnectionState, setHandoffState, token])

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
    interruptInFlightThreadId.current = null
    resumedThreadId.current = null
    const memoryCache = threadHistoryCache.current.get(thread.id)
    if (memoryCache) {
      threadHistoryCache.current.delete(thread.id)
      threadHistoryCache.current.set(thread.id, memoryCache)
    }
    const persistedCache = memoryCache || !persistActiveThread ? null : readPersistedActiveThreadCache(thread.id)
    if (persistedCache) cacheThreadSnapshot(persistedCache.thread, persistedCache.messages, {
      fileChangesByTurn: {},
      running: false,
      turnId: null,
    })
    const cachedThread = memoryCache ?? (persistedCache ? {
      thread: persistedCache.thread,
      messages: persistedCache.messages,
      fileChangesByTurn: {},
      running: false,
      turnId: null,
      characters: cachedHistoryCharacters(persistedCache.messages),
    } : null)
    const cachedRunning = Boolean(cachedThread?.running || threadIsRunning(thread))
    setActiveThread(cachedThread ? { ...cachedThread.thread, ...thread } : thread)
    setMessages(cachedThread?.messages ?? [])
    setFileChangesByTurn(cachedThread?.fileChangesByTurn ?? {})
    setIsRunning(cachedRunning)
    setActiveTurnId(cachedRunning ? cachedThread?.turnId ?? null : null)
    setIsInterrupting(false)
    clearTurnTimer()
    setActivity(null)
    writerConflictRef.current = false
    setWriterConflict(false)
    activityItemId.current = null
    setApproval(null)
    setLoadingHistory(!cachedThread)
    if (previousThread && previousThread.id !== thread.id) void prefetchThread(previousThread, true)

    if (cachedThread) {
      // The cache is already on screen. Verify it after the switch settles,
      // but do not turn this background request into a second visible refresh.
      cachedActiveThreadRefreshTimer.current = window.setTimeout(() => {
        cachedActiveThreadRefreshTimer.current = undefined
        void (async () => {
          const loaded = await loadThread(thread.id, threadRevision, true)
          if (requestId === loadRequest.current && loaded) setError(null)
        })()
      }, cachedActiveThreadRefreshDelayMs)
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
  }, [activeThread, cacheThreadSnapshot, cacheVisibleThread, clearThreadCompletion, clearTurnTimer, loadThread, onUnauthorized, persistActiveThread, prefetchThread, resetStreamingAssistant, setActiveTurnId])

  const createThread = useCallback(async (model?: string, approvalPolicy?: CodexApprovalPolicy) => {
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
      const thread = await codexRemoteClient.createThread(token, model, approvalPolicy)
      activeThreadId.current = thread.id
      if (persistActiveThread) persistActiveThreadId(thread.id)
      setQueueRecoveryReadyThreadId(null)
      if (previousThread && previousThread.id !== thread.id) void prefetchThread(previousThread, true)
      resetStreamingAssistant()
      setActiveTurnId(null)
      interruptRequestedThreadId.current = null
      interruptInFlightThreadId.current = null
      resumedThreadId.current = thread.id
      setActiveThread(thread)
      setMessages([])
      setIsRunning(false)
      setIsInterrupting(false)
      clearTurnTimer()
      setActivity(null)
      setFileChangesByTurn({})
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
    if (!payload.text && payload.images.length === 0 && !payload.document) return false
    let thread = activeThread
    if (!thread) {
      thread = await createThread(input.model, input.approvalPolicy)
      if (thread) input.onThreadCreated?.(thread)
    }
    if (!thread) return false
    const threadIsReplying = thread.id === activeThreadId.current && (isRunning || activeTurnId.current !== null)
    const hasQueuedMessages = (queuedMessagesByThreadRef.current[thread.id]?.length ?? 0) > 0
    if (threadIsReplying || hasQueuedMessages) {
      updateQueuedMessages(thread.id, (current) => [...current, payload])
      setError(null)
      // A failed automatic start leaves the queue intact. A later normal
      // submission is a useful retry that still preserves message order.
      if (!threadIsReplying) void startNextQueuedMessage(thread.id)
      return true
    }
    const localId = payload.id
    const rememberStartedTurn = (turnId: string | null) => {
      if (!turnId) return
      setActiveTurnId(turnId)
      setMessages((current) => current.map((message) => message.id === localId && !message.turnId
        ? { ...message, turnId }
        : message))
      if (interruptRequestedThreadId.current === thread.id) void dispatchInterrupt(thread.id, turnId)
    }
    historyRevision.current += 1
    setMessages((current) => [...current, localMessageFromQueuedPayload(payload)])
    setActiveTurnId(null)
    setQueueRecoveryReadyThreadId(null)
    interruptRequestedThreadId.current = null
    interruptInFlightThreadId.current = null
    setIsRunning(true)
    setIsInterrupting(false)
    beginTurnTimer()
    setActivity({ label: '正在思考' })
    writerConflictRef.current = false
    setWriterConflict(false)
    setError(null)
    try {
      const turnResult = await requestTurnStart(thread.id, payload)
      rememberStartedTurn(turnResult.turn_id)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      historyRevision.current += 1
      setMessages((current) => current.filter((message) => message.id !== localId))
      setIsRunning(false)
      setActiveTurnId(null)
      interruptRequestedThreadId.current = null
      interruptInFlightThreadId.current = null
      setIsInterrupting(false)
      clearTurnTimer()
      setActivity(null)
      const message = reason instanceof Error ? reason.message : '发送消息失败'
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
    }
  }, [activeThread, beginTurnTimer, clearTurnTimer, createThread, dispatchInterrupt, isRunning, onUnauthorized, requestTurnStart, setActiveTurnId, startNextQueuedMessage, updateQueuedMessages])

  const interrupt = useCallback(async () => {
    if (handedOffRef.current) return false
    const threadId = activeThread?.id ?? activeThreadId.current
    if (!threadId || !isRunning || isInterrupting) return false
    interruptRequestedThreadId.current = threadId
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

  return {
    connection,
    runtime,
    threads,
    models,
    activeThread,
    messages,
    queuedMessages: activeThread ? queuedMessagesByThread[activeThread.id] ?? emptyQueuedMessages : emptyQueuedMessages,
    isRunning,
    runningTurnId,
    isInterrupting,
    turnStartedAt,
    lastTurnDurationMs,
    activity,
    fileChangesByTurn,
    writerConflict,
    handedOff,
    handoffInProgress,
    loadingHistory,
    error,
    approval,
    completedThreadIds,
    latestThreadCompletion,
    refreshThreads,
    refreshModels,
    selectThread,
    createThread,
    sendMessage,
    sendQueuedMessageNow,
    removeQueuedMessage,
    interrupt,
    handoffToLocalCodex,
    reclaimForRemote,
    respondToApproval,
    clearThreadCompletion,
    refreshActiveThread,
  }
}

export type CodexRemoteController = ReturnType<typeof useCodexRemote>
