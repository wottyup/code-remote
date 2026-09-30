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

const emptyRuntime: CodexRuntime = { available: false, connected: false, workspace: '', error: null }

export function useCodexRemote(token: string, onUnauthorized: () => void) {
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected' | 'unavailable'>('connecting')
  const [runtime, setRuntime] = useState(emptyRuntime)
  const [threads, setThreads] = useState<CodexThread[]>([])
  const [activeThread, setActiveThread] = useState<CodexThread | null>(null)
  const [messages, setMessages] = useState<CodexMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const socketRef = useRef<ReturnType<typeof codexRemoteClient.connect> | null>(null)
  const activeThreadId = useRef<string | null>(null)
  const loadRequest = useRef(0)

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
      setIsRunning(latest?.status === 'inProgress' || latest?.status === 'running')
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setError(reason instanceof Error ? reason.message : '无法读取对话内容')
    }
  }, [onUnauthorized, token])

  const handleEvent = useCallback((event: RemoteEvent) => {
    if (event.type === 'connection') {
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
      setIsRunning(true)
      return
    }
    if (event.method === 'turn/completed') {
      setIsRunning(false)
      if (activeThreadId.current) {
        void refreshThreads()
        void loadThread(activeThreadId.current)
      }
      return
    }
    if (event.method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `stream-${Date.now()}`
      const delta = typeof params.delta === 'string' ? params.delta : ''
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
      if (item?.type !== 'agentMessage') return
      const itemId = typeof item.id === 'string' ? item.id : null
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
        if (nextState === 'connected') {
          retryDelay = 500
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
        const nextThreads = await refreshThreads()
        if (disposed || !nextThreads) return
        if (nextThreads.length > 0 && !activeThreadId.current) {
          const latest = nextThreads[0]
          activeThreadId.current = latest.id
          setActiveThread(latest)
          setLoadingHistory(true)
          await codexRemoteClient.resumeThread(token, latest.id)
          await loadThread(latest.id)
          if (!disposed) setLoadingHistory(false)
        }
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
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [handleEvent, loadThread, onUnauthorized, refreshThreads, token])

  const selectThread = useCallback(async (thread: CodexThread) => {
    const requestId = ++loadRequest.current
    activeThreadId.current = thread.id
    setActiveThread(thread)
    setMessages([])
    setIsRunning(false)
    setApproval(null)
    setLoadingHistory(true)
    try {
      await codexRemoteClient.resumeThread(token, thread.id)
      const data = await codexRemoteClient.readThread(token, thread.id)
      if (requestId !== loadRequest.current) return
      setActiveThread(data)
      setMessages(messagesFromThread(data))
      const turns = Array.isArray(data.turns) ? data.turns : []
      const latest = turns.at(-1) as Record<string, unknown> | undefined
      setIsRunning(latest?.status === 'inProgress' || latest?.status === 'running')
      setError(null)
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      if (requestId === loadRequest.current) setError(reason instanceof Error ? reason.message : '恢复对话失败')
    } finally {
      if (requestId === loadRequest.current) setLoadingHistory(false)
    }
  }, [onUnauthorized, token])

  const createThread = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const thread = await codexRemoteClient.createThread(token)
      activeThreadId.current = thread.id
      setActiveThread(thread)
      setMessages([])
      setIsRunning(false)
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
    let thread = activeThread
    if (!thread) thread = await createThread()
    if (!thread) return false
    const text = prompt.trim()
    if (!text) return false
    const localId = `local-${Date.now()}`
    setMessages((current) => [...current, { id: localId, role: 'user', text, createdAt: new Date().toISOString() }])
    setIsRunning(true)
    setError(null)
    try {
      await codexRemoteClient.startTurn(token, thread.id, text)
      return true
    } catch (reason) {
      if (reason instanceof RemoteApiError && reason.status === 401) onUnauthorized()
      setMessages((current) => current.filter((message) => message.id !== localId))
      setIsRunning(false)
      setError(reason instanceof Error ? reason.message : '发送消息失败')
      return false
    }
  }, [activeThread, createThread, onUnauthorized, token])

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

  return {
    connection,
    runtime,
    threads,
    activeThread,
    messages,
    isRunning,
    loadingHistory,
    error,
    approval,
    refreshThreads,
    selectThread,
    createThread,
    sendMessage,
    interrupt,
    respondToApproval,
  }
}
