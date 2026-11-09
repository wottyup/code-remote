import { useState, type FormEvent } from 'react'
import { Check, ExternalLink, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { ui, uiMessage } from '../lib/uiLanguage'
import type { WebDeviceManagerState } from '../lib/webDeviceManager'

export function WebDeviceSettingsCard({ manager }: { manager: WebDeviceManagerState }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  function addDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    try {
      manager.addProfile(name, url)
      setName('')
      setUrl('')
      setMessage('设备已保存，可在侧栏切换。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '添加设备失败。')
    }
  }

  function saveName(id: string) {
    setError(null)
    setMessage(null)
    try {
      manager.renameProfile(id, editingName)
      setEditingId(null)
      setMessage('设备名称已更新。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设备名称更新失败。')
    }
  }

  function removeDevice(id: string, deviceName: string) {
    if (!window.confirm(uiMessage(`确定移除“${deviceName}”？`))) return
    setError(null)
    setMessage(null)
    try {
      manager.removeProfile(id)
      setMessage('设备已移除。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '移除设备失败。')
    }
  }

  return (
    <section className="theme-settings-card theme-settings-card--page web-device-settings" aria-label={ui('设备连接')}>
      <div className="theme-settings-card__heading">
        <div><h2>{ui('设备连接')}</h2><p>{ui('添加其他 Code Remote 网页；首次连接时，在设备页面输入该电脑显示的匹配码。')}</p></div>
      </div>

      <form className="web-device-settings__form" onSubmit={addDevice}>
        <label className="theme-control-row web-device-settings__field">
          <span><strong>{ui('设备名称')}</strong><small>{ui('可选；留空时使用地址中的主机名。')}</small></span>
          <input type="text" value={name} maxLength={48} autoComplete="off" placeholder={ui('例如：家里的电脑')} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        <label className="theme-control-row web-device-settings__field">
          <span><strong>{ui('Code Remote 地址')}</strong><small>{ui('支持 HTTP 或 HTTPS，也可以填写带路径的地址。')}</small></span>
          <input type="text" value={url} required autoComplete="url" spellCheck={false} placeholder="http://192.168.1.20:4173" onChange={(event) => setUrl(event.currentTarget.value)} />
        </label>
        <div className="web-device-settings__form-actions">
          <button className="web-device-settings__add" type="submit"><Plus size={15} />{ui('添加设备')}</button>
        </div>
      </form>

      <div className="web-device-settings__list" aria-label={ui('已保存的设备')}>
        <h3>{ui('已保存的设备')}</h3>
        {manager.profiles.map((profile) => <div className="web-device-settings__row" key={profile.id}>
          <div className="web-device-settings__identity">
            <strong title={profile.name}>{profile.name}</strong>
            <small title={profile.url}>{profile.isCurrent ? ui('当前网页') : profile.url}</small>
          </div>
          <span className={`web-device-settings__status${profile.paired ? ' web-device-settings__status--paired' : ''}`}>
            <i aria-hidden="true" />{profile.paired ? ui('已配对') : ui('未配对')}
          </span>
          {!profile.isCurrent ? <div className="web-device-settings__actions">
            {editingId === profile.id ? <>
              <input type="text" value={editingName} maxLength={48} autoFocus aria-label={ui('设备名称')} onChange={(event) => setEditingName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveName(profile.id) } if (event.key === 'Escape') setEditingId(null) }} />
              <button type="button" title={ui('保存')} aria-label={ui('保存')} onClick={() => saveName(profile.id)}><Save size={15} /></button>
              <button type="button" title={ui('取消')} aria-label={ui('取消')} onClick={() => setEditingId(null)}><X size={15} /></button>
            </> : <>
              <button type="button" title={ui('重命名')} aria-label={uiMessage(`重命名 ${profile.name}`)} onClick={() => { setError(null); setEditingId(profile.id); setEditingName(profile.name) }}><Pencil size={15} /></button>
              {manager.windowHref(profile.id) ? <a href={manager.windowHref(profile.id)!} target="_blank" rel="noreferrer" title={ui('在新窗口打开')} aria-label={uiMessage(`在新窗口打开 ${profile.name}`)}><ExternalLink size={15} /></a> : null}
              <button type="button" title={ui('移除')} aria-label={uiMessage(`移除 ${profile.name}`)} onClick={() => removeDevice(profile.id, profile.name)}><Trash2 size={15} /></button>
            </>}
          </div> : <span className="web-device-settings__current"><Check size={14} />{ui('管理页面')}</span>}
        </div>)}
      </div>

      {error ? <p className="theme-settings-hint web-device-settings__feedback web-device-settings__feedback--error" role="alert">{uiMessage(error)}</p> : null}
      {message ? <p className="theme-settings-hint web-device-settings__feedback" role="status">{uiMessage(message)}</p> : null}
      <p className="theme-settings-hint web-device-settings__note">{ui('设备名称和地址保存在此浏览器；匹配码由各设备自己的 Code Remote 页面处理。')}</p>
    </section>
  )
}
