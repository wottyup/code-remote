import { ui, uiFormat, uiMessage, useUiLanguage } from '../lib/uiLanguage'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Languages, LoaderCircle } from 'lucide-react'
import { devwispClient, type TranslationApiProtocol, type TranslationConfigInput, type TranslationConfigResponse, type TranslationProvider } from '../lib/devwispClient'
import type { TranslationPreferences } from '../lib/translationPreferences'
import { TranslationSelect } from './TranslationSelect'

const choices: Array<{ value: TranslationProvider; label: string }> = [
  { value: 'microsoft', label: 'Microsoft Translator' },
  { value: 'google', label: 'Google Cloud Translation' },
  { value: 'deepl', label: 'DeepL API' },
  { value: 'chat', get label() { return ui('兼容 Chat Completions 的接口') } },
  { value: 'responses', get label() { return ui('OpenAI Responses API（需开启路由）') } },
  { value: 'anthropic', get label() { return ui('Anthropic Messages 原生接口') } },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]

const protocolChoices: Array<{ value: TranslationApiProtocol; label: string }> = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

const styleChoices = [
  { value: 'natural', get label() { return ui('自然美式英语') } },
  { value: 'formal', get label() { return ui('正式美式英语') } },
]

const planChoices = [
  { value: 'free', label: 'API Free' },
  { value: 'pro', label: 'API Pro' },
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
  useUiLanguage()
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
  const profileChoices = [
    ...(!configuration ? [{ value: selectedId ?? '', label: ui('正在读取配置…') }] : []),
    ...(missingSelection && selectedId ? [{ value: selectedId, label: ui('原配置已删除，请重新选择') }] : []),
    ...profiles.map((profile) => ({ value: profile.id, label: `${profile.name}${profile.configured ? '' : ui(' · 待配置')}` })),
  ]

  useEffect(() => {
    let cancelled = false
    void devwispClient.translationConfig(token).then((response) => {
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
      const response = await devwispClient.moveTranslationProfile(token, source, profileId, target, config)
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
      const response = await devwispClient.updateTranslationProfile(token, provider, current.id, { name: nameDraft, ...configDraft() })
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
      const response = await devwispClient.checkTranslationProfile(token, provider, current.id, configDraft())
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
      const response = await devwispClient.updateTranslationProfile(token, provider, current.id, { clearKey: true })
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
      const response = await devwispClient.createTranslationProfile(token, provider, copyCurrent ? current?.id : undefined)
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
    if (!current || profiles.length <= 1 || !window.confirm(uiFormat('删除“{0}”？此操作无法恢复。', current.name))) return
    setBusyAction('delete')
    setError('')
    setNotice('')
    try {
      const response = await devwispClient.deleteTranslationProfile(token, provider, current.id)
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
  return <section className="theme-settings-card theme-settings-card--page" aria-label={ui("聊天翻译")}>
    <div className="theme-settings-card__heading">
      <div><h2><Languages size={17} aria-hidden="true" />{ui("聊天翻译")}</h2><p>{ui("中文草稿预览英文，发送英文；聊天可切换原文和译文。")}</p></div>
    </div>
    <div className="translation-settings">
      <section className="translation-settings__group" aria-label={ui("翻译行为")}>
        <h3>{ui("翻译行为")}</h3>
        <div className="translation-settings__option">
          <label className="translation-settings__switch"><input type="checkbox" aria-describedby={sendHintId} checked={preferences.enabled} disabled={busyAction !== null} onChange={(event) => onChange({ ...preferences, enabled: event.currentTarget.checked })} /><span>{ui("启用聊天翻译")}</span></label>
          <p id={sendHintId} className="translation-settings__hint">{ui("输入中文时预览英文，发送给 AI 的是英文；输入英文则原样发送。")}</p>
        </div>
        <div className="translation-settings__option">
          <label className="translation-settings__switch"><input type="checkbox" aria-describedby={displayHintId} checked={preferences.showTranslated} disabled={!preferences.enabled || busyAction !== null} onChange={(event) => onChange({ ...preferences, showTranslated: event.currentTarget.checked })} /><span>{ui("聊天消息优先显示译文")}</span></label>
          <p id={displayHintId} className="translation-settings__hint">{ui("开启后，你的消息显示发送的英文，AI 回复显示中文；关闭后优先显示原文。")}</p>
        </div>
      </section>
      <section className="translation-settings__group" aria-label={ui("翻译方式")}>
        <h3>{ui("翻译方式")}</h3>
        <TranslationSelect label={ui("英文表达")} value={preferences.style} options={styleChoices} disabled={busyAction !== null} onChange={(next) => onChange({ ...preferences, style: next === 'formal' ? 'formal' : 'natural' })} />
      </section>
      <form className="translation-settings__config" onSubmit={(event) => void save(event)}>
        <div className="translation-settings__config-heading"><h3>{ui("接口配置")}</h3><span>{choices.find((choice) => choice.value === provider)?.label} · {current?.configured ? ui('已配置') : ui('待配置')}</span></div>
        <TranslationSelect label={ui("翻译引擎（选择已有配置）")} value={provider} options={choices} disabled={busyAction !== null} onChange={(next) => selectProvider(next as TranslationProvider)} />
        {moveOffer?.target === provider ? <div className="translation-settings__transfer">
          <p className="translation-settings__hint">{ui("刚才使用的是“")}{moveOffer.name}{ui("”。要将它改为当前协议并保留地址、模型和密钥吗？")}</p>
          <div className="translation-settings__actions"><button type="button" disabled={busyAction !== null} onClick={() => void moveProfile(moveOffer.source, moveOffer.profileId, moveOffer.target)}>{busyAction === 'move' ? <LoaderCircle className="spin" size={14} /> : null}{ui("沿用刚才的配置")}</button><button type="button" disabled={busyAction !== null} onClick={() => setMoveOffer(null)}>{ui("使用当前协议已有配置")}</button></div>
        </div> : null}
        <TranslationSelect label={ui("使用的配置")} value={selectedId ?? current?.id ?? ''} options={profileChoices} disabled={!configuration || busyAction !== null} onChange={selectProfile} />
        <div className="translation-settings__actions">
          <button type="button" disabled={!configuration || profiles.length >= 30 || busyAction !== null} onClick={() => void createProfile(false)}>{busyAction === 'create' ? <LoaderCircle className="spin" size={14} /> : null}{ui("新建配置")}</button>
          <button type="button" disabled={!current || profiles.length >= 30 || busyAction !== null} onClick={() => void createProfile(true)}>{busyAction === 'copy' ? <LoaderCircle className="spin" size={14} /> : null}{ui("复制当前")}</button>
          <button type="button" disabled={!current || profiles.length <= 1 || busyAction !== null} onClick={() => void deleteProfile()}>{busyAction === 'delete' ? <LoaderCircle className="spin" size={14} /> : null}{ui("删除当前")}</button>
        </div>
        <p className="translation-settings__hint">{provider === 'codex' || provider === 'claude' || provider === 'chat' || provider === 'anthropic' || provider === 'responses'
          ? ui('AI 翻译会遵循美式表达指令；Codex 和 Claude Code 的预览速度取决于模型。')
          : ui('官方翻译 API 速度通常较快，但不能保证按指定语气改写。输入预览会延迟更新并复用相同译文。')}</p>
        {missingSelection ? <p role="alert" className="translation-settings__error">{ui("原来选用的配置已删除。请在上方重新选择；发送翻译前不会自动改用其他接口。")}</p> : null}
        <label className="translation-settings__field"><span>{ui("配置名称")}</span><input value={nameDraft} maxLength={60} required disabled={!current || busyAction !== null} onChange={(event) => setNameDraft(event.currentTarget.value)} placeholder={ui("例如工作接口")} /></label>
        {needsKey ? <label className="translation-settings__field"><span>{ui("接口密钥")} {current?.hasKey ? ui('（已保存，留空不修改）') : ''}</span><input type="password" autoComplete="off" disabled={!current || busyAction !== null} value={keyDraft} onChange={(event) => setKeyDraft(event.currentTarget.value)} placeholder={current?.hasKey ? ui('已保存密钥') : ui('填写接口密钥')} /></label> : null}
        {provider === 'microsoft' ? <label className="translation-settings__field"><span>{ui("资源区域（按 Azure 资源填写）")}</span><input disabled={!current || busyAction !== null} value={regionDraft} onChange={(event) => setRegionDraft(event.currentTarget.value)} placeholder={ui("例如 eastus")} /></label> : null}
        {provider === 'deepl' ? <TranslationSelect label={ui("账户类型")} value={planDraft} options={planChoices} disabled={!current || busyAction !== null} onChange={setPlanDraft} /> : null}
        {provider === 'chat' || provider === 'anthropic' || provider === 'responses' ? <><label className="translation-settings__field"><span>{provider === 'anthropic' ? ui('接口地址（留空使用 Anthropic 官方地址）') : provider === 'responses' ? ui('接口地址（留空使用 OpenAI 官方地址）') : ui('接口地址')}</span><input type="url" disabled={!current || busyAction !== null} value={baseUrlDraft} onChange={(event) => setBaseUrlDraft(event.currentTarget.value)} placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'responses' ? 'https://api.openai.com/v1' : 'https://example.com/v1'} /></label><label className="translation-settings__field"><span>{ui("模型名称")}</span><input disabled={!current || busyAction !== null} value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder={ui("输入接口支持的模型 ID")} /></label></> : null}
        {provider === 'responses' ? <p className="translation-settings__hint">{ui("第三方接口需开启 Responses 路由；地址支持 API 根地址、/v1 或完整 /responses 地址。")}</p> : null}
        {provider === 'chat' ? <p className="translation-settings__hint">{ui("地址支持 API 根地址、/v1 或完整 /chat/completions 地址；根地址会优先使用 /v1 路由。")}</p> : null}
        {provider === 'codex' || provider === 'claude' ? <label className="translation-settings__field"><span>{ui("模型名称（留空使用默认模型）")}</span><input disabled={!current || busyAction !== null} value={modelDraft} onChange={(event) => setModelDraft(event.currentTarget.value)} placeholder={ui("默认模型")} /></label> : null}
        {isApiProtocol(provider) && current ? <div className="translation-settings__transfer">
          <TranslationSelect label={ui("更改当前配置的协议")} value={selectedProtocolTarget} options={protocolChoices.filter((choice) => choice.value !== provider)} disabled={busyAction !== null} onChange={(next) => setProtocolTarget(next as TranslationApiProtocol)} />
          <div className="translation-settings__actions"><button type="button" disabled={busyAction !== null || (configuration?.providers[selectedProtocolTarget]?.profiles.length ?? 0) >= 30} onClick={() => void moveProfile(provider, current.id, selectedProtocolTarget, { name: nameDraft, ...configDraft() })}>{busyAction === 'move' ? <LoaderCircle className="spin" size={14} /> : null}{ui("更改协议并保留配置")}</button></div>
          <p className="translation-settings__hint">{ui("会把这套配置移到新协议；已保存的密钥无需重新输入。不同接口可能仍需修改模型或地址。")}</p>
        </div> : null}
        <div className="translation-settings__actions"><button type="submit" disabled={!current || busyAction !== null}>{busyAction === 'save' ? <LoaderCircle className="spin" size={14} /> : null}{ui("保存配置")}</button><button type="button" disabled={!current || busyAction !== null} onClick={() => void checkConnection()}>{busyAction === 'check' ? <LoaderCircle className="spin" size={14} /> : null}{ui("测试连通性")}</button>{needsKey && current?.hasKey ? <button type="button" disabled={busyAction !== null} onClick={() => void clearKey()}>{busyAction === 'clear' ? <LoaderCircle className="spin" size={14} /> : null}{ui("清除密钥")}</button> : null}</div>
        <p className="translation-settings__hint">{ui("切换后立即使用所选配置；未保存的修改不会带到其他配置。测试会试译一句，不会保存修改。")}</p>
        {error ? <p role="alert" className="translation-settings__error">{uiMessage(error)}</p> : null}
        {notice ? <p role="status" className="translation-settings__hint">{uiMessage(notice)}</p> : null}
      </form>
    </div>
  </section>
}
