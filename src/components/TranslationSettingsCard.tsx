import { useEffect, useId, useState, type FormEvent } from 'react'
import { ChevronDown, Languages, LoaderCircle } from 'lucide-react'
import { codexRemoteClient, type TranslationApiProtocol, type TranslationConfigInput, type TranslationConfigResponse, type TranslationProvider } from '../lib/codexRemoteClient'
import { readSettingsSectionOpen, saveSettingsSectionOpen } from '../lib/settingsSectionState'
import type { TranslationPreferences } from '../lib/translationPreferences'

const choices: Array<{ value: TranslationProvider; label: string }> = [
  { value: 'microsoft', label: 'Microsoft Translator' },
  { value: 'google', label: 'Google Cloud Translation' },
  { value: 'deepl', label: 'DeepL API' },
  { value: 'chat', label: '兼容 Chat Completions 的接口' },
  { value: 'responses', label: 'OpenAI Responses API（需开启路由）' },
  { value: 'anthropic', label: 'Anthropic Messages 原生接口' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]

const protocolChoices: Array<{ value: TranslationApiProtocol; label: string }> = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

function isApiProtocol(value: TranslationProvider): value is TranslationApiProtocol {
  return value === 'chat' || value === 'responses' || value === 'anthropic'
}

export function TranslationSettingsCard({ token, preferences, onChange, onConfigSaved }: {
  token: string
  preferences: TranslationPreferences
  onChange: (next: TranslationPreferences) => void
  onConfigSaved: () => void
}) {
  const sendHintId = useId()
  const displayHintId = useId()
  const [configuration, setConfiguration] = useState<TranslationConfigResponse | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [regionDraft, setRegionDraft] = useState('')
  const [planDraft, setPlanDraft] = useState('free')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [protocolTarget, setProtocolTarget] = useState<TranslationApiProtocol>('responses')
  const [moveOffer, setMoveOffer] = useState<{ source: TranslationApiProtocol; target: TranslationApiProtocol; profileId: string; name: string } | null>(null)
  const [busyAction, setBusyAction] = useState<'save' | 'check' | 'clear' | 'create' | 'copy' | 'delete' | 'move' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const provider = preferences.provider
  const profiles = configuration?.providers[provider]?.profiles ?? []
  const selectedId = preferences.profileIds[provider]
  const fallbackProfile = profiles.find((profile) => profile.id === `${provider}-default`) ?? profiles[0]
  const current = selectedId ? profiles.find((profile) => profile.id === selectedId) : fallbackProfile
  const missingSelection = Boolean(configuration && selectedId && !current)
  const selectedProtocolTarget = protocolTarget === provider ? (provider === 'chat' ? 'responses' : 'chat') : protocolTarget

  useEffect(() => {
    let cancelled = false
    void codexRemoteClient.translationConfig(token).then((response) => {
      if (!cancelled) setConfiguration(response)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取翻译设置。')
    })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    setNameDraft(current?.name ?? '')
    setKeyDraft('')
    setRegionDraft(current?.region ?? '')
    setPlanDraft(current?.plan ?? 'free')
    setBaseUrlDraft(current?.baseUrl ?? '')
    setModelDraft(current?.model ?? '')
  }, [provider, current?.id, current?.name, current?.region, current?.plan, current?.baseUrl, current?.model])

  function selectProfile(profileId: string) {
    const profile = profiles.find((entry) => entry.id === profileId)
    setNameDraft(profile?.name ?? '')
    setKeyDraft('')
    setRegionDraft(profile?.region ?? '')
    setPlanDraft(profile?.plan ?? 'free')
    setBaseUrlDraft(profile?.baseUrl ?? '')
    setModelDraft(profile?.model ?? '')
    setError('')
    setNotice('')
    setMoveOffer(null)
    onChange({ ...preferences, profileIds: { ...preferences.profileIds, [provider]: profileId } })
  }

  function selectProvider(nextProvider: TranslationProvider) {
    setError('')
    setNotice('')
    setMoveOffer(isApiProtocol(provider) && isApiProtocol(nextProvider) && provider !== nextProvider && current && (current.configured || current.hasKey || current.baseUrl || current.model)
      ? { source: provider, target: nextProvider, profileId: current.id, name: current.name }
      : null)
    onChange({ ...preferences, provider: nextProvider })
  }

  function configDraft() {
    return {
      ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
      ...(provider === 'microsoft' ? { region: regionDraft } : {}),
      ...(provider === 'deepl' ? { plan: planDraft } : {}),
      ...(provider === 'chat' || provider === 'anthropic' || provider === 'responses' ? { baseUrl: baseUrlDraft } : {}),
      ...(provider === 'chat' || provider === 'anthropic' || provider === 'responses' || provider === 'codex' || provider === 'claude' ? { model: modelDraft } : {}),
    }
  }

  async function moveProfile(source: TranslationApiProtocol, profileId: string, target: TranslationApiProtocol, config: TranslationConfigInput = {}) {
    setBusyAction('move')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.moveTranslationProfile(token, source, profileId, target, config)
      const sourceFallback = response.config.providers[source].profiles[0]
      setConfiguration(response.config)
      setKeyDraft('')
      setMoveOffer(null)
      onChange({
        ...preferences,
        provider: target,
        profileIds: { ...preferences.profileIds, [source]: sourceFallback.id, [target]: response.profileId },
      })
      onConfigSaved()
      setNotice('配置协议已更改，地址、模型和已保存密钥已保留。请测试连通性。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更改配置协议。')
    } finally {
      setBusyAction(null)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current) return
    setBusyAction('save')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.updateTranslationProfile(token, provider, current.id, { name: nameDraft, ...configDraft() })
      setConfiguration(response)
      setKeyDraft('')
      onConfigSaved()
      setNotice('翻译引擎设置已保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存翻译设置。')
    } finally {
      setBusyAction(null)
    }
  }

  async function checkConnection() {
    if (!current) return
    setBusyAction('check')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.checkTranslationProfile(token, provider, current.id, configDraft())
      setNotice(`连接成功，试译：${response.sample}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '翻译接口连通性检查失败。')
    } finally {
      setBusyAction(null)
    }
  }

  async function clearKey() {
    if (!current) return
    setBusyAction('clear')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.updateTranslationProfile(token, provider, current.id, { clearKey: true })
      setConfiguration(response)
      setKeyDraft('')
      onConfigSaved()
      setNotice('接口密钥已清除。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法清除接口密钥。')
    } finally {
      setBusyAction(null)
    }
  }

  async function createProfile(copyCurrent: boolean) {
    setBusyAction(copyCurrent ? 'copy' : 'create')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.createTranslationProfile(token, provider, copyCurrent ? current?.id : undefined)
      setConfiguration(response.config)
      onChange({ ...preferences, profileIds: { ...preferences.profileIds, [provider]: response.profileId } })
      onConfigSaved()
      setNotice(copyCurrent ? '已复制配置，可修改名称和参数后保存。' : '已新建空配置，请填写并保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法新建翻译配置。')
    } finally {
      setBusyAction(null)
    }
  }

  async function deleteProfile() {
    if (!current || profiles.length <= 1 || !window.confirm(`删除“${current.name}”？此操作无法恢复。`)) return
    setBusyAction('delete')
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.deleteTranslationProfile(token, provider, current.id)
      setConfiguration(response)
      const nextProfile = response.providers[provider].profiles[0]
      onChange({ ...preferences, profileIds: { ...preferences.profileIds, [provider]: nextProfile.id } })
      onConfigSaved()
      setNotice('配置已删除。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除翻译配置。')
    } finally {
      setBusyAction(null)
    }
  }

  const needsKey = provider !== 'codex' && provider !== 'claude'
  return <details className="theme-settings-card theme-settings-card--collapsible" open={readSettingsSectionOpen('translation', false)} onToggle={(event) => saveSettingsSectionOpen('translation', event.currentTarget.open)}>
    <summary className="theme-settings-card__heading theme-settings-card__summary">
      <div><h2><Languages size={17} aria-hidden="true" />聊天翻译</h2><p>中文草稿预览英文，发送英文；聊天可切换原文和译文。</p></div>
      <span className="theme-settings-card__summary-actions"><ChevronDown className="theme-settings-card__chevron" size={18} aria-hidden="true" /></span>
    </summary>
    <div className="translation-settings">
      <div className="translation-settings__option">
        <label className="translation-settings__switch"><input type="checkbox" aria-describedby={sendHintId} checked={preferences.enabled} disabled={busyAction !== null} onChange={(event) => onChange({ ...preferences, enabled: event.currentTarget.checked })} /><span>启用聊天翻译</span></label>
        <p id={sendHintId} className="translation-settings__hint">输入中文时预览英文，发送给 AI 的是英文；输入英文则原样发送。</p>
      </div>
      <div className="translation-settings__option">
        <label className="translation-settings__switch"><input type="checkbox" aria-describedby={displayHintId} checked={preferences.showTranslated} disabled={!preferences.enabled || busyAction !== null} onChange={(event) => onChange({ ...preferences, showTranslated: event.currentTarget.checked })} /><span>聊天消息优先显示译文</span></label>
        <p id={displayHintId} className="translation-settings__hint">开启后，你的消息显示发送的英文，AI 回复显示中文；关闭后优先显示原文。</p>
      </div>
      <label className="translation-settings__field"><span>翻译引擎（选择已有配置）</span><select value={provider} disabled={busyAction !== null} onChange={(event) => selectProvider(event.currentTarget.value as TranslationProvider)}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      <label className="translation-settings__field"><span>英文表达</span><select value={preferences.style} disabled={busyAction !== null} onChange={(event) => onChange({ ...preferences, style: event.currentTarget.value === 'formal' ? 'formal' : 'natural' })}><option value="natural">自然美式英语</option><option value="formal">正式美式英语</option></select></label>
      <p className="translation-settings__hint">{provider === 'codex' || provider === 'claude' || provider === 'chat' || provider === 'anthropic' || provider === 'responses'
        ? 'AI 翻译会遵循美式表达指令；Codex 和 Claude Code 的预览速度取决于模型。'
        : '官方翻译 API 速度通常较快，但不能保证按指定语气改写。输入预览会延迟更新并复用相同译文。'}</p>
      <form className="translation-settings__config" onSubmit={(event) => void save(event)}>
        <strong>{choices.find((choice) => choice.value === provider)?.label} · {current?.configured ? '已配置' : '待配置'}</strong>
        {moveOffer?.target === provider ? <div className="translation-settings__transfer">
          <p className="translation-settings__hint">刚才使用的是“{moveOffer.name}”。要将它改为当前协议并保留地址、模型和密钥吗？</p>
          <div className="translation-settings__actions"><button type="button" disabled={busyAction !== null} onClick={() => void moveProfile(moveOffer.source, moveOffer.profileId, moveOffer.target)}>{busyAction === 'move' ? <LoaderCircle className="spin" size={14} /> : null}沿用刚才的配置</button><button type="button" disabled={busyAction !== null} onClick={() => setMoveOffer(null)}>使用当前协议已有配置</button></div>
        </div> : null}
        <label className="translation-settings__field">
          <span>使用的配置</span>
          <select value={selectedId ?? current?.id ?? ''} disabled={!configuration || busyAction !== null} onChange={(event) => selectProfile(event.currentTarget.value)}>
            {!configuration ? <option value={selectedId ?? ''}>正在读取配置…</option> : null}
            {missingSelection ? <option value={selectedId}>原配置已删除，请重新选择</option> : null}
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.configured ? '' : ' · 待配置'}</option>)}
          </select>
        </label>
        <div className="translation-settings__actions">
          <button type="button" disabled={!configuration || profiles.length >= 30 || busyAction !== null} onClick={() => void createProfile(false)}>{busyAction === 'create' ? <LoaderCircle className="spin" size={14} /> : null}新建配置</button>
          <button type="button" disabled={!current || profiles.length >= 30 || busyAction !== null} onClick={() => void createProfile(true)}>{busyAction === 'copy' ? <LoaderCircle className="spin" size={14} /> : null}复制当前</button>
          <button type="button" disabled={!current || profiles.length <= 1 || busyAction !== null} onClick={() => void deleteProfile()}>{busyAction === 'delete' ? <LoaderCircle className="spin" size={14} /> : null}删除当前</button>
        </div>
        {missingSelection ? <p role="alert" className="translation-settings__error">原来选用的配置已删除。请在上方重新选择；发送翻译前不会自动改用其他接口。</p> : null}
        <label className="translation-settings__field"><span>配置名称</span><input value={nameDraft} maxLength={60} required disabled={!current || busyAction !== null} onChange={(event) => setNameDraft(event.currentTarget.value)} placeholder="例如工作接口" /></label>
        {needsKey ? <label className="translation-settings__field"><span>接口密钥 {current?.hasKey ? '（已保存，留空不修改）' : ''}</span><input type="password" autoComplete="off" disabled={!current || busyAction !== null} value={keyDraft} onChange={(event) => setKeyDraft(event.currentTarget.value)} placeholder={current?.hasKey ? '已保存密钥' : '填写接口密钥'} /></label> : null}
        {provider === 'microsoft' ? <label className="translation-settings__field"><span>资源区域（按 Azure 资源填写）</span><input disabled={!current || busyAction !== null} value={regionDraft} onChange={(event) => setRegionDraft(event.currentTarget.value)} placeholder="例如 eastus" /></label> : null}
        {provider === 'deepl' ? <label className="translation-settings__field"><span>账户类型</span><select disabled={!current || busyAction !== null} value={planDraft} onChange={(event) => setPlanDraft(event.currentTarget.value)}><option value="free">API Free</option><option value="pro">API Pro</option></select></label> : null}
        {provider === 'chat' || provider === 'anthropic' || provider === 'responses' ? <><label className="translation-settings__field"><span>{provider === 'anthropic' ? '接口地址（留空使用 Anthropic 官方地址）' : provider === 'responses' ? '接口地址（留空使用 OpenAI 官方地址）' : '接口地址'}</span><input type="url" disabled={!current || busyAction !== null} value={baseUrlDraft} onChange={(event) => setBaseUrlDraft(event.currentTarget.value)} placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'responses' ? 'https://api.openai.com/v1' : 'https://example.com/v1'} /></label><label className="translation-settings__field"><span>模型名称</span><input disabled={!current || busyAction !== null} value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder="输入接口支持的模型 ID" /></label></> : null}
        {provider === 'responses' ? <p className="translation-settings__hint">第三方接口需开启 Responses 路由；地址支持 API 根地址、/v1 或完整 /responses 地址。</p> : null}
        {provider === 'codex' || provider === 'claude' ? <label className="translation-settings__field"><span>模型名称（留空使用默认模型）</span><input disabled={!current || busyAction !== null} value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder="默认模型" /></label> : null}
        {isApiProtocol(provider) && current ? <div className="translation-settings__transfer">
          <label className="translation-settings__field"><span>更改当前配置的协议</span><select value={selectedProtocolTarget} disabled={busyAction !== null} onChange={(event) => setProtocolTarget(event.currentTarget.value as TranslationApiProtocol)}>{protocolChoices.filter((choice) => choice.value !== provider).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
          <div className="translation-settings__actions"><button type="button" disabled={busyAction !== null || (configuration?.providers[selectedProtocolTarget]?.profiles.length ?? 0) >= 30} onClick={() => void moveProfile(provider, current.id, selectedProtocolTarget, { name: nameDraft, ...configDraft() })}>{busyAction === 'move' ? <LoaderCircle className="spin" size={14} /> : null}更改协议并保留配置</button></div>
          <p className="translation-settings__hint">会把这套配置移到新协议；已保存的密钥无需重新输入。不同接口可能仍需修改模型或地址。</p>
        </div> : null}
        <div className="translation-settings__actions"><button type="submit" disabled={!current || busyAction !== null}>{busyAction === 'save' ? <LoaderCircle className="spin" size={14} /> : null}保存配置</button><button type="button" disabled={!current || busyAction !== null} onClick={() => void checkConnection()}>{busyAction === 'check' ? <LoaderCircle className="spin" size={14} /> : null}测试连通性</button>{needsKey && current?.hasKey ? <button type="button" disabled={busyAction !== null} onClick={() => void clearKey()}>{busyAction === 'clear' ? <LoaderCircle className="spin" size={14} /> : null}清除密钥</button> : null}</div>
        <p className="translation-settings__hint">切换后立即使用所选配置；未保存的修改不会带到其他配置。测试会试译一句，不会保存修改。</p>
        {error ? <p role="alert" className="translation-settings__error">{error}</p> : null}
        {notice ? <p role="status" className="translation-settings__hint">{notice}</p> : null}
      </form>
    </div>
  </details>
}
