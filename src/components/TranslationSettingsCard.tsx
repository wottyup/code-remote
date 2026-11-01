import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, Languages, LoaderCircle } from 'lucide-react'
import { codexRemoteClient, type TranslationConfigResponse, type TranslationProvider } from '../lib/codexRemoteClient'
import { readSettingsSectionOpen, saveSettingsSectionOpen } from '../lib/settingsSectionState'
import type { TranslationPreferences } from '../lib/translationPreferences'

const choices: Array<{ value: TranslationProvider; label: string }> = [
  { value: 'microsoft', label: 'Microsoft Translator' },
  { value: 'google', label: 'Google Cloud Translation' },
  { value: 'deepl', label: 'DeepL API' },
  { value: 'chat', label: '兼容 Chat Completions 的接口' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]

export function TranslationSettingsCard({ token, preferences, onChange, onConfigSaved }: {
  token: string
  preferences: TranslationPreferences
  onChange: (next: TranslationPreferences) => void
  onConfigSaved: () => void
}) {
  const [configuration, setConfiguration] = useState<TranslationConfigResponse | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [regionDraft, setRegionDraft] = useState('')
  const [planDraft, setPlanDraft] = useState('free')
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [modelDraft, setModelDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const provider = preferences.provider
  const current = configuration?.providers[provider]

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
    setKeyDraft('')
    setRegionDraft(current?.region ?? '')
    setPlanDraft(current?.plan ?? 'free')
    setBaseUrlDraft(current?.baseUrl ?? '')
    setModelDraft(current?.model ?? '')
    setError('')
    setNotice('')
  }, [provider, current?.region, current?.plan, current?.baseUrl, current?.model])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.saveTranslationConfig(token, provider, {
        ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
        ...(provider === 'microsoft' ? { region: regionDraft } : {}),
        ...(provider === 'deepl' ? { plan: planDraft } : {}),
        ...(provider === 'chat' ? { baseUrl: baseUrlDraft } : {}),
        ...(provider === 'chat' || provider === 'codex' || provider === 'claude' ? { model: modelDraft } : {}),
      })
      setConfiguration(response)
      setKeyDraft('')
      onConfigSaved()
      setNotice('翻译引擎设置已保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存翻译设置。')
    } finally {
      setBusy(false)
    }
  }

  async function clearKey() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await codexRemoteClient.saveTranslationConfig(token, provider, { clearKey: true })
      setConfiguration(response)
      setKeyDraft('')
      onConfigSaved()
      setNotice('接口密钥已清除。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法清除接口密钥。')
    } finally {
      setBusy(false)
    }
  }

  const needsKey = provider !== 'codex' && provider !== 'claude'
  return <details className="theme-settings-card theme-settings-card--collapsible" open={readSettingsSectionOpen('translation', false)} onToggle={(event) => saveSettingsSectionOpen('translation', event.currentTarget.open)}>
    <summary className="theme-settings-card__heading theme-settings-card__summary">
      <div><h2><Languages size={17} aria-hidden="true" />聊天翻译</h2><p>中文草稿预览英文，发送英文；英文回复显示中文译文。</p></div>
      <span className="theme-settings-card__summary-actions"><ChevronDown className="theme-settings-card__chevron" size={18} aria-hidden="true" /></span>
    </summary>
    <div className="translation-settings">
      <label className="translation-settings__switch"><input type="checkbox" checked={preferences.enabled} onChange={(event) => onChange({ ...preferences, enabled: event.currentTarget.checked })} /><span>启用聊天翻译</span></label>
      <label className="translation-settings__field"><span>翻译引擎</span><select value={provider} onChange={(event) => onChange({ ...preferences, provider: event.currentTarget.value as TranslationProvider })}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      <label className="translation-settings__field"><span>英文表达</span><select value={preferences.style} onChange={(event) => onChange({ ...preferences, style: event.currentTarget.value === 'formal' ? 'formal' : 'natural' })}><option value="natural">自然美式英语</option><option value="formal">正式美式英语</option></select></label>
      <p className="translation-settings__hint">{provider === 'codex' || provider === 'claude' || provider === 'chat'
        ? 'AI 翻译会遵循美式表达指令；Codex 和 Claude Code 的预览速度取决于模型。'
        : '官方翻译 API 速度通常较快，但不能保证按指定语气改写。输入预览会延迟更新并复用相同译文。'}</p>
      <form className="translation-settings__config" onSubmit={(event) => void save(event)}>
        <strong>{choices.find((choice) => choice.value === provider)?.label} 配置 {current?.configured ? '· 已就绪' : '· 未就绪'}</strong>
        {needsKey ? <label className="translation-settings__field"><span>接口密钥 {current?.hasKey ? '（已保存，留空不修改）' : ''}</span><input type="password" autoComplete="off" value={keyDraft} onChange={(event) => setKeyDraft(event.currentTarget.value)} placeholder={current?.hasKey ? '已保存密钥' : '填写接口密钥'} /></label> : null}
        {provider === 'microsoft' ? <label className="translation-settings__field"><span>资源区域（按 Azure 资源填写）</span><input value={regionDraft} onChange={(event) => setRegionDraft(event.currentTarget.value)} placeholder="例如 eastus" /></label> : null}
        {provider === 'deepl' ? <label className="translation-settings__field"><span>账户类型</span><select value={planDraft} onChange={(event) => setPlanDraft(event.currentTarget.value)}><option value="free">API Free</option><option value="pro">API Pro</option></select></label> : null}
        {provider === 'chat' ? <><label className="translation-settings__field"><span>接口地址</span><input type="url" value={baseUrlDraft} onChange={(event) => setBaseUrlDraft(event.currentTarget.value)} placeholder="https://example.com/v1" /></label><label className="translation-settings__field"><span>模型名称</span><input value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder="输入接口支持的模型 ID" /></label></> : null}
        {provider === 'codex' || provider === 'claude' ? <label className="translation-settings__field"><span>模型名称（留空使用默认模型）</span><input value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder="默认模型" /></label> : null}
        <div className="translation-settings__actions"><button type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : null}保存配置</button>{needsKey && current?.hasKey ? <button type="button" disabled={busy} onClick={() => void clearKey()}>清除密钥</button> : null}</div>
        {error ? <p role="alert" className="translation-settings__error">{error}</p> : null}
        {notice ? <p role="status" className="translation-settings__hint">{notice}</p> : null}
      </form>
    </div>
  </details>
}
