import { Copy, LoaderCircle, MessageSquare, Plus, Users, X } from 'lucide-react'
import type { DeviceChatController } from '../hooks/useDeviceChat'
import './DeviceChatSidebar.css'

export function DeviceChatSidebar({ chat, onSelectRoom }: { chat: DeviceChatController; onSelectRoom: () => void }) {
  const { state, loading, deviceName, setDeviceName, hostUrl, setHostUrl, inviteCode, joinCode, setJoinCode, busy, error, setError, copied, createRoom, createInvite, joinRoom, leaveRoom, copyValue } = chat
  const hostAddress = window.location.origin
  return <div className="device-chat-sidebar" aria-label="设备群聊侧栏">
    <div className="thread-list-heading"><span>群聊</span></div>
    {state?.room ? <button className="thread-row thread-row--active device-chat-sidebar__room" type="button" aria-current="page" onClick={onSelectRoom}><span className="thread-row__icon"><Users size={16} /></span><span className="thread-row__copy"><strong>{state.room.name}</strong><span className="thread-row__meta"><small>{state.members.length} 台设备 · {state.connected || state.role === 'host' ? '已连接' : '重连中'}</small></span></span></button> : null}
    <div className="device-chat-room-panel" aria-label="设备群聊房间管理">
    <header className="device-chat-room-panel__header"><strong>{state?.room ? '成员与邀请' : '创建或加入群聊'}</strong></header>
    {error ? <div className="device-chat-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><X size={14} /></button></div> : null}
        {!state && loading ? <div className="device-chat-sidebar__loading" role="status"><LoaderCircle className="spin" size={15} />正在读取群聊…</div> : !state?.room ? (
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
        )}
    </div>
  </div>
}
