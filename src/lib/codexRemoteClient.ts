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
}

export interface CodexMessageDocument extends CodexDocumentAttachment {
  charCount: number
}

export interface CodexMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  images?: CodexMessageImage[]
  documents?: CodexMessageDocument[]
  streaming?: boolean
}

export interface CodexImageAttachment {
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
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
  error: string | null
}

export interface RemoteEvent {
  type: string
  method?: string
  params?: Record<string, unknown>
  connected?: boolean
  available?: boolean
  workspace?: string
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

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
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
  return response.json() as Promise<T>
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

function timestamp(value: unknown) {
  if (typeof value === 'number') {
    const normalized = value > 10_000_000_000 ? value : value * 1000
    return new Date(normalized).toISOString()
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

export function messagesFromThread(thread: CodexThreadDetails): CodexMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const messages: CodexMessage[] = []
  for (const turnValue of turns) {
    if (!turnValue || typeof turnValue !== 'object') continue
    const turn = turnValue as Record<string, unknown>
    if (!Array.isArray(turn.items)) continue
    for (const itemValue of turn.items) {
      if (!itemValue || typeof itemValue !== 'object') continue
      const item = itemValue as Record<string, unknown>
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') continue
      const text = item.type === 'userMessage' ? plainText(item.content) : plainText(item.text)
      const images = item.type === 'userMessage' ? imagesFromContent(item.content) : []
      if (!text && images.length === 0) continue
      messages.push({
        id: typeof item.id === 'string' ? item.id : `${String(turn.id ?? 'turn')}-${messages.length}`,
        role: item.type === 'userMessage' ? 'user' : 'assistant',
        text,
        createdAt: timestamp(turn.startedAt),
        ...(images.length > 0 ? { images } : {}),
      })
    }
  }
  return messages
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
  threads(token: string) {
    return request<CodexThread[]>(token, '/api/v1/codex/threads').then((threads) =>
      uniqueThreads(threads).sort((left, right) => threadUpdatedAt(right) - threadUpdatedAt(left)),
    )
  },
  readThread(token: string, threadId: string) {
    return request<CodexThreadDetails>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}`)
  },
  resumeThread(token: string, threadId: string) {
    return request<CodexThreadDetails>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: 'POST' })
  },
  models(token: string) {
    return request<CodexModel[]>(token, '/api/v1/codex/models')
  },
  createThread(token: string, model?: string) {
    return request<CodexThread>(token, '/api/v1/codex/threads', {
      method: 'POST',
      body: JSON.stringify({ model }),
    })
  },
  startTurn(token: string, threadId: string, input: { prompt: string; images: CodexImageAttachment[]; model?: string; effort?: string }) {
    return request<{ turn_id: string | null }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        images: input.images.map((image) => ({
          name: image.name,
          media_type: image.mediaType,
          data: image.data,
        })),
      }),
    })
  },
  interrupt(token: string, threadId: string) {
    return request<{ interrupted: boolean }>(token, `/api/v1/codex/threads/${encodeURIComponent(threadId)}/interrupt`, { method: 'POST' })
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
