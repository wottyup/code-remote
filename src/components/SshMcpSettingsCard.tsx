import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react'
import { ui, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import {
  codexRemoteClient,
  type SshMcpApprovalPolicy,
  type SshMcpHostGroup,
  type SshMcpProfile,
  type SshMcpRole,
  type SshMcpSettings,
} from '../lib/codexRemoteClient'
import { TranslationSelect } from './TranslationSelect'

interface ProfileDraft {
  id: number
  value: SshMcpProfile
  persisted: boolean
  collapsed: boolean
}

let nextDraftId = 1

function newProfile(): SshMcpProfile {
  return {
    name: '', host: '', port: 22, user: '', auth: 'agent', group: 'prod', role: 'viewer',
    readOnly: true, approvalPolicy: 'ask-all',
  }
}

function draftsFor(profiles: SshMcpProfile[]): ProfileDraft[] {
  return profiles.map((value) => ({ id: nextDraftId++, value: { ...value }, persisted: true, collapsed: true }))
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
    void codexRemoteClient.sshMcpSettings(token).then((result) => {
      if (cancelled) return
      setSettings(result)
      setProfiles(draftsFor(result.profiles))
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
    setProfiles((current) => [...current, { id: nextDraftId++, value: newProfile(), persisted: false, collapsed: false }])
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
      const result = await codexRemoteClient.saveSshMcpSettings(token, profiles.map(({ value }) => ({
        ...value,
        keyRef: value.auth === 'key' ? value.keyRef?.trim() || undefined : undefined,
        trustedHostKey: value.trustedHostKey?.trim() || undefined,
        workdir: value.workdir?.trim() || undefined,
      })))
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
        <p>{ui('配置 Codex 可使用的 SSH 服务器，并分别限制它能执行的命令。')}</p>
      </div>
      <span className="theme-settings-card__badge">{ui('仅 Codex')}</span>
    </div>
    <div className="native-config__body">
      {loading ? <p className="native-config__message" role="status">{ui('正在读取 SSH MCP 配置…')}</p> : null}
      {!loading && settings && !settings.available ? <p className="native-config__message native-config__message--error" role="status">
        {ui('SSH MCP 运行依赖不可用。请确认 Code Remote 工作区已安装 pnpm 依赖。')}
      </p> : null}
      <p className="native-config__hint">{ui('默认使用最严格设置：生产分组、viewer 角色、只读，并逐次询问每条命令。请只连接可信服务器。')}</p>
      {profiles.length === 0 && !loading ? <p className="native-config__message">{ui('尚未配置 SSH 服务器。')}</p> : null}
      <form className="native-config__form" onSubmit={(event) => { void save(event) }}>
        {profiles.map(({ id, value, persisted, collapsed }, index) => {
          const fieldsId = `ssh-mcp-profile-fields-${id}`
          const title = `${ui('服务器')} ${index + 1}${value.name ? ' · ' + value.name : ''}`
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
            <label className="native-config__field"><span>{ui('服务器名称')}</span><input value={value.name} onChange={(event) => update(id, { name: event.target.value })} placeholder="prod-web" maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('主机地址')}</span><input value={value.host} onChange={(event) => update(id, { host: event.target.value })} placeholder="server.example.com" maxLength={255} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('SSH 端口')}</span><input type="number" min={1} max={65535} value={value.port} onChange={(event) => update(id, { port: Number(event.target.value) })} required disabled={disabled} /></label>
            <label className="native-config__field"><span>{ui('用户名')}</span><input value={value.user} onChange={(event) => update(id, { user: event.target.value })} maxLength={128} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /></label>
            <div className="native-config__field"><TranslationSelect label={ui('SSH 认证')} value={value.auth} disabled={disabled} onChange={(auth) => update(id, { auth: auth as SshMcpProfile['auth'] })} options={[
              { value: 'agent', label: ui('SSH Agent') },
              { value: 'key', label: ui('私钥文件路径') },
            ]} /><small>{ui('认证在运行 Code Remote 的电脑上完成。网页不会上传密码或私钥内容。')}</small></div>
            {value.auth === 'key' ? <label className="native-config__field"><span>{ui('私钥文件路径')}</span><input value={value.keyRef ?? ''} onChange={(event) => update(id, { keyRef: event.target.value })} placeholder="~/.ssh/id_ed25519" maxLength={2048} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /><small>{ui('填写运行 Code Remote 的电脑上的路径；Windows 请使用完整路径。')}</small></label> : null}
            <div className="native-config__field"><TranslationSelect label={ui('主机分组')} value={value.group} disabled={disabled} onChange={(group) => update(id, { group: group as SshMcpHostGroup })} options={[
              { value: 'prod', label: ui('生产环境') },
              { value: 'staging', label: ui('预发布环境') },
              { value: 'dev', label: ui('开发环境') },
            ]} /><small>{ui('生产环境使用更严格的内置命令权限。')}</small></div>
            <div className="native-config__field"><TranslationSelect label={ui('命令角色')} value={value.role} disabled={disabled} onChange={(role) => update(id, { role: role as SshMcpRole })} options={[
              { value: 'viewer', label: ui('viewer · 只读为主') },
              { value: 'operator', label: ui('operator · 常规运维') },
              { value: 'admin', label: ui('admin · 管理操作') },
            ]} /><small>{ui('角色与主机分组共同决定可运行的命令类别。')}</small></div>
            <div className="native-config__field"><TranslationSelect label={ui('命令确认')} value={value.approvalPolicy} disabled={disabled} onChange={(approvalPolicy) => update(id, { approvalPolicy: approvalPolicy as SshMcpApprovalPolicy })} options={[
              { value: 'ask-all', label: ui('每条命令都询问') },
              { value: 'ask-destructive', label: ui('仅高风险命令询问') },
              { value: 'deny', label: ui('拒绝需确认的命令') },
            ]} /><small>{ui('自动批准已关闭；逐次确认会在 Codex 聊天中显示命令内容。')}</small></div>
            <label className="native-config__field"><span>{ui('服务器 SSH 主机指纹')} <em>{ui('可选')}</em></span><input value={value.trustedHostKey ?? ''} onChange={(event) => update(id, { trustedHostKey: event.target.value })} placeholder="SHA256:…" maxLength={512} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled} /><small>{ui('填写指纹后会固定校验该服务器身份。')}</small></label>
            <label className="native-config__field"><span>{ui('远程起始目录')} <em>{ui('可选')}</em></span><input value={value.workdir ?? ''} onChange={(event) => update(id, { workdir: event.target.value })} placeholder="/var/www/app" maxLength={2048} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled} /></label>
          </div>
          <label className="ssh-mcp-readonly"><input type="checkbox" checked={value.readOnly} disabled={disabled} onChange={(event) => update(id, { readOnly: event.target.checked })} /><span><strong>{ui('只读限制')}</strong><small>{ui('开启后，即使角色允许写入，也不能执行修改类命令。')}</small></span></label>
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
      <p className="native-config__hint">{ui('配置保存在运行 Code Remote 的电脑上。保存后，新建或重新打开的 Codex 对话使用最新设置；正在运行的对话不受影响。')}</p>
      <p className="native-config__hint">{ui('Claude Code 暂不支持此功能，因为它的命令审批还不能转发到网页。')}</p>
    </div>
  </section>
}
