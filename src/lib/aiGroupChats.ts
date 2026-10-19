export type AIGroupEngine = 'codex' | 'claude-code'

export interface AIGroupMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  engine?: AIGroupEngine
  text: string
  createdAt: string
  streaming?: boolean
}

export interface AIGroupChat {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  codexThreadId: string | null
  claudeThreadId: string | null
  codexName: string
  claudeName: string
  messages: AIGroupMessage[]
  relayUsedForUserMessageId: string | null
}

const storageKey = 'codex-remote.ai-group-chats.v2'
const legacyStorageKey = 'codex-remote.ai-group-chat.v1'
const maxStoredGroups = 24
const maxStoredMessagesPerGroup = 160
const maxStoredCharacters = 700_000

function isEngine(value: unknown): value is AIGroupEngine {
  return value === 'codex' || value === 'claude-code'
}

function readMessages(value: unknown): AIGroupMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): AIGroupMessage[] => {
    if (!item || typeof item !== 'object') return []
    const message = item as Record<string, unknown>
    if (typeof message.id !== 'string' || typeof message.text !== 'string') return []
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') return []
    if (message.engine !== undefined && !isEngine(message.engine)) return []
    return [{
      id: message.id,
      role: message.role,
      ...(isEngine(message.engine) ? { engine: message.engine } : {}),
      text: message.text,
      createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
      ...(message.streaming === true ? { streaming: true } : {}),
    }]
  }).slice(-maxStoredMessagesPerGroup)
}

function readGroup(value: unknown): AIGroupChat | null {
  if (!value || typeof value !== 'object') return null
  const group = value as Record<string, unknown>
  if (typeof group.id !== 'string' || !group.id.trim()) return null
  const createdAt = typeof group.createdAt === 'string' ? group.createdAt : new Date().toISOString()
  return {
    id: group.id,
    name: typeof group.name === 'string' && group.name.trim() ? group.name.trim().slice(0, 48) : 'AI 群聊',
    createdAt,
    updatedAt: typeof group.updatedAt === 'string' ? group.updatedAt : createdAt,
    codexThreadId: typeof group.codexThreadId === 'string' && group.codexThreadId ? group.codexThreadId : null,
    claudeThreadId: typeof group.claudeThreadId === 'string' && group.claudeThreadId ? group.claudeThreadId : null,
    codexName: typeof group.codexName === 'string' && group.codexName.trim() ? group.codexName.trim().slice(0, 40) : 'Codex',
    claudeName: typeof group.claudeName === 'string' && group.claudeName.trim() ? group.claudeName.trim().slice(0, 40) : 'Claude',
    messages: readMessages(group.messages),
    relayUsedForUserMessageId: typeof group.relayUsedForUserMessageId === 'string' ? group.relayUsedForUserMessageId : null,
  }
}

function legacyGroup(): AIGroupChat | null {
  try {
    const raw = window.localStorage.getItem(legacyStorageKey)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.version !== 1 || !Array.isArray(value.messages)) return null
    const group = readGroup({
      id: 'legacy-ai-group-chat',
      name: 'AI 群聊',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      codexThreadId: value.codexThreadId,
      claudeThreadId: value.claudeThreadId,
      codexName: 'Codex',
      claudeName: 'Claude',
      messages: value.messages,
      relayUsedForUserMessageId: value.relayUsedForUserMessageId,
    })
    return group && (group.codexThreadId || group.claudeThreadId || group.messages.length > 0) ? group : null
  } catch {
    return null
  }
}

export function readAIGroupChats(): AIGroupChat[] {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.version === 2 && Array.isArray(parsed.groups)) {
        return parsed.groups.map(readGroup).filter((group): group is AIGroupChat => group !== null).slice(0, maxStoredGroups)
      }
    }
    const migrated = legacyGroup()
    if (!migrated) return []
    persistAIGroupChats([migrated])
    return [migrated]
  } catch {
    return []
  }
}

export function persistAIGroupChats(groups: AIGroupChat[]) {
  let remainingCharacters = maxStoredCharacters
  const bounded = groups.slice(0, maxStoredGroups).map((group) => {
    const messages = group.messages.slice(-maxStoredMessagesPerGroup).reverse().flatMap((message) => {
      if (remainingCharacters <= 0) return []
      const text = message.text.slice(-remainingCharacters)
      remainingCharacters -= text.length
      return [{ ...message, text }]
    }).reverse()
    return { ...group, messages }
  })
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 2, groups: bounded }))
  } catch {
    // The original Codex and Claude Code conversations remain on the server.
  }
}
