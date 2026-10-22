import { useEffect, useRef, useState, type FormEvent } from 'react'
import { codexRemoteClient, type CodexApprovalPolicy, type DeviceChatMessage, type DeviceChatState } from '../lib/codexRemoteClient'

function defaultDeviceName() {
  const agent = navigator.userAgent.toLowerCase()
  if (agent.includes('windows')) return 'Windows'
  if (agent.includes('linux')) return 'Linux'
  if (agent.includes('mac')) return 'Mac'
  return '本机 Codex'
}

function messageOrder(left: DeviceChatMessage, right: DeviceChatMessage) {
  if (left.sequence < 0) return right.sequence < 0 ? 0 : 1
  if (right.sequence < 0) return -1
  return left.sequence - right.sequence
}

export function useDeviceChat(token: string, enabled: boolean) {
  const [state, setState] = useState<DeviceChatState | null>(null)
  const [loading, setLoading] = useState(true)
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [hostUrl, setHostUrl] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [targetId, setTargetId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [approvalPolicy, setApprovalPolicy] = useState<CodexApprovalPolicy>('on-request')
  const [approval, setApproval] = useState<{ requestId: string | number; params: Record<string, unknown> } | null>(null)
  const approvalSocket = useRef<ReturnType<typeof codexRemoteClient.connect> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const lastCursor = useRef<number | undefined>(undefined)
  const lastSequence = useRef<number | undefined>(undefined)

  const mergeState = (next: DeviceChatState) => {
    setState((current) => {
      if (!current?.room || !next.room || current.room.id !== next.room.id) {
        lastCursor.current = Math.max(0, ...next.messages.map((message) => message.cursor ?? message.sequence))
        lastSequence.current = Math.max(0, ...next.messages.map((message) => message.sequence))
        return next
      }
      const messages = new Map(current.messages.map((message) => [message.id, message]))
      for (const message of next.messages) {
        const previous = messages.get(message.id)
        if (!previous || (message.cursor ?? message.sequence) >= (previous.cursor ?? previous.sequence)) {
          messages.set(message.id, message)
        }
      }
      const ordered = [...messages.values()].sort(messageOrder).slice(-500)
      lastCursor.current = Math.max(lastCursor.current ?? 0, ...next.messages.map((message) => message.cursor ?? message.sequence))
      lastSequence.current = Math.max(lastSequence.current ?? 0, ...next.messages.map((message) => message.sequence))
      return { ...next, messages: ordered }
    })
  }

  const refresh = async (showError = false) => {
    try {
      const next = await codexRemoteClient.deviceChatState(token, lastCursor.current, lastSequence.current)
      mergeState(next)
    } catch (reason) {
      if (showError) setError(reason instanceof Error ? reason.message : '无法读取设备群聊状态。')
    } finally {
      if (showError) setLoading(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    void refresh(true)
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => {
      window.clearInterval(timer)
    }
  }, [token, enabled])

  useEffect(() => {
    const threadId = enabled ? state?.agent_thread_id : null
    setApproval(null)
    if (!threadId) return
    let disposed = false
    let retryTimer: number | undefined
    const connect = () => {
      if (disposed) return
      approvalSocket.current = codexRemoteClient.connect(token, (event) => {
        if (event.type === 'server_request.resolved') {
          setApproval((current) => current?.requestId === event.request_id ? null : current)
          return
        }
        if (event.type !== 'server_request' || event.params?.threadId !== threadId) return
        const supported = new Set([
          'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
          'execCommandApproval', 'applyPatchApproval',
        ])
        if (supported.has(event.method ?? '') && (typeof event.request_id === 'string' || typeof event.request_id === 'number')) {
          setApproval({ requestId: event.request_id, params: event.params ?? {} })
        }
      }, (connection) => {
        if (disposed || (connection !== 'disconnected' && connection !== 'unavailable')) return
        if (retryTimer !== undefined) window.clearTimeout(retryTimer)
        retryTimer = window.setTimeout(connect, 1200)
      }, threadId)
    }
    connect()
    return () => {
      disposed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      approvalSocket.current?.close()
      approvalSocket.current = null
    }
  }, [enabled, state?.agent_thread_id, token])

  function respondToApproval(decision: 'accept' | 'decline') {
    if (!approval) return false
    const sent = approvalSocket.current?.respondToApproval(approval.requestId, decision) ?? false
    if (sent) setApproval(null)
    else setError('群聊审批未送达，请检查本机连接。')
    return sent
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await codexRemoteClient.createDeviceChat(token, deviceName)
      mergeState(result.state)
      setInviteCode(result.invite_code)
      setCopied(null)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建房间失败。')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function createInvite() {
    setBusy(true)
    setError(null)
    try {
      const result = await codexRemoteClient.inviteDeviceChat(token, deviceName)
      mergeState(result.state)
      setInviteCode(result.invite_code)
      setCopied(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成加入码失败。')
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const next = await codexRemoteClient.joinDeviceChat(token, hostUrl, joinCode, deviceName)
      lastCursor.current = undefined
      lastSequence.current = undefined
      mergeState(next)
      setInviteCode('')
      setJoinCode('')
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加入房间失败。')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage(text: string): Promise<boolean> {
    if (!state?.room || !text.trim() || busy) return false
    setBusy(true)
    setError(null)
    try {
      const sent = await codexRemoteClient.sendDeviceChatMessage(token, text.trim(), targetId || null, model, effort,
        targetId === state.node_id ? approvalPolicy : undefined)
      setState((current) => current ? {
        ...current,
        messages: [...current.messages.filter((message) => message.id !== sent.id), sent].sort(messageOrder).slice(-500),
      } : current)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发送群聊消息失败。')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function leaveRoom() {
    const isHost = state?.role === 'host'
    const message = isHost ? '退出会解散房间，并断开所有设备。确定继续吗？' : '确定退出这个设备群聊吗？'
    if (!window.confirm(message)) return
    setBusy(true)
    setError(null)
    try {
      await codexRemoteClient.leaveDeviceChat(token)
      lastCursor.current = undefined
      lastSequence.current = undefined
      setState((current) => current ? { ...current, room: null, role: undefined, members: [], messages: [], connected: false } : current)
      setInviteCode('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '退出房间失败。')
    } finally {
      setBusy(false)
    }
  }

  async function selectLocalThread(threadId: string | null) {
    setBusy(true)
    setError(null)
    try {
      const next = await codexRemoteClient.selectDeviceChatThread(token, threadId)
      mergeState(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '选择本机 Codex 聊天失败。')
    } finally {
      setBusy(false)
    }
  }

  async function bindWorkspace(cwd: string): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      mergeState(await codexRemoteClient.bindDeviceChatWorkspace(token, cwd))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '绑定群聊工作目录失败。')
      throw reason
    } finally {
      setBusy(false)
    }
  }

  async function copyValue(value: string, label: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const input = document.createElement('textarea')
        input.value = value
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.append(input)
        input.select()
        const copiedValue = document.execCommand('copy')
        input.remove()
        if (!copiedValue) throw new Error('clipboard unavailable')
      }
      setCopied(label)
      window.setTimeout(() => setCopied((current) => current === label ? null : current), 1800)
    } catch {
      setError('复制失败，请手动选择并复制。')
    }
  }

  return { state, loading, deviceName, setDeviceName, hostUrl, setHostUrl, inviteCode, joinCode, setJoinCode, targetId, setTargetId, model, setModel, effort, setEffort, approvalPolicy, setApprovalPolicy, approval, respondToApproval, busy, error, setError, copied, createRoom, createInvite, joinRoom, sendMessage, selectLocalThread, bindWorkspace, leaveRoom, copyValue }
}

export type DeviceChatController = ReturnType<typeof useDeviceChat>
