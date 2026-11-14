import { ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CircleCheck, CircleX, LoaderCircle, PlugZap, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import {
  devwispClient,
  RemoteApiError,
  type ClaudeModelRole,
  type NativeConfigApplyStatus,
  type NativeEngine,
  type NativeEngineConfig,
  type NativeEngineConnectionResult,
  type NativeEngineProfile,
  type NativeEngineProfileInput,
} from '../lib/devwispClient'
import { TranslationSelect } from './TranslationSelect'

const roles: ClaudeModelRole[] = ['sonnet', 'opus', 'fable', 'haiku']
const modelDisplayNameMaxLength = 80
type Draft = Omit<NativeEngineProfileInput, 'profileId' | 'expectedRevision' | 'expectedNativeRevision' | 'apply'>

function loadError(reason: unknown): string {
  if (reason instanceof RemoteApiError && reason.status === 404) return '当前后端尚未加载多配置功能，需要更新并重启后端后重新读取。'
  return reason instanceof Error ? reason.message : '读取配置失败。'
}

function draftFor(engine: NativeEngine, profile?: NativeEngineProfile): Draft {
  return {
    name: profile?.name ?? '',
    baseUrl: profile?.baseUrl ?? '',
    apiKey: '',
    authMode: profile?.authMode ?? 'bearer',
    protocol: profile?.protocol ?? (engine === 'codex' ? 'responses' : 'anthropic'),
    model: profile?.model ?? '',
    models: engine === 'claude' ? Object.fromEntries(roles.map((role) => [role, {
      displayName: profile?.models[role]?.displayName ?? '', model: profile?.models[role]?.model ?? '',
    }])) : {},
  }
}

function applyMessage(status: NativeConfigApplyStatus, engine: NativeEngine): string {
  if (status === 'saved') return '配置已保存，可随时选择并应用。当前 CLI 配置未更改。'
  if (engine === 'claude') return '已保存并应用。Claude Code 下次回复使用新配置。'
  switch (status) {
    case 'reloaded': return '已保存并应用，Codex 已重新连接并读取新配置。'
    case 'pending': return '已写入本机配置。Codex 仍有任务、请求或未发送的新对话，空闲后请点“重新载入 Codex”。'
    case 'next_connect': return '已保存并应用。Codex 下次连接使用新配置。'
    case 'failed': return '配置已保存，但 Codex 重新连接失败，请检查配置后重试。'
    case 'unchanged': return '已保存，本机正在使用此配置。'
    default: return '已保存。'
  }
}

export function NativeEngineConfigCard({ token, engine, onDirtyChange }: {
  token: string
  engine: NativeEngine
  onDirtyChange: (dirty: boolean) => void
}) {
  useUiLanguage()
  const [config, setConfig] = useState<NativeEngineConfig | null>(null)
  const [profileId, setProfileId] = useState('')
  const [draft, setDraft] = useState<Draft>(() => draftFor(engine))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'apply' | 'test' | 'delete' | 'reload' | 'refresh' | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [testResult, setTestResult] = useState<NativeEngineConnectionResult | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const testController = useRef<AbortController | null>(null)
  const title = engine === 'codex' ? ui('Codex API 配置') : ui('Claude Code API 配置')
  const selected = config?.profiles.find((profile) => profile.id === profileId)
  const active = config?.profiles.find((profile) => profile.id === config.activeProfileId)
  const dirty = Boolean(config && JSON.stringify(draft) !== JSON.stringify(draftFor(engine, selected)))
  const disabled = loading || Boolean(busy) || !config
  const usesGateway = draft.protocol !== (engine === 'codex' ? 'responses' : 'anthropic')
    || (engine === 'codex' && draft.authMode === 'api_key')
  const needsBackendUpdate = Boolean(config && usesGateway && !config.supportedProtocols?.includes(draft.protocol))

  function receive(response: NativeEngineConfig, preferredId?: string) {
    if (!Array.isArray(response.profiles) || !response.profilesRevision) {
      throw new Error('当前后端尚未加载多配置功能，请更新并重启后端后重新读取。')
    }
    const next = response.profiles.find((profile) => profile.id === (preferredId ?? response.activeProfileId)) ?? response.profiles[0]
    setConfig(response)
    setProfileId(next?.id ?? '')
    setDraft(draftFor(engine, next))
    setTestResult(null)
  }

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setMessage(null)
    void devwispClient.nativeEngineConfig(token, engine, controller.signal).then((response) => {
      if (!controller.signal.aborted) receive(response)
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setMessage({ text: loadError(reason), error: true })
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); testController.current?.abort() }
  }, [token, engine])

  useEffect(() => {
    onDirtyChange(dirty || busy === 'save' || busy === 'apply' || busy === 'delete')
    return () => onDirtyChange(false)
  }, [dirty, busy, onDirtyChange])

  function edit(changes: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...changes }))
    setMessage(null)
    setTestResult(null)
  }

  function choose(id: string) {
    if (id === profileId || disabled) return
    if (dirty && !window.confirm(ui('当前修改还没保存，放弃修改并切换配置吗？'))) return
    setProfileId(id)
    setDraft(draftFor(engine, config?.profiles.find((profile) => profile.id === id)))
    setMessage(null)
    setTestResult(null)
  }

  async function refresh() {
    if (dirty && !window.confirm(ui('重新读取会丢弃当前未保存的修改，继续吗？'))) return
    setBusy('refresh')
    setMessage(null)
    try {
      receive(await devwispClient.nativeEngineConfig(token, engine), profileId)
    } catch (reason) {
      setMessage({ text: loadError(reason), error: true })
    } finally { setBusy(null) }
  }

  function input(): NativeEngineProfileInput {
    return {
      ...draft, profileId: profileId || undefined,
      expectedRevision: config!.profilesRevision, expectedNativeRevision: config!.revision,
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || needsBackendUpdate) return
    const apply = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value !== 'save'
    setBusy(apply ? 'apply' : 'save')
    setMessage(null)
    setTestResult(null)
    try {
      const result = await devwispClient.saveNativeEngineProfile(token, engine, { ...input(), apply })
      receive(result.config, result.profileId)
      setMessage({ text: result.applyError ?? applyMessage(result.applyStatus, engine), error: result.applyStatus === 'failed' })
      if (result.applied) window.dispatchEvent(new CustomEvent('devwisp:native-config-changed', { detail: { engine, model: result.config.model } }))
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '保存配置失败。', error: true })
    } finally { setBusy(null) }
  }

  async function remove() {
    if (!selected || !config || disabled) return
    if (!window.confirm(uiFormat('删除配置“{0}”{1}？', selected.name, dirty ? ui('并放弃未保存的修改') : ''))) return
    setBusy('delete')
    setMessage(null)
    try {
      receive(await devwispClient.deleteNativeEngineProfile(token, engine, profileId, config.profilesRevision))
      setMessage({ text: '配置已删除。', error: false })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '删除配置失败。', error: true })
    } finally { setBusy(null) }
  }

  async function test() {
    if (disabled || needsBackendUpdate || !formRef.current?.reportValidity()) return
    const controller = new AbortController()
    testController.current = controller
    setBusy('test')
    setMessage(null)
    setTestResult(null)
    try {
      const result = await devwispClient.testNativeEngineProfile(token, engine, input(), controller.signal)
      if (!controller.signal.aborted) setTestResult(result)
    } catch (reason) {
      if (!controller.signal.aborted) setMessage({ text: reason instanceof Error ? reason.message : '测试失败。', error: true })
    } finally {
      if (!controller.signal.aborted) setBusy(null)
      if (testController.current === controller) testController.current = null
    }
  }

  async function reloadCodex() {
    if (engine !== 'codex' || busy) return
    setBusy('reload')
    setMessage(null)
    try {
      const result = await devwispClient.reloadNativeCodexConfig(token)
      setConfig((current) => current ? { ...current, reloadPending: result.reloadPending } : current)
      setMessage({ text: applyMessage(result.applyStatus, engine), error: result.applyStatus === 'failed' })
    } catch (reason) {
      setMessage({ text: reason instanceof Error ? reason.message : '重新载入 Codex 失败。', error: true })
    } finally { setBusy(null) }
  }

  return <section className="theme-settings-card theme-settings-card--page native-config" aria-label={title}>
    <div className="theme-settings-card__heading">
      <div>
        <h2><span className={`engine-brand-icon engine-brand-icon--${engine === 'codex' ? 'codex' : 'claude-code'}`} aria-hidden="true" />{title}</h2>
        <p>{uiFormat('保存多套接口配置，按需要切换本机 {0} 使用的配置。', engine === 'codex' ? 'Codex' : 'Claude Code')}</p>
      </div>
    </div>
    <div className="native-config__body">
      <div className="native-config__profiles">
        <TranslationSelect label={ui("已保存配置")} value={profileId || '__new'} disabled={disabled} onChange={(value) => choose(value === '__new' ? '' : value)} options={[
          ...(config?.profiles ?? []).map((profile) => ({ value: profile.id, label: `${profile.name}${profile.id === config?.activeProfileId ? ui(' · 当前使用') : ''}` })),
          ...(!profileId ? [{ value: '__new', label: ui('新增配置') }] : []),
        ]} />
        <div className="native-config__profile-actions">
          <button type="button" className="theme-notification-toggle" disabled={disabled || !profileId} onClick={() => choose('')}><Plus size={16} />{ui("新增")}</button>
          <button type="button" className="theme-notification-toggle" disabled={disabled || !selected || profileId === config?.activeProfileId} onClick={() => { void remove() }} title={profileId === config?.activeProfileId ? ui('先应用另一套配置，再删除当前配置') : ui('删除此配置')}><Trash2 size={15} />{ui("删除")}</button>
        </div>
      </div>
      {config ? <p className="native-config__current">{ui("当前使用：")}<strong>{active?.name ?? ui('本机配置（与已保存配置不同）')}</strong><span>{ui("选择配置用于编辑，点击“保存并应用”才会切换。")}</span></p> : null}
      <form ref={formRef} className="native-config__form" onSubmit={(event) => { void save(event) }}>
        <label className="native-config__field"><span>{ui("配置名称")}</span><input value={draft.name} onChange={(event) => edit({ name: event.target.value })} placeholder={ui("例如：日常使用、备用接口")} maxLength={80} required disabled={disabled} /></label>
        <section className="native-config__group" aria-label={ui("接口配置")}>
          <h3>{ui("接口配置")}</h3>
          <div className="native-config__columns">
            <div className="native-config__field">
              <TranslationSelect label={ui("接口协议")} value={draft.protocol} disabled={disabled} onChange={(value) => edit({ protocol: value as Draft['protocol'] })} options={[
                { value: 'responses', label: 'OpenAI Responses' },
                { value: 'anthropic', label: 'Anthropic Messages' },
                { value: 'chat', label: 'OpenAI Chat Completions' },
              ]} />
              <small>{usesGateway ? ui('自动适配所选接口；使用期间需保持 Dev Wisp 后端运行。') : ui('直接使用所选协议连接接口。')}</small>
            </div>
            <div className="native-config__field">
              <TranslationSelect label={ui("密钥传递方式")} value={draft.authMode} disabled={disabled} onChange={(value) => edit({ authMode: value as Draft['authMode'] })} options={[
                { value: 'bearer', label: 'Bearer Token（Authorization）' },
                { value: 'api_key', label: 'API Key（x-api-key）' },
              ]} />
              <small>{ui("根据接口要求选择，切换时保留当前密钥。")}</small>
            </div>
          </div>
          <label className="native-config__field"><span>{ui("API 地址")}</span><input type="url" value={draft.baseUrl} onChange={(event) => edit({ baseUrl: event.target.value })} placeholder={draft.protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1'} maxLength={2048} autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={disabled} /><small>{ui("填写接口基础地址或完整请求地址，末尾路径会按所选协议自动整理。")}</small></label>
          <label className="native-config__field"><span>{ui("API 密钥")}{selected?.hasKey ? <em>{ui("已保存 · 留空保留")}</em> : null}</span><input type="password" value={draft.apiKey} onChange={(event) => edit({ apiKey: event.target.value })} placeholder={selected?.hasKey ? ui('留空保留此配置的密钥') : ui('输入 API 密钥')} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} required={!selected?.hasKey} disabled={disabled} /></label>
        </section>
        <section className="native-config__group" aria-label={ui("模型配置")}>
          <h3>{ui("模型配置")}</h3>
          <label className="native-config__field"><span>{ui("默认模型")}</span><input value={draft.model} onChange={(event) => edit({ model: event.target.value })} placeholder={engine === 'codex' ? ui('填写服务商提供的模型 ID') : ui('例如 sonnet、opus，或实际模型 ID')} maxLength={256} autoCapitalize="none" autoCorrect="off" spellCheck={false} required={engine === 'codex' || draft.protocol !== 'anthropic'} disabled={disabled} /><small>{engine === 'codex' ? ui('应用后，网页模型菜单和本机 CLI 使用此模型。') : ui('可填下面的角色名以使用映射；原生 Messages 协议可留空。聊天中手动选择的模型优先。')}</small></label>
          {engine === 'claude' ? <div className="native-config__mappings">
            <div className="native-config__model-header" aria-hidden="true"><span>{ui("模型角色")}</span><span>{ui("显示名称")}</span><span>{ui("实际请求模型")}</span></div>
            {roles.map((role) => <div className="native-config__model-row" key={role}>
              <span className="native-config__role">{role[0].toUpperCase() + role.slice(1)}</span>
              <label className="native-config__field"><span className="native-config__mobile-label">{ui("显示名称")}</span><input aria-label={uiFormat("{0} 显示名称", role)} value={draft.models[role]?.displayName ?? ''} onChange={(event) => edit({ models: { ...draft.models, [role]: { displayName: event.target.value, model: draft.models[role]?.model ?? '' } } })} placeholder={`Claude ${role[0].toUpperCase() + role.slice(1)}`} maxLength={modelDisplayNameMaxLength} disabled={disabled} /></label>
              <label className="native-config__field"><span className="native-config__mobile-label">{ui("实际请求模型")}</span><input aria-label={uiFormat("{0} 实际请求模型", role)} value={draft.models[role]?.model ?? ''} onChange={(event) => edit({ models: { ...draft.models, [role]: { displayName: event.target.value.slice(0, modelDisplayNameMaxLength), model: event.target.value } } })} placeholder={ui("留空使用 CLI 默认")} maxLength={256} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled} /></label>
            </div>)}
            <p className="native-config__hint">{ui("实际请求模型填写服务商的模型 ID，修改时会同步填写显示名称，之后可单独改名。多个角色可以填写同一个模型。")}</p>
          </div> : null}
        </section>
        {needsBackendUpdate ? <p className="native-config__message" role="status">{ui("后端尚未加载接口转换功能，重启后端后请点“重新读取”，即可保存和使用此协议。")}</p> : null}
        <div className="native-config__actions">
          <button className="theme-notification-toggle theme-notification-toggle--enabled" type="submit" value="apply" disabled={disabled || needsBackendUpdate}>{busy === 'apply' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy === 'apply' ? ui('正在应用…') : ui('保存并应用')}</button>
          <button className="theme-notification-toggle" type="submit" value="save" disabled={disabled || needsBackendUpdate || !dirty}>{busy === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{ui("保存配置")}</button>
          <button className="theme-notification-toggle" type="button" disabled={disabled || needsBackendUpdate} onClick={() => { void test() }}>{busy === 'test' ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}{busy === 'test' ? ui('正在测试…') : ui('测试连通性')}</button>
          <button className="theme-notification-toggle" type="button" disabled={loading || Boolean(busy)} onClick={() => { void refresh() }}><RefreshCw className={busy === 'refresh' ? 'spin' : undefined} size={15} />{ui("重新读取")}</button>
          {engine === 'codex' && config?.reloadPending ? <button className="theme-notification-toggle" type="button" disabled={Boolean(busy)} onClick={() => { void reloadCodex() }}><RefreshCw className={busy === 'reload' ? 'spin' : undefined} size={15} />{ui("重新载入 Codex")}</button> : null}
        </div>
      </form>
      {loading ? <p className="native-config__message" role="status">{ui("正在读取配置…")}</p> : null}
      {engine === 'codex' && config?.reloadPending && !message ? <p className="native-config__message" role="status">{ui("Codex 尚未重新载入配置，空闲后请点“重新载入 Codex”。")}</p> : null}
      {message ? <p className={'native-config__message' + (message.error ? ' native-config__message--error' : '')} role={message.error ? 'alert' : 'status'}>{uiMessage(message.text)}</p> : null}
      {testResult ? <div className="native-config__test-results" role="status" aria-live="polite">
        <strong>{testResult.ok ? ui('连通性测试通过') : ui('连通性测试未全部通过')} · {testResult.results.filter((result) => result.ok).length}/{testResult.results.length}</strong>
        {testResult.results.map((result) => <div className={`native-config__test-row${result.ok ? '' : ' native-config__message--error'}`} key={result.model}>
          {result.ok ? <CircleCheck size={17} /> : <CircleX size={17} />}
          <div><strong>{result.model}</strong><p>{result.message}</p></div><small>{(result.latencyMs / 1000).toFixed(1)} {ui("秒")}</small>
        </div>)}
      </div> : null}
      <div className="native-config__footnote">
        <p className="native-config__hint">{ui("测试使用当前表单发起简短请求，可能产生少量 API 费用；不修改正在使用的配置。")}</p>
        <p className="native-config__hint">{ui("密钥保存在服务端，网页不回显。独立运行中的 CLI 会话需重新打开才能读取新配置。")}</p>
        {config ? <p className="native-config__hint">{ui("本机文件：")}<code>{config.path}</code></p> : null}
      </div>
    </div>
  </section>
}
