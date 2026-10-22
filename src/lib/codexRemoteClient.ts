import { deleteThreadTransportCache, readThreadTransportCache, writeThreadTransportCache, type ThreadTransportSnapshot } from './threadTransportCache'
import { eventTimestamp } from './turnTiming'

export interface CodexThread {
  id: string
  engine?: 'codex' | 'claude-code'
  name?: string | null
  preview?: string
  cwd?: string
  updatedAt?: number | string
  historyRevision?: string
  createdAt?: number | string
  status?: { type?: string }
  canInterrupt?: boolean
}

export interface CodexThreadDetails extends CodexThread {
  turns?: unknown[]
  historyContentRevision?: string
  codexRemoteWorkspaceChanges?: Record<string, unknown>
}

export type ClaudeCodePermissionMode = 'default' | 'manual' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan'

interface ThreadSyncResponse extends CodexThreadDetails {
  historySync?: {
    revision: string
    baseRevision?: string
    turnIds?: string[]
    itemIds?: Record<string, string[]>
    workspaceTurnIds?: string[]
  }
}

export interface CodexMessageImage {
  name: string
  previewUrl: string
}

export interface CodexDocumentAttachment {
  name: string
  content: string
  sourceFileId?: string
}

export interface CodexMessageDocument extends CodexDocumentAttachment {
  charCount: number
}

export interface CodexMessage {
  id: string
  sourceItemId?: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  sentAt?: string
  replyStartedAt?: string
  replyDurationMs?: number
  turnId?: string
  images?: CodexMessageImage[]
  documents?: CodexMessageDocument[]
  streaming?: boolean
}

export interface CodexImageAttachment {
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
}

export interface CodexQueuedMessage {
  id: string
  text: string
  requestText: string
  images: CodexImageAttachment[]
  documents?: CodexDocumentAttachment[]
  createdAt: string
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
  claudeModel?: string
  claudeEffort?: string
  claudePermissionMode?: ClaudeCodePermissionMode
  editing?: boolean
  deliveryState?: 'submitting' | 'pending' | 'sending' | 'unverified'
  blockedReason?: string
  sendAttempt?: { at: string; afterTurnId?: string; afterMessageId?: string; inTurnId?: string }
}

export interface CodexModel {
  id?: string
  model?: string
  displayName?: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
  inputModalities?: string[]
  isDefault?: boolean
}

export interface CodexRuntime {
  available: boolean
  connected: boolean
  workspace: string
  handedOff: boolean
  runtimeMode?: 'shared' | 'isolated' | 'direct'
  runtimeMessage?: string | null
  fallbackReason?: string | null
  error: string | null
}

export interface DeviceChatMember {
  id: string
  name: string
  online: boolean
}

export interface DeviceChatMessage {
  id: string
  sequence: number
  cursor?: number
  kind: 'user' | 'assistant' | 'status' | 'error'
  sender_id: string
  sender_name: string
  target_id?: string | null
  target_name?: string | null
  text: string
  model?: string | null
  effort?: string | null
  approval_policy?: CodexApprovalPolicy | null
  created_at: string
  delivery_state?: 'pending' | 'syncing' | 'error'
}

export interface DeviceChatState {
  node_id: string
  role?: 'host' | 'peer'
  room: { id: string; name: string; host_id: string; host_name: string } | null
  members: DeviceChatMember[]
  messages: DeviceChatMessage[]
  local_thread_id?: string | null
  agent_thread_id?: string | null
  agent_thread_cwd?: string | null
  connected: boolean
}

export interface CodexWorkspaceEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size?: number | null
}

export interface CodexWorkspaceTree {
  cwd: string
  path: string
  entries: CodexWorkspaceEntry[]
  truncated: boolean
  nextOffset: number | null
}

export interface CodexWorkspaceFile {
  path: string
  content: string
  size: number
  revision: string
  hasBom?: boolean
}

export interface CodexWorkspaceImage {
  path: string
  mediaType: CodexImageAttachment['mediaType']
  data: string
  size: number
}

export type CodexApprovalPolicy = 'on-request' | 'untrusted' | 'never'

export interface RemoteEvent {
  type: string
  threadSubscriptions?: boolean
  heartbeats?: boolean
  id?: string
  threadId?: string
  revision?: string
  pinned?: boolean
  method?: string
  params?: Record<string, unknown>
  connected?: boolean
  available?: boolean
  workspace?: string
  handedOff?: boolean
  runtimeMode?: CodexRuntime['runtimeMode']
  runtimeMessage?: string | null
  fallbackReason?: string | null
  error?: string | null
  request_id?: string | number
  decision?: 'accept' | 'decline' | 'cancel'
  message?: string
}

export class RemoteApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message)
    this.name = 'RemoteApiError'
  }
}

const networkRetryDelaysMs = [300, 900, 1_800]
const webSocketConnectionTimeoutMs = 60_000
const webSocketOpenTimeoutMs = 15_000
const heartbeatIntervalMs = 25_000
const heartbeatTimeoutMs = 12_000

export function isAmbiguousNetworkFailure(reason: unknown) {
  if (reason instanceof RemoteApiError) return reason.status === 502 || reason.status === 504
  if (!(reason instanceof Error)) return false
  return reason instanceof TypeError || reason.name === 'TimeoutError'
    || /failed to fetch|network|load failed/i.test(reason.message)
    || (reason instanceof SyntaxError && /unexpected end|unterminated/i.test(reason.message))
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

async function request<T>(
  token: string,
  path: string,
  init?: RequestInit,
  options: { networkRetries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const networkRetries = options.networkRetries ?? (method === 'GET' ? 3 : 0)
  let attempt = 0
  while (true) {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(init?.signal?.reason)
    if (init?.signal?.aborted) abort()
    else init?.signal?.addEventListener('abort', abort, { once: true })
    const timer = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs ?? (method === 'GET' ? 30_000 : 120_000))
    try {
      const response = await fetch(path, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const detail = body?.detail
        const validationDetail = Array.isArray(detail)
          ? detail.map((item) => {
            if (!item || typeof item !== 'object') return ''
            const message = (item as Record<string, unknown>).msg
            return typeof message === 'string' ? message : ''
          }).filter(Boolean).join('；')
          : ''
        const message = typeof detail === 'string'
          ? detail
          : validationDetail || (detail && typeof detail === 'object' && typeof detail.message === 'string' ? detail.message : `请求失败 (${response.status})`)
        const retryAfterHeader = response.headers.get('Retry-After')
        const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader)
        throw new RemoteApiError(
          message,
          response.status,
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds) : undefined,
        )
      }
      // Reading the body can fail after fetch has already received headers.
      // Await it here so those failures use the same safe retry path.
      return await response.json() as T
    } catch (reason) {
      if (init?.signal?.aborted) throw reason
      if (timedOut) {
        const timeoutError = new Error('连接服务器超时，请检查手机网络或远程连接后重试。')
        timeoutError.name = 'TimeoutError'
        reason = timeoutError
      }
      // A timed-out body may already have transferred many bytes. Allow one
      // recovery attempt instead of downloading it repeatedly on a slow link.
      if (!isAmbiguousNetworkFailure(reason) || attempt >= networkRetries || (timedOut && attempt >= 1)) throw reason
      const delay = networkRetryDelaysMs[Math.min(attempt, networkRetryDelaysMs.length - 1)]
      attempt += 1
      await wait(delay)
    } finally {
      globalThis.clearTimeout(timer)
      init?.signal?.removeEventListener('abort', abort)
    }
  }
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (!part || typeof part !== 'object') return ''
    const text = (part as Record<string, unknown>).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

function originalPdfAttachmentsFromText(value: string) {
  const documents: CodexDocumentAttachment[] = []
  const collectAttachment = (_block: string, sourceFileId: string, encodedName: string) => {
    let name = encodedName
    try {
      name = decodeURIComponent(encodedName)
    } catch {
      // Keep a readable fallback if an old or malformed history has an invalid filename marker.
    }
    documents.push({ name, content: '', sourceFileId })
    return ''
  }
  const text = value.replace(
    /\[\[CODEX_REMOTE_FILE_BEGIN id=([A-Za-z0-9_-]{24,64}) name=([^\]\r\n]+)\]\][\s\S]*?\[\[CODEX_REMOTE_FILE_END id=\1\]\]/g,
    collectAttachment,
  ).replace(
    /\[\[CODEX_REMOTE_PDF_BEGIN id=([A-Za-z0-9_-]{24,64}) name=([^\]\r\n]+)\]\][\s\S]*?\[\[CODEX_REMOTE_PDF_END id=\1\]\]/g,
    collectAttachment,
  ).replace(/\n{3,}/g, '\n\n').trim()
  return { text, documents }
}

function textDocumentAttachmentsFromText(value: string) {
  const documents: CodexDocumentAttachment[] = []
  const text = value.replace(
    /\[附件文档：([^\r\n]+)\]\r?\n([\s\S]*?)\r?\n\[\/附件文档\]/g,
    (_block, name: string, content: string) => {
      documents.push({ name, content })
      return ''
    },
  ).replace(/\n{3,}/g, '\n\n').trim()
  return { text, documents }
}

function messageRequestText(message: CodexMessage) {
  const documentText = message.documents
    ?.filter((document) => !document.sourceFileId)
    .map((document) => `\n\n[附件文档：${document.name}]\n${document.content}\n[/附件文档]`)
    .join('') ?? ''
  return `${message.text}${documentText}`.trim()
}

function imagesFromContent(value: unknown): CodexMessageImage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((part, index) => {
    if (!part || typeof part !== 'object') return []
    const image = part as Record<string, unknown>
    const dataUrl = image.type === 'image' && typeof image.image_url === 'string'
      ? image.image_url
      : ''
    const embeddedData = image.type === 'localImage' && typeof image.data === 'string'
      ? image.data
      : ''
    const mediaType = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,/)?.[1]
      ?? (typeof image.mediaType === 'string'
        ? image.mediaType
        : typeof image.media_type === 'string' ? image.media_type : 'image/png')
    const previewUrl = dataUrl.match(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/)
      ? dataUrl
      : /^(?:image\/(?:png|jpeg|webp|gif))$/.test(mediaType) && /^[A-Za-z0-9+/]+={0,2}$/.test(embeddedData)
        ? `data:${mediaType};base64,${embeddedData}`
        : ''
    if (!previewUrl) return []
    const name = typeof image.name === 'string' && image.name.length > 0 ? image.name : `image-${index + 1}`
    return [{ name, previewUrl }]
  })
}

/** Build a provisional user bubble directly from the app-server item notification. */
export function userMessageFromEventItem(value: unknown, turnId: string | null): CodexMessage | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const itemType = typeof item.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
  if (itemType !== 'usermessage' || typeof item.id !== 'string' || !item.id) return null

  const itemId = item.id
  const rawText = plainText(item.content) || (typeof item.text === 'string' ? item.text : '')
  const originalPdfAttachments = originalPdfAttachmentsFromText(rawText)
  const textDocumentAttachments = textDocumentAttachmentsFromText(originalPdfAttachments.text)
  const text = textDocumentAttachments.text
  const documents = [...originalPdfAttachments.documents, ...textDocumentAttachments.documents]
  const images = imagesFromContent(item.content)
  if (!text && images.length === 0 && documents.length === 0) return null

  const sentAt = parsedTimestampFromFields(
    item,
    'createdAt', 'created_at', 'sentAt', 'sent_at', 'timestamp', 'timestampMs', 'timestamp_ms',
  ) ?? new Date().toISOString()
  return {
    id: `remote-user-${itemId}`,
    sourceItemId: itemId,
    role: 'user',
    text,
    createdAt: sentAt,
    sentAt,
    ...(turnId ? { turnId } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? {
      documents: documents.map((document) => ({ ...document, charCount: document.content.length })),
    } : {}),
  }
}

function parsedTimestamp(value: unknown): string | null {
  const timestamp = eventTimestamp(value)
  return timestamp === null ? null : new Date(timestamp).toISOString()
}

function parsedTimestampFromFields(value: Record<string, unknown>, ...fields: string[]) {
  for (const field of fields) {
    const timestamp = parsedTimestamp(value[field])
    if (timestamp) return timestamp
  }
  return null
}

function timestamp(value: unknown) {
  return parsedTimestamp(value) ?? new Date().toISOString()
}

export function messagesFromThread(thread: CodexThreadDetails): CodexMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const messages: CodexMessage[] = []
  for (const turnValue of turns) {
    if (!turnValue || typeof turnValue !== 'object') continue
    const turn = turnValue as Record<string, unknown>
    if (!Array.isArray(turn.items)) continue
    const turnId = typeof turn.id === 'string' ? turn.id : undefined
    const turnStartedAt = parsedTimestampFromFields(turn, 'startedAt', 'started_at', 'startedAtMs', 'started_at_ms', 'createdAt', 'created_at')
    const turnCompletedAt = parsedTimestampFromFields(turn, 'completedAt', 'completed_at', 'completedAtMs', 'completed_at_ms')
    const replyDurationMs = turnStartedAt && turnCompletedAt
      ? Math.max(0, Date.parse(turnCompletedAt) - Date.parse(turnStartedAt))
      : undefined
    let assistantMessage: CodexMessage | null = null
    for (const itemValue of turn.items) {
      if (!itemValue || typeof itemValue !== 'object') continue
      const item = itemValue as Record<string, unknown>
      const itemType = typeof item.type === 'string' ? item.type.replace(/[-_]/g, '').toLowerCase() : ''
      if (itemType !== 'usermessage' && itemType !== 'agentmessage') continue
      const rawText = itemType === 'usermessage' ? plainText(item.content) : plainText(item.text)
      const originalPdfAttachments = itemType === 'usermessage' ? originalPdfAttachmentsFromText(rawText) : { text: rawText, documents: [] }
      const textDocumentAttachments = itemType === 'usermessage'
        ? textDocumentAttachmentsFromText(originalPdfAttachments.text)
        : { text: originalPdfAttachments.text, documents: [] }
      const text = textDocumentAttachments.text
      const documents = [...originalPdfAttachments.documents, ...textDocumentAttachments.documents]
      const images = itemType === 'usermessage' ? imagesFromContent(item.content) : []
      if (!text && images.length === 0 && documents.length === 0) continue
      const itemCreatedAt = parsedTimestampFromFields(
        item,
        'createdAt', 'created_at', 'sentAt', 'sent_at', 'timestamp', 'timestampMs', 'timestamp_ms',
      )
      const replyStartedAt = itemType === 'agentmessage' ? turnStartedAt ?? itemCreatedAt : undefined

      if (itemType === 'agentmessage' && assistantMessage) {
        assistantMessage.text = assistantMessage.text
          ? `${assistantMessage.text}\n\n${text}`
          : text
        continue
      }

      messages.push({
        id: typeof item.id === 'string' ? item.id : `${String(turn.id ?? 'turn')}-${messages.length}`,
        role: itemType === 'usermessage' ? 'user' : 'assistant',
        text,
        createdAt: itemCreatedAt ?? replyStartedAt ?? turnStartedAt ?? timestamp(turn.startedAt ?? turn.started_at),
        ...(itemType === 'usermessage' ? { sentAt: itemCreatedAt ?? turnStartedAt ?? undefined } : {}),
        ...(replyStartedAt ? { replyStartedAt } : {}),
        ...(itemType === 'agentmessage' && replyDurationMs !== undefined ? { replyDurationMs } : {}),
        ...(turnId ? { turnId } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(documents.length > 0 ? {
          documents: documents.map((document) => ({ ...document, charCount: document.content.length })),
        } : {}),
      })
      assistantMessage = itemType === 'agentmessage' ? messages.at(-1)! : null
    }
  }
  return messages
}

export function threadContainsNewPayload(
  thread: CodexThreadDetails,
  previousMessageIds: Set<string>,
  previousTurnIds: Set<string>,
  payload: { requestText: string; images: CodexImageAttachment[]; documents?: CodexDocumentAttachment[] },
) {
  const recoveredMessages = messagesFromThread(thread)
  let lastKnownMessageIndex = -1
  for (let index = recoveredMessages.length - 1; index >= 0; index -= 1) {
    const message = recoveredMessages[index]
    if (previousMessageIds.has(message.id) || (message.turnId !== undefined && previousTurnIds.has(message.turnId))) {
      lastKnownMessageIndex = index
      break
    }
  }
  // A cached history can omit older messages with the same short prompt.
  // Confirm only messages after the last known turn, never those older ones.
  if (lastKnownMessageIndex < 0) return false
  const expectedPdfIds = (payload.documents ?? []).flatMap((document) => document.sourceFileId ? [document.sourceFileId] : [])
  return recoveredMessages.slice(lastKnownMessageIndex + 1).some((message) => {
    if (message.role !== 'user') return false
    if (payload.requestText && message.text !== payload.requestText && messageRequestText(message) !== payload.requestText) return false
    if (expectedPdfIds.length > 0) {
      const actualPdfIds = (message.documents ?? []).flatMap((document) => document.sourceFileId ? [document.sourceFileId] : [])
      return expectedPdfIds.length === actualPdfIds.length && expectedPdfIds.every((id, index) => id === actualPdfIds[index])
    }
    if (payload.requestText) return true
    const images = message.images ?? []
    return images.length === payload.images.length
      && images.every((image, index) => image.name === payload.images[index]?.name)
  })
}

function threadUpdatedAt(thread: CodexThread): number {
  const value = thread.updatedAt ?? thread.createdAt
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  if (typeof value === 'string') return Date.parse(value) || 0
  return 0
}

function uniqueThreads(threads: CodexThread[]) {
  const latestById = new Map<string, CodexThread>()
  for (const thread of threads) {
    const current = latestById.get(thread.id)
    if (!current || threadUpdatedAt(thread) > threadUpdatedAt(current)) latestById.set(thread.id, thread)
  }
  return [...latestById.values()]
}

const threadListRequests = new Map<string, Promise<CodexThread[]>>()
const threadLists = new Map<string, { threads: CodexThread[]; fetchedAt: number }>()
export const threadListRefreshIntervalMs = 15_000
const threadReadRequests = new Map<string, Promise<CodexThreadDetails>>()
const syncControllers = new Map<string, AbortController>()

function syncSignal(token: string) {
  let controller = syncControllers.get(token)
  if (!controller) {
    controller = new AbortController()
    syncControllers.set(token, controller)
  }
  return controller.signal
}

function recordsById(values: unknown[]) {
  const result = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id || result.has(record.id)) return null
    result.set(record.id, record)
  }
  return result
}

function uniqueIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(value).size === value.length
}

function mergeThreadSync(response: ThreadSyncResponse, cached?: ThreadTransportSnapshot): CodexThreadDetails | null {
  const { historySync: sync, ...thread } = response
  if (!sync) return thread
  if (typeof sync.revision !== 'string' || !sync.revision) return null
  if (sync.baseRevision === undefined) return thread
  if (!cached || sync.baseRevision !== cached.revision || cached.thread.id !== thread.id
    || !uniqueIds(sync.turnIds) || !uniqueIds(sync.workspaceTurnIds)
    || !sync.itemIds || typeof sync.itemIds !== 'object' || Array.isArray(sync.itemIds)
    || !Array.isArray(thread.turns) || !Array.isArray(cached.thread.turns)) return null
  const turns = recordsById(cached.thread.turns ?? [])
  const changedTurns = recordsById(thread.turns)
  if (!turns || !changedTurns || Object.keys(sync.itemIds).length !== changedTurns.size) return null
  const turnIds = new Set(sync.turnIds)
  for (const [turnId, turn] of changedTurns) {
    if (!Array.isArray(turn.items) || !turnIds.has(turnId) || !Object.hasOwn(sync.itemIds, turnId)) return null
    const order = sync.itemIds[turnId]
    if (!uniqueIds(order)) return null
    const itemIds = new Set(order)
    const previous = turns.get(turnId)
    const items = recordsById(Array.isArray(previous?.items) ? previous.items : [])
    const changedItems = recordsById(turn.items)
    if (!items || !changedItems) return null
    for (const [id, item] of changedItems) {
      if (!itemIds.has(id)) return null
      items.set(id, item)
    }
    if (order.some((id) => !items.has(id))) return null
    turns.set(turnId, { ...turn, items: order.map((id) => items.get(id)) })
  }
  if (sync.turnIds.some((id) => !turns.has(id))) return null
  if (thread.codexRemoteWorkspaceChanges !== undefined && (!thread.codexRemoteWorkspaceChanges
    || typeof thread.codexRemoteWorkspaceChanges !== 'object' || Array.isArray(thread.codexRemoteWorkspaceChanges))) return null
  const workspace = { ...cached.thread.codexRemoteWorkspaceChanges, ...thread.codexRemoteWorkspaceChanges }
  if (sync.workspaceTurnIds.some((id) => !Object.hasOwn(workspace, id))) return null
  return {
    ...thread,
    turns: sync.turnIds.map((id) => turns.get(id)),
    codexRemoteWorkspaceChanges: Object.fromEntries(sync.workspaceTurnIds.map((id) => [id, workspace[id]])),
  }
}

async function readThreadWithChanges(token: string, threadId: string, key: string) {
  const signal = syncSignal(token)
  const cached = await readThreadTransportCache(key, threadId)
  const path = `/api/v1/codex/threads/${encodeURIComponent(threadId)}`
  const options = { timeoutMs: 120_000 }
  let response = await request<ThreadSyncResponse>(token, `${path}${cached ? `?since=${encodeURIComponent(cached.revision)}` : ''}`, { signal }, options)
  let thread = mergeThreadSync(response, cached)
  if (!thread) {
    await deleteThreadTransportCache(key, threadId)
    response = await request<ThreadSyncResponse>(token, path, { signal }, options)
    thread = mergeThreadSync(response)
    if (!thread) throw new Error('聊天增量同步的历史版本不完整，请刷新聊天后重试。')
  }
  if (thread.id !== threadId) throw new Error('聊天同步返回了不匹配的对话，请刷新后重试。')
  const revision = response.historySync?.revision
  if (typeof revision === 'string' && revision) {
    thread = { ...thread, historyContentRevision: revision }
    if (revision !== cached?.revision || response.historySync?.baseRevision === undefined) {
      await writeThreadTransportCache(key, { thread, revision })
    }
  } else {
    await deleteThreadTransportCache(key, threadId)
  }
  signal.throwIfAborted()
  return thread
}

function shareRequest<T>(requests: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  const existing = requests.get(key)
  if (existing) return existing
  const pending = read().finally(() => {
    if (requests.get(key) === pending) requests.delete(key)
  })
  requests.set(key, pending)
  return pending
}

export const codexRemoteClient = {
  pauseHistorySync(token: string) {
    syncSignal(token)
    syncControllers.get(token)?.abort()
  },
  resumeHistorySync(token: string) {
    if (syncControllers.get(token)?.signal.aborted) syncControllers.set(token, new AbortController())
  },
  updateThreadListEntry(token: string, threadId: string, patch: Partial<CodexThread> | null) {
    const cached = threadLists.get(token)
    if (!cached) return
    cached.threads = patch === null
      ? cached.threads.filter((thread) => thread.id !== threadId)
      : cached.threads.map((thread) => thread.id === threadId ? { ...thread, ...patch } : thread)
  },
  pair(code: string) {
    return request<{ token: string }>('pairing', '/api/v1/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }, { timeoutMs: 10_000 }).catch((reason) => {
      if (reason instanceof Error && (reason.name === 'TimeoutError' || reason.name === 'AbortError')) {
        throw new Error('连接超时，请确认 Code Remote 服务正在运行后重试。')
      }
      throw reason
    })
  },
  unpair(token: string) {
    return request<{ unpaired: boolean }>(token, '/api/v1/unpair', { method: 'POST' })
  },
  deviceChatState(token: string, afterCursor?: number, afterSequence?: number) {
    const parameters = new URLSearchParams()
    if (afterCursor !== undefined) parameters.set('after_cursor', String(afterCursor))
    if (afterSequence !== undefined) parameters.set('after_sequence', String(afterSequence))
    const encodedParameters = parameters.toString()
    const query = encodedParameters ? `?${encodedParameters}` : ''
    return request<DeviceChatState>(token, `/api/v1/device-chat/state${query}`, undefined, { timeoutMs: 8_000, networkRetries: 0 })
  },
  createDeviceChat(token: string, name: string) {
    return request<{ state: DeviceChatState; invite_code: string; expires_in: number }>(token, '/api/v1/device-chat/create', {
      method: 'POST', body: JSON.stringify({ name }),
    })
  },
  inviteDeviceChat(token: string, name: string) {
    return request<{ state: DeviceChatState; invite_code: string; expires_in: number }>(token, '/api/v1/device-chat/invite', {
      method: 'POST', body: JSON.stringify({ name }),
    })
  },
  joinDeviceChat(token: string, hostUrl: string, code: string, name: string) {
    return request<DeviceChatState>(token, '/api/v1/device-chat/join', {
      method: 'POST', body: JSON.stringify({ host_url: hostUrl, code, name }),
    }, { timeoutMs: 20_000, networkRetries: 0 })
  },
  sendDeviceChatMessage(token: string, text: string, targetId: string | null, model?: string, effort?: string, approvalPolicy?: CodexApprovalPolicy) {
    return request<DeviceChatMessage>(token, '/api/v1/device-chat/message', {
      method: 'POST', body: JSON.stringify({ text, target_id: targetId, model: model || null, effort: effort || null, approval_policy: approvalPolicy || null }),
    }, { timeoutMs: 15_000, networkRetries: 0 })
  },
  bindDeviceChatWorkspace(token: string, cwd: string) {
    return request<DeviceChatState>(token, '/api/v1/device-chat/workspace', {
      method: 'PUT', body: JSON.stringify({ cwd }),
    })
  },
  selectDeviceChatThread(token: string, threadId: string | null) {
    return request<DeviceChatState>(token, '/api/v1/device-chat/thread', {
      method: 'PUT', body: JSON.stringify({ thread_id: threadId }),
    })
  },
  leaveDeviceChat(token: string) {
    return request<{ left: boolean }>(token, '/api/v1/device-chat/leave', { method: 'POST' }, { timeoutMs: 10_000, networkRetries: 0 })
  },
  status(token: string) {
    return request<CodexRuntime>(token, '/api/v1/codex/status', undefined, { timeoutMs: 10_000, networkRetries: 0 })
  },
  claudeStatus(token: string) {
    return request<{ available: boolean; error: string | null }>(token, '/api/v1/claude/status', undefined, { timeoutMs: 10_000, networkRetries: 0 })
  },
  workspaceTree(token: string, cwd?: string, path = '', offset = 0) {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    if (path) query.set('path', path)
    if (offset > 0) query.set('offset', String(offset))
    return request<CodexWorkspaceTree>(token, `/api/v1/codex/workspace/tree${query.size ? '?' + query.toString() : ''}`)
  },
  workspaceFile(token: string, cwd: string | undefined, path: string) {
    const query = new URLSearchParams({ path })
    if (cwd) query.set('cwd', cwd)
    return request<CodexWorkspaceFile>(token, `/api/v1/codex/workspace/file?${query.toString()}`)
  },
  workspaceImage(token: string, cwd: string | undefined, path: string) {
    const query = new URLSearchParams({ path })
    if (cwd) query.set('cwd', cwd)
    return request<CodexWorkspaceImage>(token, `/api/v1/codex/workspace/image?${query.toString()}`)
  },
  codexViewedImage(token: string, threadId: string, path: string) {
    const query = new URLSearchParams({ path })
    return request<CodexWorkspaceImage>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/viewed-image?${query.toString()}`)
  },
  saveWorkspaceFile(token: string, cwd: string | undefined, path: string, content: string, revision: string) {
    return request<CodexWorkspaceFile>(token, '/api/v1/codex/workspace/file', {
      method: 'POST',
      body: JSON.stringify({ cwd, path, content, revision }),
    })
  },
  createWorkspaceEntry(token: string, cwd: string | undefined, path: string, kind: CodexWorkspaceEntry['kind']) {
    return request<CodexWorkspaceEntry>(token, '/api/v1/codex/workspace/entries', {
      method: 'POST',
      body: JSON.stringify({ cwd, path, kind }),
    })
  },
  renameWorkspaceEntry(token: string, cwd: string | undefined, path: string, name: string) {
    return request<{ oldPath: string; entry: CodexWorkspaceEntry }>(token, '/api/v1/codex/workspace/entry', {
      method: 'PATCH',
      body: JSON.stringify({ cwd, path, name }),
    })
  },
  deleteWorkspaceEntries(token: string, cwd: string | undefined, paths: string[]) {
    return request<{ deleted: string[] }>(token, '/api/v1/codex/workspace/delete', {
      method: 'POST',
      body: JSON.stringify({ cwd, paths }),
    })
  },
  pasteWorkspaceEntries(token: string, cwd: string | undefined, paths: string[], destination: string, mode: 'copy' | 'move') {
    return request<{ mode: 'copy' | 'move'; entries: CodexWorkspaceEntry[]; changedPaths: string[] }>(token, '/api/v1/codex/workspace/paste', {
      method: 'POST',
      body: JSON.stringify({ cwd, paths, destination, mode }),
    })
  },
  threads(token: string, force = false) {
    const pending = threadListRequests.get(token)
    if (pending) return pending
    const cached = threadLists.get(token)
    if (!force && cached && Date.now() - cached.fetchedAt < threadListRefreshIntervalMs) return Promise.resolve(cached.threads)
    return shareRequest(threadListRequests, token, async () => {
      const result = await request<CodexThread[]>(token, '/api/v1/codex/threads', { signal: syncSignal(token) }, { networkRetries: 0 })
      const threads = uniqueThreads(result).sort((left, right) => threadUpdatedAt(right) - threadUpdatedAt(left))
      threadLists.delete(token)
      threadLists.set(token, { threads, fetchedAt: Date.now() })
      if (threadLists.size > 3) threadLists.delete(threadLists.keys().next().value!)
      return threads
    })
  },
  readThread(token: string, threadId: string) {
    const key = JSON.stringify([token, threadId])
    return shareRequest(threadReadRequests, key, () => readThreadWithChanges(token, threadId, key))
  },
  deleteThread(token: string, threadId: string) {
    return request<{ thread_id: string; deleted: true; thread_ids: string[] }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
    }).then((result) => { threadLists.delete(token); return result })
  },
  renameThread(token: string, threadId: string, name: string) {
    return request<{ thread_id: string; name: string }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/name`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then((result) => { threadLists.delete(token); return result })
  },
  bindThreadWorkspace(token: string, threadId: string, cwd: string) {
    return request<{ thread_id: string; cwd: string }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/workspace`, {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }).then((result) => { threadLists.delete(token); return result })
  },
  updateThreadApprovalPolicy(token: string, threadId: string, approvalPolicy: CodexApprovalPolicy) {
    return request<Record<string, unknown>>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/settings`, {
      method: 'POST',
      body: JSON.stringify({ approval_policy: approvalPolicy }),
    })
  },
  queuedMessages(token: string, threadId: string) {
    return request<{ queue: CodexQueuedMessage[] }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}`)
  },
  submitMessage(token: string, threadId: string, message: CodexQueuedMessage) {
    return request<{ queue: CodexQueuedMessage[]; sent: boolean }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/submit`, {
      method: 'POST',
      body: JSON.stringify(message),
    }, { networkRetries: 3 })
  },
  continuePausedThread(token: string, threadId: string, message?: CodexQueuedMessage) {
    return request<{ queue: CodexQueuedMessage[]; continued: boolean; turn_id: string }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/continue`, {
      method: 'POST',
      ...(message ? { body: JSON.stringify(message) } : {}),
    }, { networkRetries: 0 })
  },
  stopInterruptedThread(token: string, threadId: string) {
    return request<{ stopped: boolean }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/stop`, {
      method: 'POST',
    }, { networkRetries: 0 })
  },
  enqueueMessage(token: string, threadId: string, message: CodexQueuedMessage) {
    return request<{ queue: CodexQueuedMessage[] }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/enqueue`, {
      method: 'POST',
      body: JSON.stringify(message),
    }, { networkRetries: 3 })
  },
  queueAction(token: string, threadId: string, action: 'edit/begin' | 'edit/end' | 'remove' | 'send-now', messageId: string, ownerId?: string) {
    return request<{ queue: CodexQueuedMessage[]; sent?: boolean }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId, owner_id: ownerId }),
    }, { networkRetries: 3 })
  },
  renewQueuedEdit(token: string, threadId: string, messageId: string, ownerId: string) {
    return request<{ renewed: boolean }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/edit/renew`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId, owner_id: ownerId }),
    })
  },
  startQueuedIfIdle(token: string, threadId: string, messageId: string) {
    return request<{ queue: CodexQueuedMessage[]; sent: boolean }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/start-if-idle`, {
      method: 'POST', body: JSON.stringify({ message_id: messageId }),
    }, { networkRetries: 3 })
  },
  updateQueuedMessage(token: string, threadId: string, message: CodexQueuedMessage) {
    return request<{ queue: CodexQueuedMessage[] }>(token, `/api/v1/codex/queue/${encodeURIComponent(threadId)}/edit/update`, {
      method: 'POST',
      body: JSON.stringify(message),
    }, { networkRetries: 3 })
  },
  pins(token: string) {
    return request<{ thread_ids: string[] }>(token, '/api/v1/codex/pins')
  },
  initializePins(token: string, threadIds: string[]) {
    return request<{ thread_ids: string[] }>(token, '/api/v1/codex/pins/initialize', {
      method: 'POST', body: JSON.stringify({ thread_ids: threadIds }),
    }, { networkRetries: 3 })
  },
  setThreadPin(token: string, threadId: string, pinned: boolean) {
    return request<{ thread_ids: string[] }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/pin`, {
      method: 'POST', body: JSON.stringify({ pinned }),
    }, { networkRetries: 3 })
  },
  resumeThread(token: string, threadId: string, requestId: string) {
    return request<CodexThread>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/resume`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, include_history: false }),
    }, { networkRetries: 3 })
  },
  models(token: string) {
    return request<CodexModel[]>(token, '/api/v1/codex/models')
  },
  handoffToLocalCodex(token: string) {
    return request<{ handedOff: true }>(token, '/api/v1/codex/handoff', { method: 'POST' })
  },
  reclaimForRemote(token: string) {
    return request<CodexRuntime>(token, '/api/v1/codex/reclaim', { method: 'POST' })
  },
  createThread(token: string, model: string | undefined, approvalPolicy: CodexApprovalPolicy | undefined, requestId: string, cwd?: string, engine: 'codex' | 'claude-code' = 'codex') {
    return request<CodexThread>(token, '/api/v1/codex/threads', {
      method: 'POST',
      body: JSON.stringify({ engine, model, approval_policy: approvalPolicy, request_id: requestId, cwd }),
    }, { networkRetries: 3 }).then((result) => { threadLists.delete(token); return result })
  },
  uploadPdfAttachment(token: string, file: File) {
    const query = new URLSearchParams({ name: file.name })
    return request<{ attachment_id: string; name: string; size: number }>(token, `/api/v1/codex/pdf-attachments?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  },
  startTurn(token: string, threadId: string, input: {
    prompt: string
    images: CodexImageAttachment[]
    documents?: CodexDocumentAttachment[]
    model?: string
    effort?: string
    approvalPolicy?: CodexApprovalPolicy
    claudeModel?: string
    claudeEffort?: string
    claudePermissionMode?: ClaudeCodePermissionMode
    requestId: string
  }) {
    return request<{ turn_id: string | null }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        approval_policy: input.approvalPolicy,
        claude_model: input.claudeModel,
        claude_effort: input.claudeEffort,
        claude_permission_mode: input.claudePermissionMode,
        request_id: input.requestId,
        images: input.images.map((image) => ({
          name: image.name,
          media_type: image.mediaType,
          data: image.data,
        })),
        pdf_attachments: (input.documents ?? []).flatMap((document) => document.sourceFileId ? [document.sourceFileId] : []),
      }),
    }, { networkRetries: 3 })
  },
  steerTurn(token: string, threadId: string, input: {
    prompt: string
    images: CodexImageAttachment[]
    documents?: CodexDocumentAttachment[]
    requestId: string
  }) {
    return request<{ turn_id: string | null }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/steer`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: input.prompt,
        request_id: input.requestId,
        images: input.images.map((image) => ({
          name: image.name,
          media_type: image.mediaType,
          data: image.data,
        })),
        pdf_attachments: (input.documents ?? []).flatMap((document) => document.sourceFileId ? [document.sourceFileId] : []),
      }),
    }, { networkRetries: 3 })
  },
  interrupt(token: string, threadId: string, turnId?: string | null) {
    return request<{ interrupted: boolean; stale?: boolean }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ turn_id: turnId }),
    })
  },
  connect(token: string, onEvent: (event: RemoteEvent) => void, onState: (state: 'connecting' | 'connected' | 'disconnected' | 'unavailable') => void, threadId: string | null = null) {
    const url = new URL('/api/v1/codex/ws', window.location.origin)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    onState('connecting')
    let stopped = false
    let receivedConnection = false
    let subscribedThreadId = threadId
    let supportsSubscriptions = false
    let supportsHeartbeats = false
    let lastReceivedAt = Date.now()
    let connectionTimeout: number | undefined
    let heartbeatTimer: number | undefined
    let heartbeatDeadline: number | undefined
    let pingSequence = 0
    let pendingPing: { id: string; sentAt: number; promise: Promise<boolean>; resolve: (healthy: boolean) => void } | null = null

    const finishPing = (healthy: boolean) => {
      if (heartbeatDeadline !== undefined) window.clearTimeout(heartbeatDeadline)
      heartbeatDeadline = undefined
      const ping = pendingPing
      pendingPing = null
      ping?.resolve(healthy)
    }
    const clearTimers = () => {
      if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      connectionTimeout = undefined
      heartbeatTimer = undefined
      finishPing(false)
    }
    const fail = (message?: string, nextState: 'disconnected' | 'unavailable' = 'disconnected') => {
      if (stopped) return
      stopped = true
      clearTimers()
      socket.close()
      if (message) onEvent({ type: 'error', message })
      onState(nextState)
    }
    const send = (payload: Record<string, unknown>) => {
      if (stopped || socket.readyState !== WebSocket.OPEN) return false
      try {
        socket.send(JSON.stringify(payload))
        return true
      } catch {
        fail()
        return false
      }
    }
    const scheduleHeartbeat = () => {
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      if (stopped || !supportsHeartbeats) return
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = undefined
        if (document.visibilityState === 'hidden' || Date.now() - lastReceivedAt < heartbeatIntervalMs) {
          scheduleHeartbeat()
        } else {
          void checkConnection()
        }
      }, heartbeatIntervalMs)
    }
    const transmitPing = () => {
      const ping = pendingPing
      if (!ping) return
      ping.sentAt = Date.now()
      if (!send({ type: 'ping', id: ping.id })) {
        fail()
        return
      }
      heartbeatDeadline = window.setTimeout(() => {
        if (pendingPing !== ping || stopped) return
        if (document.visibilityState === 'hidden') {
          finishPing(false)
          scheduleHeartbeat()
        } else if (Date.now() - ping.sentAt > heartbeatTimeoutMs + 5_000) {
          // A frozen mobile timer can run immediately after waking. Give the
          // restored network a fresh probe instead of timing out its sleep.
          transmitPing()
        } else {
          fail('聊天连接暂时没有响应，正在重新连接…')
        }
      }, heartbeatTimeoutMs)
    }
    const checkConnection = (): Promise<boolean> => {
      if (stopped || !receivedConnection) return Promise.resolve(false)
      if (socket.readyState !== WebSocket.OPEN) {
        fail()
        return Promise.resolve(false)
      }
      // Older servers reject unknown messages. Reconnect a stale connection
      // only when asked on foreground/network recovery until they are updated.
      if (!supportsHeartbeats) return Promise.resolve(Date.now() - lastReceivedAt < heartbeatIntervalMs)
      if (pendingPing) {
        const ping = pendingPing
        if (Date.now() - ping.sentAt > 1_000) {
          if (heartbeatDeadline !== undefined) window.clearTimeout(heartbeatDeadline)
          transmitPing()
        }
        return ping.promise
      }
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
      heartbeatTimer = undefined
      let resolve!: (healthy: boolean) => void
      const promise = new Promise<boolean>((done) => { resolve = done })
      pendingPing = { id: String(++pingSequence), sentAt: Date.now(), promise, resolve }
      transmitPing()
      return promise
    }
    const armConnectionTimeout = (milliseconds: number) => {
      if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
      connectionTimeout = window.setTimeout(() => {
        if (!receivedConnection) fail('连接服务器超时，正在重试…', 'unavailable')
      }, milliseconds)
    }
    const subscribeThread = (nextThreadId: string | null) => {
      subscribedThreadId = nextThreadId
      if (supportsSubscriptions) send({ type: 'thread.subscribe', thread_id: nextThreadId })
    }
    armConnectionTimeout(webSocketOpenTimeoutMs)
    socket.addEventListener('open', () => {
      if (!send({ type: 'codex.client.hello', protocol_version: 1, token, thread_id: subscribedThreadId })) return
      armConnectionTimeout(webSocketConnectionTimeoutMs)
    })
    socket.addEventListener('message', (message) => {
      if (stopped) return
      try {
        const event = JSON.parse(String(message.data)) as RemoteEvent
        if (!event.type) return
        lastReceivedAt = Date.now()
        if (event.type === 'pong') {
          if (pendingPing?.id === event.id) {
            finishPing(true)
            scheduleHeartbeat()
          }
          return
        }
        if (event.type === 'connection') {
          if (event.threadSubscriptions && !supportsSubscriptions) {
            supportsSubscriptions = true
            subscribeThread(subscribedThreadId)
          }
          supportsHeartbeats ||= event.heartbeats === true
          receivedConnection = true
          if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
          connectionTimeout = undefined
          scheduleHeartbeat()
          onState(event.connected ? 'connected' : event.available ? 'disconnected' : 'unavailable')
        }
        onEvent(event)
      } catch {
        fail('聊天连接返回异常，正在重新连接…')
      }
    })
    socket.addEventListener('error', () => fail())
    socket.addEventListener('close', () => {
      if (stopped) return
      stopped = true
      clearTimers()
      onState('disconnected')
    })
    return {
      checkConnection,
      subscribeThread,
      respondToApproval(requestId: string | number, decision: 'accept' | 'decline' | 'cancel') {
        return send({ type: 'approval.response', request_id: requestId, decision })
      },
      close() {
        stopped = true
        clearTimers()
        socket.close()
      },
    }
  },
}
