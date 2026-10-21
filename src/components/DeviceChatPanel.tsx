import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, LoaderCircle, MessageSquare, Plus, Send, Users, X } from 'lucide-react'
import { codexRemoteClient, type DeviceChatMessage, type DeviceChatState } from '../lib/codexRemoteClient'
import './DeviceChatPanel.css'

interface Props {
  token: string
  onClose: () => void
}

function defaultDeviceName() {
  const agent = navigator.userAgent.toLowerCase()
  if (agent.includes('windows')) return 'Windows'
  if (agent.includes('linux')) return 'Linux'
  if (agent.includes('mac')) return 'Mac'
  return '本机 Codex'
}

function messageTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function messageOrder(left: DeviceChatMessage, right: DeviceChatMessage) {
  if (left.sequence < 0) return right.sequence < 0 ? 0 : 1
  if (right.sequence < 0) return -1
  return left.sequence - right.sequence
}

export function DeviceChatPanel({ token, onClose }: Props) {
  const [state, setState] = useState<DeviceChatState | null>(null)
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [hostUrl, setHostUrl] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [targetId, setTargetId] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const lastSequence = useRef<number | undefined>(undefined)
  const lastMessageText = state?.messages.at(-1)?.text

  const mergeState = (next: DeviceChatState) => {
    setState((current) => {
      if (!current?.room || !next.room || current.room.id !== next.room.id) {
        lastSequence.current = Math.max(0, ...next.messages.map((message) => message.sequence))
        return next
      }
      const messages = new Map(current.messages.map((message) => [message.id, message]))
      for (const message of next.messages) messages.set(message.id, message)
      const ordered = [...messages.values()].sort(messageOrder).slice(-500)
      lastSequence.current = Math.max(lastSequence.current ?? 0, ...next.messages.map((message) => message.sequence))
      return { ...next, messages: ordered }
    })
  }

  const refresh = async (showError = false) => {
    try {
      const next = await codexRemoteClient.deviceChatState(token, lastSequence.current)
      mergeState(next)
    } catch (reason) {
      if (showError) setError(reason instanceof Error ? reason.message : '无法读取设备群聊状态。')
    }
  }

  useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => void refresh(), 1200)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [token, onClose])

  useLayoutEffect(() => {
    const container = messagesRef.current
    if (container && stickToBottom.current) container.scrollTop = container.scrollHeight
  }, [state?.messages.length, lastMessageText])

  async function createRoom(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await codexRemoteClient.createDeviceChat(token, deviceName)
      mergeState(result.state)
      setInviteCode(result.invite_code)
      setCopied(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建房间失败。')
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
      lastSequence.current = undefined
      mergeState(next)
      setInviteCode('')
      setJoinCode('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加入房间失败。')
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const sent = await codexRemoteClient.sendDeviceChatMessage(token, text, targetId || null)
      setState((current) => current ? {
        ...current,
        messages: [...current.messages.filter((message) => message.id !== sent.id), sent].sort(messageOrder).slice(-500),
      } : current)
      setDraft('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发送群聊消息失败。')
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
      lastSequence.current = undefined
      setState((current) => current ? { ...current, room: null, role: undefined, members: [], messages: [], connected: false } : current)
      setInviteCode('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '退出房间失败。')
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

  const currentMember = state?.members.find((member) => member.id === state.node_id)
  const hostAddress = window.location.origin

  return (
    <div className="device-chat-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="device-chat-panel" role="dialog" aria-modal="true" aria-labelledby="device-chat-title">
        <header className="device-chat-panel__header">
          <div className="device-chat-panel__title-icon"><Users size={19} /></div>
          <div className="device-chat-panel__title-copy">
            <h2 id="device-chat-title">设备群聊</h2>
            <p>{state?.room ? state.room.name : '把多台设备上的 Codex 放进同一个可见消息流'}</p>
          </div>
          {state?.room ? <span className={'device-chat-connection' + (state.connected ? ' device-chat-connection--online' : '')}><i />{state.role === 'host' ? '房间设备在线' : state.connected ? '已连接' : '重连中'}</span> : null}
          <button className="device-chat-panel__close" type="button" aria-label="关闭设备群聊" onClick={onClose}><X size={19} /></button>
        </header>

        {error ? <div className="device-chat-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={14} /></button></div> : null}

        {!state?.room ? (
          <div className="device-chat-setup">
            <label className="device-chat-field">
              <span>本机在群聊中的名称</span>
              <input value={deviceName} onChange={(event) => setDeviceName(event.currentTarget.value)} maxLength={40} autoComplete="off" />
            </label>
            <div className="device-chat-setup__columns">
              <form className="device-chat-card" onSubmit={(event) => void createRoom(event)}>
                <div className="device-chat-card__icon"><Plus size={17} /></div>
                <h3>创建房间</h3>
                <p>本机保存群聊记录并协调设备连接。创建后把网页地址和一次性加入码填到另一台设备。</p>
                <button className="device-chat-primary" type="submit" disabled={busy || !deviceName.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : null}创建并生成加入码</button>
              </form>
              <form className="device-chat-card" onSubmit={(event) => void joinRoom(event)}>
                <div className="device-chat-card__icon"><MessageSquare size={17} /></div>
                <h3>加入房间</h3>
                <p>填写创建房间设备的网页地址与一次性加入码。两台设备需要能通过局域网互相访问。</p>
                <label className="device-chat-field"><span>房间设备网页地址</span><input type="url" value={hostUrl} onChange={(event) => setHostUrl(event.currentTarget.value)} placeholder="http://192.168.1.20:4173" required autoComplete="url" /></label>
                <label className="device-chat-field"><span>一次性加入码</span><input value={joinCode} onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase())} maxLength={24} required autoComplete="off" /></label>
                <button className="device-chat-primary" type="submit" disabled={busy || !deviceName.trim() || !hostUrl.trim() || !joinCode.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : null}加入设备群聊</button>
              </form>
            </div>
          </div>
        ) : (
          <div className="device-chat-content">
            <div className="device-chat-members">
              <div className="device-chat-members__heading"><span><Users size={15} />房间成员</span><small>{state.members.length} 台设备</small></div>
              <div className="device-chat-members__list">
                {state.members.map((member) => (
                  <span className="device-chat-member" key={member.id}>
                    <i className={member.online ? 'device-chat-member__dot device-chat-member__dot--online' : 'device-chat-member__dot'} />
                    <strong>{member.name}</strong>{member.id === state.room?.host_id ? <small>房间设备</small> : null}{member.id === state.node_id ? <small>本机</small> : null}
                  </span>
                ))}
              </div>
              {state.role === 'host' ? (
                <>
                  <div className="device-chat-invite-tools">
                    <button type="button" onClick={() => void copyValue(hostAddress, 'address')}><Copy size={14} />{copied === 'address' ? '地址已复制' : '复制本机地址'}</button>
                    <button type="button" onClick={() => void createInvite()} disabled={busy}><Plus size={14} />生成新加入码</button>
                  </div>
                  <p className="device-chat-peer-note">把这个地址填到另一台设备；若地址是 localhost，请替换为本机的局域网 IP。</p>
                </>
              ) : <p className="device-chat-peer-note">本机通过房间设备 {state.room.host_name} 同步消息。</p>}
              {inviteCode ? (
                <div className="device-chat-code">
                  <span>一次性加入码 · 5 分钟内有效</span>
                  <strong>{inviteCode}</strong>
                  <button type="button" onClick={() => void copyValue(inviteCode, 'code')}>{copied === 'code' ? '已复制' : '复制加入码'}</button>
                </div>
              ) : null}
              <button className="device-chat-leave" type="button" disabled={busy} onClick={() => void leaveRoom()}>{state.role === 'host' ? '解散房间' : '退出群聊'}</button>
            </div>

            <div className="device-chat-conversation">
              <div className="device-chat-conversation__heading"><span>共享消息</span><small>点名设备后，由那台设备上的本机 Codex 回复</small></div>
              <div className="device-chat-messages" ref={messagesRef} onScroll={(event) => {
                const node = event.currentTarget
                stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100
              }}>
                {state.messages.length === 0 ? <div className="device-chat-empty"><MessageSquare size={22} /><p>房间已准备好。选择一台设备并发送第一条消息。</p></div> : null}
                {state.messages.map((message) => <ChatMessage key={message.id} message={message} />)}
              </div>
              <form className="device-chat-composer" onSubmit={(event) => void sendMessage(event)}>
                <label className="device-chat-recipient"><span>发送给</span><select value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)}>
                  <option value="">所有人（只同步）</option>
                  {state.members.map((member) => <option key={member.id} value={member.id}>@{member.name}（运行本机 Codex）</option>)}
                </select></label>
                <textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder={targetId ? `给 ${state.members.find((member) => member.id === targetId)?.name ?? '设备'} 的消息…` : '发送群聊消息…'} maxLength={12_000} rows={3} disabled={busy} />
                <div className="device-chat-composer__footer"><span>{currentMember?.name ?? '本机'} · 最多 12000 字</span><button type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}发送</button></div>
              </form>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function ChatMessage({ message }: { message: DeviceChatMessage }) {
  if (message.kind === 'status') {
    return <div className="device-chat-status" key={`${message.id}-${message.sequence}`}><span className="device-chat-status__pulse" />{message.text}</div>
  }
  const kind = message.kind === 'error' ? 'error' : message.kind
  return (
    <article className={`device-chat-message device-chat-message--${kind}`}>
      <header><strong>{message.sender_name}</strong>{message.target_name ? <span>@{message.target_name}</span> : null}{message.delivery_state ? <span className={'device-chat-message__pending' + (message.delivery_state === 'error' ? ' device-chat-message__pending--error' : '')}>{message.delivery_state === 'pending' ? '等待发送' : message.delivery_state === 'error' ? '发送失败' : '等待同步'}</span> : null}<time>{messageTime(message.created_at)}</time></header>
      <p>{message.text}</p>
    </article>
  )
}
