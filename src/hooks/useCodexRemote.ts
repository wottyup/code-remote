import { useCallback, useEffect, useRef, useState } from 'react'
import {
  codexRemoteClient,
  messagesFromThread,
  RemoteApiError,
  type CodexMessage,
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

const emptyRuntime: CodexRuntime = { available: false, connected: false, workspace: '', error: null }
const activeWriterError = '这条对话正被另一个 Codex 实例使用。可查看历史，待原实例结束后再发送。'

function isActiveWriterError(reason: unknown) {
  return reason instanceof Error && /active writer/i.test(reason.message)
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

export function useCodexRemote(token: string, onUnauthorized: () => void) {
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected' | 'unavailable'>('connecting')
  const [runtime, setRuntime] = useState(emptyRuntime)
  const [threads, setThreads] = useState<CodexThread[]>([])
  const [activeThread, setActiveThread] = useState<CodexThread | null>(null)
  const [messages, setMessages] = useState<CodexMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [activity, setActivity] = useState<CodexActivity | null>(null)
  const [writerConflict, setWriterConflict] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const socketRef = useRef<ReturnType<typeof codexRemoteClient.connect> | null>(null)
  const activeThreadId = useRef<string | null>(null)
  const resumedThreadId = useRef<string | null>(null)
  const loadRequest = useRef(0)
  const activityItemId = useRef<string | null>(null)
  const writerConflictRef = useRef(false)
  const writerRefreshTimer = useRef<number | undefined>(undefined)

  const refreshThreads = useCallback(async () => {
    try {
      const next = await codexRemoteClient.threads(token)
      setThreads(next)
      return next
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '无法读取对话记录')
      return null
    }
  }, [onUnauthorized, token])

  const loadThread = useCallback(async (threadId: string) => {
    try {
      const thread = await codexRemoteClient.readThread(token, threadId)
      if (activeThreadId.current !== threadId) return
      setActiveThread(thread)
      setMessages(messagesFromThread(thread))
      const turns = Array.isArray(thread.turns) ? thread.turns : []
      const latest = turns.at(-1) as Record<string, unknown> | undefined
      const running = latest?.status === 'inProgress' || latest?.status === 'running'
      setIsRunning(running)
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
        setActivity(running ? { label: '正在思考' } : null)
      }
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (isActiveWriterError(reason)) {
        writerConflictRef.current = true
        setWriterConflict(true)
        setIsRunning(true)
        setActivity({ label: '此对话已有其他 Codex 实例在运行' })
        setError(activeWriterError)
      } else {
        setError(reason instanceof Error ? reason.message : '无法读取对话内容')
      }
      return false
    }
  }, [onUnauthorized, token])

  const handleEvent = useCallback((event: RemoteEvent) => {
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
      setRuntime({
        available: Boolean(event.available),
        connected: Boolean(event.connected),
        workspace: event.workspace ?? '',
        error: event.error ?? null,
      })
      if (event.error) setError(event.error)
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
    const eventThreadId = typeof params.threadId === 'string' ? params.threadId : null
    if (eventThreadId && eventThreadId !== activeThreadId.current) return

    if (event.method === 'turn/started') {
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(true)
      setActivity({ label: '正在思考' })
      activityItemId.current = null
      return
    }
    if (event.method === 'turn/completed') {
      writerConflictRef.current = false
      setWriterConflict(false)
      setError((current) => current === activeWriterError ? null : current)
      setIsRunning(false)
      setActivity(null)
      activityItemId.current = null
      if (activeThreadId.current) {
        void refreshThreads()
        void loadThread(activeThreadId.current)
      }
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
      activityItemId.current = typeof item?.id === 'string' ? item.id : null
      setIsRunning(true)
      setActivity(activityForItem(item))
      return
    }
    if (event.method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `stream-${Date.now()}`
      const delta = typeof params.delta === 'string' ? params.delta : ''
      activityItemId.current = itemId
      setActivity({ label: '正在回复' })
      setMessages((current) => {
        const exists = current.some((message) => message.id === itemId)
        if (exists) {
          return current.map((message) => message.id === itemId
            ? { ...message, text: message.text + delta, streaming: true }
            : message)
        }
        return [...current, { id: itemId, role: 'assistant', text: delta, createdAt: new Date().toISOString(), streaming: true }]
      })
      return
    }
    if (event.method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined
      const itemId = typeof item?.id === 'string' ? item.id : null
      if (item?.type !== 'agentMessage') {
        if (itemId && activityItemId.current === itemId) {
          activityItemId.current = null
          setActivity({ label: '正在思考' })
        }
        return
      }
      const text = typeof item.text === 'string' ? item.text : ''
      if (!itemId) return
      setMessages((current) => {
        const exists = current.some((message) => message.id === itemId)
        if (!exists && !text) return current
        if (!exists) return [...current, { id: itemId, role: 'assistant', text, createdAt: new Date().toISOString() }]
        return current.map((message) => message.id === itemId ? { ...message, text: text || message.text, streaming: false } : message)
      })
      return
    }
    if (event.method === 'thread/name/updated') void refreshThreads()
  }, [loadThread, refreshThreads])

  useEffect(() => {
    let disposed = false
    let retryTimer: number | undefined
    let retryDelay = 500
    let socketGeneration = 0

    const connect = () => {
      if (disposed) return
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
        setConnection(nextState)
        if (nextState !== 'connected') resumedThreadId.current = null
        if (nextState === 'connected') {
          retryDelay = 500
          void refreshThreads()
          if (activeThreadId.current) void loadThread(activeThreadId.current)
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

    void (async () => {
      try {
        const nextRuntime = await codexRemoteClient.status(token)
        if (disposed) return
        setRuntime(nextRuntime)
        connect()
        await refreshThreads()
        if (disposed) return
      } catch (reason) {
        if (disposed) return
        if (reason instanceof RemoteApiError && reason.status === 401) {
          onUnauthorized()
          return
        }
        setError(reason instanceof Error ? reason.message : '无法连接本机服务')
        setConnection('unavailable')
        connect()
        setLoadingHistory(false)
      }
    })()

    return () => {
      disposed = true
      socketGeneration += 1
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (writerRefreshTimer.current !== undefined) window.clearTimeout(writerRefreshTimer.current)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [handleEvent, loadThread, onUnauthorized, refreshThreads, token])

  const selectThread = useCallback(async (thread: CodexThread) => {
    const requestId = ++loadRequest.current
    activeThreadId.current = thread.id
    resumedThreadId.current = null
    setActiveThread(thread)
    setMessages([])
    setIsRunning(false)
    setActivity(null)
    writerConflictRef.current = false
    setWriterConflict(false)
    activityItemId.current = null
    setApproval(null)
    setLoadingHistory(true)
    try {
      const loaded = await loadThread(thread.id)
      if (requestId !== loadRequest.current) return
      if (loaded) setError(null)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (requestId === loadRequest.current) setError(reason instanceof Error ? reason.message : '恢复对话失败')
    } finally {
      if (requestId === loadRequest.current) setLoadingHistory(false)
    }
  }, [loadThread, onUnauthorized])

  const createThread = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const thread = await codexRemoteClient.createThread(token)
      activeThreadId.current = thread.id
      resumedThreadId.current = thread.id
      setActiveThread(thread)
      setMessages([])
      setIsRunning(false)
      setActivity(null)
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
  }, [onUnauthorized, token])

  const sendMessage = useCallback(async (prompt: string) => {
    if (loadingHistory) return false
    let thread = activeThread
    if (!thread) thread = await createThread()
    if (!thread) return false
    const text = prompt.trim()
    if (!text) return false
    const localId = `local-${Date.now()}`
    setMessages((current) => [...current, { id: localId, role: 'user', text, createdAt: new Date().toISOString() }])
    setIsRunning(true)
    setActivity({ label: '正在思考' })
    writerConflictRef.current = false
    setWriterConflict(false)
    setError(null)
    try {
      if (resumedThreadId.current !== thread.id) {
        await codexRemoteClient.resumeThread(token, thread.id)
        resumedThreadId.current = thread.id
      }
      try {
        await codexRemoteClient.startTurn(token, thread.id, text)
      } catch (reason) {
        if (!(reason instanceof Error) || !/thread not found/i.test(reason.message)) throw reason
        resumedThreadId.current = null
        await codexRemoteClient.resumeThread(token, thread.id)
        resumedThreadId.current = thread.id
        await codexRemoteClient.startTurn(token, thread.id, text)
      }
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setMessages((current) => current.filter((message) => message.id !== localId))
      setIsRunning(false)
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
  }, [activeThread, createThread, loadingHistory, onUnauthorized, token])

  const interrupt = useCallback(async () => {
    if (!activeThread) return
    try {
      await codexRemoteClient.interrupt(token, activeThread.id)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '停止 Codex 任务失败')
    }
  }, [activeThread, onUnauthorized, token])

  const respondToApproval = useCallback((decision: 'accept' | 'decline' | 'cancel') => {
    if (!approval) return false
    const sent = socketRef.current?.respondToApproval(approval.requestId, decision) ?? false
    if (sent) setApproval(null)
    else setError('连接断开，审批没有送达')
    return sent
  }, [approval])

  const refreshActiveThread = useCallback(() => {
    if (activeThreadId.current) void loadThread(activeThreadId.current)
  }, [loadThread])

  return {
    connection,
    runtime,
    threads,
    activeThread,
    messages,
    isRunning,
    activity,
    writerConflict,
    loadingHistory,
    error,
    approval,
    refreshThreads,
    selectThread,
    createThread,
    sendMessage,
    interrupt,
    respondToApproval,
    refreshActiveThread,
  }
}
