import { useState } from 'react'
import { Check, ChevronRight, Copy, LoaderCircle, MessageSquare, Plus, Search, Users, X } from 'lucide-react'
import type { DeviceChatController } from '../hooks/useDeviceChat'
import type { CodexThread } from '../lib/codexRemoteClient'
import './DeviceChatSidebar.css'

function initialShareAddress() {
  const url = new URL(window.location.origin)
  return /^(localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(url.hostname) ? '' : url.origin
}

function validShareAddress(value: string) {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !/^(localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

export function DeviceChatSidebar({ chat, threads, onSelectRoom }: { chat: DeviceChatController; threads: CodexThread[]; onSelectRoom: () => void }) {
  const { state, loading, inviteCode, busy, error, setError, copied, createInvite, selectLocalThread, leaveRoom, copyValue } = chat
  const [setupAction, setSetupAction] = useState<'create' | 'join' | null>(null)
  const activeSetup = !state && loading ? null : setupAction ?? (!state?.room ? 'join' : null)
  const [threadSearch, setThreadSearch] = useState('')
  const [shareAddress, setShareAddress] = useState(initialShareAddress)
  const codexThreads = threads.filter((thread) => thread.engine !== 'claude-code')
  const matchingThreads = codexThreads.filter((thread) => (thread.name || thread.preview || '新对话').toLocaleLowerCase().includes(threadSearch.trim().toLocaleLowerCase()))
  const selectedThread = codexThreads.find((thread) => thread.id === state?.local_thread_id)
  const canShareAddress = validShareAddress(shareAddress)
  return <div className="device-chat-sidebar" aria-label="设备群聊侧栏">
    <details className="device-chat-room-module">
      <summary className="thread-list-heading device-chat-room-module__summary"><span>群聊</span><ChevronRight size={16} aria-hidden="true" /></summary>
      <div className="device-chat-room-actions" role="group" aria-label="创建或加入群聊">
        <button type="button" aria-pressed={activeSetup === 'create'} disabled={busy || (!state && loading)} onClick={() => setSetupAction('create')}><Plus size={15} />创建房间</button>
        <button type="button" aria-pressed={activeSetup === 'join'} disabled={busy || (!state && loading)} onClick={() => setSetupAction('join')}><MessageSquare size={15} />加入房间</button>
      </div>
      {state?.room ? <button className="thread-row thread-row--active device-chat-sidebar__room" type="button" aria-current="page" onClick={onSelectRoom}><span className="thread-row__icon"><Users size={16} /></span><span className="thread-row__copy"><strong>{state.room.name}</strong><span className="thread-row__meta"><small>{state.members.length} 台设备 · {state.connected || state.role === 'host' ? '已连接' : '重连中'}</small></span></span></button> : null}
      {error ? <div className="device-chat-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={14} /></button></div> : null}
      {!state && loading ? <div className="device-chat-sidebar__loading" role="status"><LoaderCircle className="spin" size={15} />正在读取群聊…</div> : null}
      {activeSetup ? <DeviceChatRoomSetup chat={chat} action={activeSetup} onClose={() => setSetupAction(null)} /> : null}
      {!activeSetup && state?.room && state.role === 'host' ? <section className="device-chat-connect" aria-label="连接另一台设备">
        <strong className="device-chat-connect__heading">连接另一台设备</strong>
        <div className="device-chat-connect__body">
        <p>在另一台电脑自己的 Code Remote 网页选择“加入房间”，填写下面的地址和设备加入码。内网穿透时填穿透域名。</p>
        <label className="device-chat-field"><span>另一台设备可访问的房间地址</span><input type="url" value={shareAddress} onChange={(event) => setShareAddress(event.currentTarget.value)} placeholder="https://你的穿透域名" autoComplete="url" /></label>
        {!canShareAddress ? <p className="device-chat-connect__warning">请填另一台设备能访问的 HTTP/HTTPS 地址；localhost 只指当前设备。</p> : null}
        <button className="device-chat-connect__copy" type="button" disabled={!canShareAddress} onClick={() => void copyValue(shareAddress.trim(), 'address')}><Copy size={14} />{copied === 'address' ? '地址已复制' : '复制房间地址'}</button>
        <div className="device-chat-connect__code"><span>设备加入码 · 一次性，5 分钟有效</span><strong>{inviteCode || '请生成加入码'}</strong></div>
        <div className="device-chat-connect__actions"><button type="button" disabled={!inviteCode} onClick={() => void copyValue(inviteCode, 'code')}><Copy size={14} />{copied === 'code' ? '加入码已复制' : '复制加入码'}</button><button type="button" disabled={busy} onClick={() => void createInvite()}><Plus size={14} />{inviteCode ? '重新生成' : '生成加入码'}</button></div>
        </div>
      </section> : null}
      {!activeSetup && state?.room ? <div className="device-chat-room-panel" aria-label="设备群聊房间管理">
      <header className="device-chat-room-panel__header"><strong>房间成员</strong></header>
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
                {state.role === 'peer' ? <p className="device-chat-peer-note">本机通过房间设备 {state.room.host_name} 同步消息。</p> : null}
                <button className="device-chat-leave" type="button" disabled={busy} onClick={() => void leaveRoom()}>{state.role === 'host' ? '解散房间' : '退出群聊'}</button>
            </div>
      </div> : null}
    </details>
    {!activeSetup && state?.room ? <section className="device-chat-thread-picker" aria-label="选择本机 Codex 聊天">
      <div className="thread-list-heading"><span>本机 Codex 聊天</span><small>{codexThreads.length} 条</small></div>
      <p className="device-chat-thread-picker__hint">@本机时继续使用所选聊天的项目上下文。每台设备分别选择。</p>
      <div className="device-chat-thread-picker__search"><Search size={14} /><input value={threadSearch} onChange={(event) => setThreadSearch(event.currentTarget.value)} placeholder="搜索本机聊天记录" aria-label="搜索本机 Codex 聊天" /></div>
      <div className="device-chat-thread-picker__list">
        <button type="button" className={'thread-row device-chat-thread-picker__row' + (!state.local_thread_id ? ' thread-row--active' : '')} aria-pressed={!state.local_thread_id} disabled={busy} onClick={() => void selectLocalThread(null)}><span className="thread-row__icon"><MessageSquare size={15} /></span><span className="thread-row__copy"><strong>自动创建群聊专用聊天</strong></span>{!state.local_thread_id ? <Check size={14} /> : null}</button>
        {matchingThreads.map((thread) => <button type="button" key={thread.id} className={'thread-row device-chat-thread-picker__row' + (state.local_thread_id === thread.id ? ' thread-row--active' : '')} aria-pressed={state.local_thread_id === thread.id} disabled={busy} title={thread.cwd || undefined} onClick={() => void selectLocalThread(thread.id)}><span className="thread-row__icon"><MessageSquare size={15} /></span><span className="thread-row__copy"><strong>{thread.name || thread.preview || '新对话'}</strong>{thread.cwd ? <span className="thread-row__meta"><small>{thread.cwd}</small></span> : null}</span>{state.local_thread_id === thread.id ? <Check size={14} /> : null}</button>)}
        {matchingThreads.length === 0 ? <p className="thread-list__empty">{threadSearch ? '没有找到匹配的 Codex 聊天' : '暂无本机 Codex 聊天记录'}</p> : null}
      </div>
      {state.local_thread_id && !selectedThread ? <p className="device-chat-thread-picker__hint">已选聊天不在当前历史列表中：{state.local_thread_id}</p> : null}
    </section> : null}
  </div>
}

function DeviceChatRoomSetup({ chat, action, onClose }: { chat: DeviceChatController; action: 'create' | 'join'; onClose: () => void }) {
  const { state, deviceName, setDeviceName, hostUrl, setHostUrl, joinCode, setJoinCode, busy, createRoom, joinRoom, leaveRoom } = chat
  const joining = action === 'join'
  const blocked = Boolean(state?.room)
  return <div className="device-chat-setup">
    <form className="device-chat-card" onSubmit={async (event) => {
      event.preventDefault()
      if (blocked || busy) return
      const succeeded = joining ? await joinRoom(event) : await createRoom(event)
      if (succeeded) onClose()
    }}>
      <div className="device-chat-setup__heading"><h3>{joining ? '加入房间' : '创建房间'}</h3>{blocked ? <button type="button" aria-label="返回当前群聊" onClick={onClose}><X size={16} /></button> : null}</div>
      <p>{joining ? '填写另一台设备的穿透地址和设备加入码。加入后，两台设备共享同一个群聊。' : '只需一台设备创建房间；另一台设备点击上方“加入房间”。'}</p>
      <label className="device-chat-field"><span>本机在群聊中的名称</span><input value={deviceName} onChange={(event) => setDeviceName(event.currentTarget.value)} maxLength={40} required autoComplete="off" /></label>
      {joining ? <>
        <label className="device-chat-field"><span>房间设备的可达地址</span><input type="url" value={hostUrl} onChange={(event) => setHostUrl(event.currentTarget.value)} placeholder="https://房间设备的穿透域名" required autoComplete="url" /></label>
        <label className="device-chat-field"><span>设备加入码</span><input value={joinCode} onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase())} maxLength={24} required autoComplete="off" /></label>
      </> : null}
      {blocked ? <div className="device-chat-setup__blocked" role="status">
        <p>本机当前在“{state?.room?.name}”。每台设备一次只能加入一个房间，请先{state?.role === 'host' ? '解散当前房间' : '退出当前房间'}。填写的地址和加入码会保留。</p>
        <button className="device-chat-leave" type="button" disabled={busy} onClick={() => void leaveRoom()}>{state?.role === 'host' ? '先解散当前房间' : '先退出当前房间'}</button>
      </div> : null}
      <button className="device-chat-primary" type="submit" disabled={busy || blocked || !deviceName.trim() || (joining && (!hostUrl.trim() || !joinCode.trim()))}>{busy ? <LoaderCircle className="spin" size={15} /> : null}{joining ? '加入设备群聊' : '创建并生成加入码'}</button>
    </form>
  </div>
}
