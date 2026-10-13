export interface CodexThread {
  id: string
  name?: string | null
  preview?: string
  cwd?: string
  updatedAt?: number | string
  createdAt?: number | string
  status?: { type?: string }
}

export interface CodexThreadDetails extends CodexThread {
  turns?: unknown[]
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
  error: string | null
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

export type CodexApprovalPolicy = 'on-request' | 'untrusted' | 'never'

export interface RemoteEvent {
  type: string
  threadId?: string
  pinned?: boolean
  method?: string
  params?: Record<string, unknown>
  connected?: boolean
  available?: boolean
  workspace?: string
  handedOff?: boolean
  error?: string | null
  request_id?: string | number
  message?: string
}

export class RemoteApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RemoteApiError'
  }
}

const networkRetryDelaysMs = [300, 900, 1_800]

export function isAmbiguousNetworkFailure(reason: unknown) {
  if (reason instanceof RemoteApiError) return reason.status === 502 || reason.status === 504
  if (!(reason instanceof Error)) return false
  return reason instanceof TypeError
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
  options: { networkRetries?: number } = {},
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const networkRetries = options.networkRetries ?? (method === 'GET' ? 3 : 0)
  let attempt = 0
  while (true) {
    try {
      const response = await fetch(path, {
        ...init,
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
        throw new RemoteApiError(message, response.status)
      }
      // Reading the body can fail after fetch has already received headers.
      // Await it here so those failures use the same safe retry path.
      return await response.json() as T
    } catch (reason) {
      if (!isAmbiguousNetworkFailure(reason) || attempt >= networkRetries) throw reason
      const delay = networkRetryDelaysMs[Math.min(attempt, networkRetryDelaysMs.length - 1)]
      attempt += 1
      await wait(delay)
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
  const text = value.replace(
    /\[\[CODEX_REMOTE_PDF_BEGIN id=([A-Za-z0-9_-]{24,64}) name=([^\]\r\n]+)\]\][\s\S]*?\[\[CODEX_REMOTE_PDF_END id=\1\]\]/g,
    (_block, sourceFileId: string, encodedName: string) => {
      let name = encodedName
      try {
        name = decodeURIComponent(encodedName)
      } catch {
        // Keep a readable fallback if an old or malformed history has an invalid filename marker.
      }
      documents.push({ name, content: '', sourceFileId })
      return ''
    },
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
    if (image.type !== 'localImage' || typeof image.data !== 'string' || image.data.length === 0) return []
    const mediaType = typeof image.mediaType === 'string'
      ? image.mediaType
      : typeof image.media_type === 'string' ? image.media_type : 'image/png'
    if (!mediaType.startsWith('image/')) return []
    const name = typeof image.name === 'string' && image.name.length > 0 ? image.name : `image-${index + 1}`
    return [{ name, previewUrl: `data:${mediaType};base64,${image.data}` }]
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

  const sentAt = parsedTimestamp(item.createdAt ?? item.timestamp ?? item.created_at) ?? new Date().toISOString()
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
  if (typeof value === 'number') {
    const normalized = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(normalized)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
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
    const turnStartedAt = parsedTimestamp(turn.startedAt)
    const turnCompletedAt = parsedTimestamp(turn.completedAt)
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
      const itemCreatedAt = parsedTimestamp(item.createdAt ?? item.timestamp ?? item.created_at)
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
        createdAt: itemCreatedAt ?? replyStartedAt ?? turnStartedAt ?? timestamp(turn.startedAt),
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

export const codexRemoteClient = {
  pair(code: string) {
    return request<{ token: string }>('pairing', '/api/v1/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
  },
  unpair(token: string) {
    return request<{ unpaired: boolean }>(token, '/api/v1/unpair', { method: 'POST' })
  },
  status(token: string) {
    return request<CodexRuntime>(token, '/api/v1/codex/status')
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
  saveWorkspaceFile(token: string, cwd: string | undefined, path: string, content: string, revision: string) {
    return request<CodexWorkspaceFile>(token, '/api/v1/codex/workspace/file', {
      method: 'POST',
      body: JSON.stringify({ cwd, path, content, revision }),
    })
  },
  threads(token: string) {
    return request<CodexThread[]>(token, '/api/v1/codex/threads').then((threads) =>
      uniqueThreads(threads).sort((left, right) => threadUpdatedAt(right) - threadUpdatedAt(left)),
    )
  },
  readThread(token: string, threadId: string) {
    return request<CodexThreadDetails>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}`)
  },
  renameThread(token: string, threadId: string, name: string) {
    return request<{ thread_id: string; name: string }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/name`, {
      method: 'POST',
      body: JSON.stringify({ name }),
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
  createThread(token: string, model: string | undefined, approvalPolicy: CodexApprovalPolicy | undefined, requestId: string) {
    return request<CodexThread>(token, '/api/v1/codex/threads', {
      method: 'POST',
      body: JSON.stringify({ model, approval_policy: approvalPolicy, request_id: requestId }),
    }, { networkRetries: 3 })
  },
  uploadPdfAttachment(token: string, file: File) {
    const query = new URLSearchParams({ name: file.name })
    return request<{ attachment_id: string; name: string; size: number }>(token, `/api/v1/codex/pdf-attachments?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
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
    requestId: string
  }) {
    return request<{ turn_id: string | null }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        approval_policy: input.approvalPolicy,
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
    return request<{ interrupted: boolean }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ turn_id: turnId }),
    })
  },
  connect(token: string, onEvent: (event: RemoteEvent) => void, onState: (state: 'connecting' | 'connected' | 'disconnected' | 'unavailable') => void) {
    const url = new URL('/api/v1/codex/ws', window.location.origin)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    onState('connecting')
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'codex.client.hello', protocol_version: 1, token }))
    })
    socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(String(message.data)) as RemoteEvent
        if (!event.type) return
        if (event.type === 'connection') {
          onState(event.connected ? 'connected' : event.available ? 'disconnected' : 'unavailable')
        }
        onEvent(event)
      } catch {
        onState('unavailable')
      }
    })
    socket.addEventListener('error', () => onState('unavailable'))
    socket.addEventListener('close', () => onState('disconnected'))
    return {
      respondToApproval(requestId: string | number, decision: 'accept' | 'decline' | 'cancel') {
        if (socket.readyState !== WebSocket.OPEN) return false
        socket.send(JSON.stringify({ type: 'approval.response', request_id: requestId, decision }))
        return true
      },
      close: () => socket.close(),
    }
  },
}
