import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react'
import { ui, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import {
  devwispClient,
  type SshMcpProfile,
  type SshMcpSettings,
} from '../lib/devwispClient'

interface ProfileDraft {
  id: number
  value: SshMcpProfile
  persisted: boolean
  collapsed: boolean
}

let nextDraftId = 1

function newProfile(id: number, name: string): SshMcpProfile {
  return {
    name, host: '', port: 22, user: '', auth: 'password', group: 'dev', role: 'admin',
    readOnly: false, approvalPolicy: 'auto',
  }
}

function draftsFor(profiles: SshMcpProfile[]): ProfileDraft[] {
  return profiles.map((value) => ({ id: nextDraftId++, value: { ...value }, persisted: true, collapsed: true }))
}

function emptyDraft(): ProfileDraft {
  const id = nextDraftId++
  return { id, value: newProfile(id, `ssh-server-${id}`), persisted: false, collapsed: false }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '读取 SSH MCP 配置失败。'
}

export function SshMcpSettingsCard({ token }: { token: string }) {
  useUiLanguage()
  const [settings, setSettings] = useState<SshMcpSettings | null>(null)
  const [profiles, setProfiles] = useState<ProfileDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const disabled = loading || saving
  const saveDisabled = disabled || settings === null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setMessage(null)
    void devwispClient.sshMcpSettings(token).then((result) => {
      if (cancelled) return
      setSettings(result)
      setProfiles(result.profiles.length ? draftsFor(result.profiles) : [emptyDraft()])
    }).catch((reason: unknown) => {
      if (!cancelled) setMessage({ text: errorMessage(reason), error: true })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  function update(id: number, changes: Partial<SshMcpProfile>) {
    setProfiles((current) => current.map((draft) => draft.id === id
      ? { ...draft, value: { ...draft.value, ...changes } }
      : draft))
    setMessage(null)
  }

  function addProfile() {
    const id = nextDraftId++
    setProfiles((current) => {
      const names = new Set(current.map(({ value }) => value.name.toLowerCase()))
      let name = `ssh-server-${id}`
      let suffix = 1
      while (names.has(name.toLowerCase())) name = `ssh-server-${id}-${suffix++}`
      return [...current, { id, value: newProfile(id, name), persisted: false, collapsed: false }]
    })
    setMessage(null)
  }

  function toggleProfile(id: number) {
    setProfiles((current) => current.map((draft) => draft.id === id && draft.persisted
      ? { ...draft, collapsed: !draft.collapsed }
      : draft))
  }

  function removeProfile(id: number) {
    setProfiles((current) => current.filter((draft) => draft.id !== id))
    setMessage(null)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !event.currentTarget.reportValidity()) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await devwispClient.saveSshMcpSettings(token, profiles.map(({ value }) => {
        const profile = { ...value }
        delete profile.hasPassword
        return {
          ...profile,
          keyRef: profile.auth === 'key' ? profile.keyRef?.trim() || undefined : undefined,
          trustedHostKey: profile.trustedHostKey?.trim() || undefined,
          workdir: profile.workdir?.trim() || undefined,
        }
      }))
      setSettings(result)
      setProfiles(draftsFor(result.profiles))
      setMessage({ text: result.profiles.length ? 'SSH MCP 配置已保存；新建或重新打开的 Codex 对话会使用这些服务器。' : 'SSH MCP 配置已移除。', error: false })
    } catch (reason) {
      setMessage({ text: errorMessage(reason), error: true })
    } finally {
      setSaving(false)
    }
  }

  return <section className="theme-settings-card theme-settings-card--page native-config ssh-mcp-card" aria-label={ui('SSH MCP 服务器')}>
    <div className="theme-settings-card__heading">
      <div>
        <h2><span className="ssh-mcp-shield" aria-hidden="true">SSH</span>{ui('SSH MCP 服务器')}</h2>
        <p>{ui('填写 IP、端口、用户名和密码即可添加 SSH 服务器。')}</p>
      </div>
      <span className="theme-settings-card__badge">{ui('仅 Codex')}</span>
    </div>
    <div className="native-config__body">
      {loading ? <p className="native-config__message" role="status">{ui('正在读取 SSH MCP 配置…')}</p> : null}
      {!loading && settings && !settings.available ? <p className="native-config__message native-config__message--error" role="status">
        {ui('SSH MCP 运行依赖不可用。请确认 Dev Wisp 工作区已安装 pnpm 依赖。')}
      </p> : null}
      {profiles.length === 0 && !loading ? <p className="native-config__message">{ui('尚未配置 SSH 服务器。')}</p> : null}
      <form className="native-config__form" onSubmit={(event) => { void save(event) }}>
        {profiles.map(({ id, value, persisted, collapsed }, index) => {
          const fieldsId = `ssh-mcp-profile-fields-${id}`
          const title = `${ui('服务器')} ${index + 1}`
          const summary = [value.host ? `${value.host}:${value.port}` : '', value.user].filter(Boolean).join(' · ')
          return <section className="native-config__group ssh-mcp-profile" key={id} aria-label={ui('SSH MCP 服务器配置')}>
          <div className="ssh-mcp-profile__heading">
            <div className="ssh-mcp-profile__heading-info">
              <h3>{persisted ? <button className="ssh-mcp-profile__toggle" type="button" aria-expanded={!collapsed} aria-controls={fieldsId} aria-label={collapsed ? ui('展开服务器配置') : ui('折叠服务器配置')} disabled={disabled} onClick={(event) => {
                if (!collapsed) {
                  const invalidField = event.currentTarget.closest('.ssh-mcp-profile')?.querySelector<HTMLInputElement>('input:invalid')
                  if (invalidField) {
                    invalidField.reportValidity()
                    return
                  }
                }
                toggleProfile(id)
              }}><ChevronDown size={16} aria-hidden="true" />{title}</button> : title}</h3>
              {collapsed && summary ? <small className="ssh-mcp-profile__summary">{summary}</small> : null}
            </div>
            <button className="theme-notification-toggle ssh-mcp-profile__remove" type="button" disabled={disabled} onClick={() => removeProfile(id)}>
              <Trash2 size={15} />{ui('移除')}
            </button>
          </div>
          <fieldset id={fieldsId} className="ssh-mcp-profile__fields" disabled={disabled || collapsed} hidden={collapsed}>
          <div className="native-config__columns">
            <label className="native-config__field"><span>{ui('IP 地址 / 主机名')}</span><input value={value.host} onChange={(event) => update(id, { host: event.target.value })} placeholder="192.168.1.10" maxLength={255} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('端口')}</span><input type="number" min={1} max={65535} value={value.port} onChange={(event) => update(id, { port: Number(event.target.value) })} required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('用户名')}</span><input value={value.user} onChange={(event) => update(id, { user: event.target.value })} maxLength={128} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('密码')}</span><input type="password" autoComplete="new-password" maxLength={4096} value={value.password ?? ''} onChange={(event) => update(id, { password: event.target.value, ...(event.target.value ? { auth: 'password' } : {}) })} placeholder={value.hasPassword ? ui('已保存，留空则保持不变') : ui('输入 SSH 登录密码')} required={value.auth === 'password' && !value.hasPassword} disabled={disabled} /><small>{value.hasPassword ? ui('密码已保存；留空会继续使用。') : ui('密码保存在 Dev Wisp 主机，不会在设置中显示。')}</small></label>
          </div>
          </fieldset>
        </section>
        })}
        <div className="native-config__actions ssh-mcp-actions">
          <button className="theme-notification-toggle" type="button" disabled={disabled} onClick={addProfile}><Plus size={16} />{ui('添加服务器')}</button>
          <button className={`theme-notification-toggle${saveDisabled ? '' : ' theme-notification-toggle--enabled'}`} type="submit" disabled={saveDisabled}>
            {saving ? <LoaderCircle size={15} className="ssh-mcp-spin" /> : <Save size={15} />}{saving ? ui('保存中…') : ui('保存配置')}
          </button>
        </div>
        {message ? <p className={message.error ? 'native-config__message native-config__message--error' : 'native-config__message'} role={message.error ? 'alert' : 'status'}>{uiMessage(message.text)}</p> : null}
      </form>
      <p className="native-config__hint">{ui('配置保存在运行 Dev Wisp 的电脑上。保存后，新建或重新打开的 Codex 对话使用最新设置；正在运行的对话不受影响。')}</p>
      <p className="native-config__hint">{ui('Claude Code 暂不支持此功能，因为它的命令审批还不能转发到网页。')}</p>
    </div>
  </section>
}
